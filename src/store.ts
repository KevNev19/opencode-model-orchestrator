import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { type Task, taskSchema } from "./types.js";

const eventSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  action: z.string(),
  task: taskSchema,
});
type JournalEvent = z.infer<typeof eventSchema>;
const ownerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  token: z.string().uuid(),
});
const LOCK_TIMEOUT_MS = 1000;
const LOCK_RETRY_MS = 10;
const MAX_RECOVERY_DEPTH = 32;
const lockWait = new Int32Array(new SharedArrayBuffer(4));

/** A locked append-only journal; malformed or partial records fail closed. */
export class Store {
  readonly root: string;
  readonly directory: string;
  constructor(root: string) {
    this.root = realpathSync(root);
    this.directory = join(this.root, ".orchestrator");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink())
      throw new Error("Run storage must not be a symlink");
  }

  /** Runs a synchronous journal transaction with bounded cross-process lock waiting. */
  transaction<T>(
    work: (
      tasks: Map<string, Task>,
      save: (task: Task, action: string) => void,
      events: readonly JournalEvent[],
    ) => T,
  ): T {
    const release = this.lock();
    try {
      const path = join(this.directory, "journal.jsonl");
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error("Journal must not be a symlink");
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      if (text && !text.endsWith("\n"))
        throw new Error(
          "Incomplete journal record; preserve the journal and inspect it before recovery",
        );
      const tasks = new Map<string, Task>();
      const events: JournalEvent[] = [];
      let sequence = 0;
      for (const line of text.split("\n").filter(Boolean)) {
        const event = eventSchema.parse(JSON.parse(line));
        if (event.sequence !== ++sequence) throw new Error("Journal sequence is corrupt");
        tasks.set(event.task.id, event.task);
        events.push(event);
      }
      return work(
        tasks,
        (task, action) => {
          const event = eventSchema.parse({ version: 1, sequence: sequence + 1, action, task });
          const fd = openSync(path, "a", 0o600);
          try {
            appendFileSync(fd, `${JSON.stringify(event)}\n`);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          sequence++;
          tasks.set(task.id, task);
          events.push(event);
        },
        events,
      );
    } finally {
      release();
    }
  }

  /** Returns the latest state of every assignment from a validated journal snapshot. */
  list(): Task[] {
    return this.transaction((tasks) => [...tasks.values()]);
  }

  /** Reads current assignments and execution history under one journal lock. */
  snapshot(): { tasks: Task[]; events: readonly JournalEvent[] } {
    return this.transaction((tasks, _save, events) => ({ tasks: [...tasks.values()], events }));
  }

  private lock(): () => void {
    const owner = join(this.directory, `owner-${randomUUID()}`);
    const lock = join(this.directory, "transaction.lock");
    writeFileSync(
      owner,
      JSON.stringify({ pid: process.pid, host: hostname(), token: randomUUID() }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    try {
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      while (true) {
        try {
          linkSync(owner, lock);
          break;
        } catch (error) {
          if (!isCode(error, "EEXIST")) throw error;
          if (Date.now() >= deadline) throw new Error("Store is busy; retry the operation");
          this.recoverDeadLock(lock, owner);
          // Transactions never await; only another process can release a live lock here.
          Atomics.wait(lockWait, 0, 0, LOCK_RETRY_MS);
        }
      }
    } finally {
      unlinkSync(owner);
    }
    return () => unlinkSync(lock);
  }

  private recoverDeadLock(lock: string, candidate: string, depth = 0): void {
    if (depth >= MAX_RECOVERY_DEPTH) throw new Error("Too many interrupted lock recoveries");
    const owner = this.readOwner(lock);
    if (!owner) return;
    if (owner.host !== hostname()) throw new Error("Store locked by another host");
    try {
      process.kill(owner.pid, 0);
      return;
    } catch (error) {
      if (isCode(error, "EPERM")) return;
      if (!isCode(error, "ESRCH")) throw error;
    }
    // Each dead generation has its own recoverable guard. A crash while recovering
    // a guard can itself be recovered without removing a newer transaction lock.
    const recovery = join(this.directory, `recovery-${owner.token}.lock`);
    try {
      linkSync(candidate, recovery);
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
      this.recoverDeadLock(recovery, candidate, depth + 1);
      return;
    }
    try {
      if (this.readOwner(lock)?.token === owner.token) unlinkSync(lock);
    } finally {
      unlinkSync(recovery);
    }
  }

  private readOwner(path: string): z.infer<typeof ownerSchema> | undefined {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error("Lock must not be a symlink");
      return ownerSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
  }
}

/** Narrows a filesystem or process error to its operating-system error code. */
export function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
