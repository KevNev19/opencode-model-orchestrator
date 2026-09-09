import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { type OrchestratorConfig, selectModel } from "./config.js";
import { Store } from "./store.js";
import {
  type Assignment,
  activeStatuses,
  assignmentSchema,
  type Executor,
  type Task,
  type WorkerResult,
} from "./types.js";
import { launchVerification, verificationResult, verifierStopped } from "./verification.js";
import { fingerprint, validateScopes } from "./workspace.js";

const MESSAGE_RANDOM_BYTES = 12;

/** Owns admission, execution records and acceptance; worker output is evidence only. */
export class Orchestrator {
  readonly store: Store;
  private readonly inFlight = new Set<string>();
  constructor(
    root: string,
    readonly config: OrchestratorConfig,
    private readonly executor: Executor,
  ) {
    this.store = new Store(root);
  }

  /** Lists assignments owned by a coordinator session. */
  list(parent: string): Task[] {
    return this.store.list().filter((task) => task.parent === parent);
  }
  /** Reads an assignment only when it belongs to the requesting coordinator. */
  get(parent: string, id: string): Task {
    const task = this.store.list().find((task) => task.id === id);
    if (!task || task.parent !== parent) throw new Error("Assignment ownership mismatch");
    return task;
  }

  /** Reserves and dispatches an assignment once per coordinator and stable key. */
  async delegate(
    parent: string,
    coordinator: string,
    input: Assignment,
    signal?: AbortSignal,
  ): Promise<Task> {
    const assignment = assignmentSchema.parse(input);
    assignment.files = validateScopes(this.store.root, assignment.files);
    this.validateChecks(assignment);
    const existing = this.list(parent).find((task) => task.key === assignment.key);
    if (existing) return this.sameAssignment(existing, assignment);
    const route = selectModel(
      this.config,
      assignment.role,
      coordinator,
      await this.executor.models(),
    );
    const reservation = this.store.transaction((tasks, save) => {
      const duplicate = [...tasks.values()].find(
        (task) => task.parent === parent && task.key === assignment.key,
      );
      if (duplicate) return { task: this.sameAssignment(duplicate, assignment), launch: false };
      this.admit([...tasks.values()], assignment.role === "implement");
      const now = Date.now();
      const task: Task = {
        ...assignment,
        id: randomUUID(),
        parent,
        coordinator,
        model: route.model,
        routeReason: route.reason,
        message: `msg_${randomBytes(MESSAGE_RANDOM_BYTES).toString("hex")}`,
        status: "reserved",
        created: now,
        updated: now,
        attempt: 1,
        revision: 1,
        prompt: "",
      };
      task.prompt = this.prompt(task);
      save(task, "reserved");
      this.inFlight.add(task.id);
      return { task, launch: true };
    });
    const { task } = reservation;
    if (!reservation.launch) return task;
    try {
      const session = await this.executor.create(task);
      const running = this.update(
        parent,
        task.id,
        (current) => ({ ...current, session, status: "running" }),
        "started",
        task,
      );
      if (running.status !== "running" || running.message !== task.message) return running;
      return await this.execute(running, signal);
    } catch (error) {
      return this.update(
        parent,
        task.id,
        (current) => ({ ...current, status: "interrupted", error: errorMessage(error) }),
        "interrupted",
        task,
      );
    } finally {
      this.inFlight.delete(task.id);
    }
  }

  /** Recovers owned work from native session state or durable verification evidence. */
  async reconcile(parent: string, id: string): Promise<Task> {
    const task = this.get(parent, id);
    if (this.inFlight.has(id))
      throw new Error("Assignment is still owned by an in-flight operation");
    if (!activeStatuses.has(task.status)) return task;
    if (task.status === "verifying") return this.recoverVerification(task);
    if (task.status === "cancelling" && !task.abortConfirmed)
      throw new Error("Cancellation request is unconfirmed; custody retained");
    const snapshot = await this.executor.inspect(task);
    if (snapshot.state === "missing")
      throw new Error("Cannot prove the child is stopped; custody retained");
    if (snapshot.parent !== parent) throw new Error("Child session ownership mismatch");
    if (snapshot.state === "busy") return task;
    const owned = { ...task, session: task.session ?? snapshot.session };
    if (task.status === "cancelling")
      return this.update(parent, id, () => ({ ...owned, status: "cancelled" }), "cancelled", task);
    if (snapshot.result) return this.finish(owned, snapshot.result);
    return this.update(
      parent,
      id,
      () => ({
        ...owned,
        status: "failed",
        error: "Owned child is idle without a complete handoff; inspect changes before retrying",
      }),
      "reconciled",
      task,
    );
  }

  /** Cancel only the recorded child; unconfirmed cancellation retains custody. */
  async cancel(parent: string, id: string): Promise<Task> {
    const task = this.get(parent, id);
    if (this.inFlight.has(id))
      throw new Error("Interrupt the foreground delegation first, then cancel the assignment");
    if (task.status === "verifying") return this.recoverVerification(task);
    if (!activeStatuses.has(task.status)) return task;
    if (task.status === "cancelling") return this.reconcile(parent, id);
    const claim = this.transition(
      parent,
      id,
      (current) => ({ ...current, status: "cancelling", abortConfirmed: false }),
      "cancellation_started",
      task,
    );
    if (!claim.applied) return claim.task;
    const cancelling = claim.task;
    await this.executor.abort(cancelling);
    const confirmed = this.update(
      parent,
      id,
      (current) => ({ ...current, abortConfirmed: true }),
      "abort_confirmed",
      cancelling,
    );
    const snapshot = await this.executor.inspect(confirmed);
    if (snapshot.state !== "idle" || snapshot.parent !== parent)
      throw new Error("Cancellation is unconfirmed; custody retained");
    return this.update(
      parent,
      id,
      (current) => ({
        ...current,
        session: current.session ?? snapshot.session,
        status: "cancelled",
        error: "Cancelled; existing edits were preserved",
      }),
      "cancelled",
      confirmed,
    );
  }

  /** Resumes the same confirmed idle child within the configured attempt limit. */
  async retry(parent: string, id: string, signal?: AbortSignal): Promise<Task> {
    const task = this.get(parent, id);
    if (task.status !== "failed" && task.status !== "cancelled")
      throw new Error("Reconcile or cancel the previous attempt before retrying");
    if (!task.session) throw new Error("Cannot resume an unidentified child");
    const snapshot = await this.executor.inspect(task);
    if (snapshot.state !== "idle" || snapshot.parent !== parent)
      throw new Error("Cannot confirm idle child ownership");
    const running = this.store.transaction((tasks, save) => {
      const current = tasks.get(id);
      if (!current || current.revision !== task.revision)
        throw new Error("Assignment changed; retry the operation");
      this.admit([...tasks.values()], task.role === "implement");
      if (task.attempt >= this.config.maxAttempts) throw new Error("Attempt limit reached");
      const next: Task = {
        ...task,
        attempt: task.attempt + 1,
        revision: task.revision + 1,
        message: `msg_${randomBytes(MESSAGE_RANDOM_BYTES).toString("hex")}`,
        status: "running",
        updated: Date.now(),
        verification: undefined,
        abortConfirmed: undefined,
        error: undefined,
      };
      next.prompt = `${task.prompt}\n\nResume this assignment. Inspect existing changes first; the previous attempt may have partially completed the work.`;
      save(next, "retry");
      return next;
    });
    this.inFlight.add(id);
    try {
      return await this.execute(running, signal);
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Run checks in an owned process; crashes retain enough identity for reconciliation. */
  async verify(parent: string, id: string): Promise<Task> {
    let task = this.store.transaction((tasks, save) => {
      const task = tasks.get(id);
      if (!task || task.parent !== parent) throw new Error("Assignment ownership mismatch");
      if (task.status !== "ready") throw new Error("Only a finished worker can be verified");
      if ([...tasks.values()].some((entry) => activeStatuses.has(entry.status)))
        throw new Error("Wait for active assignments before verification");
      const next: Task = {
        ...task,
        status: "verifying",
        verification: undefined,
        revision: task.revision + 1,
        verifier: { token: randomUUID(), ownerPid: process.pid, host: hostname() },
        updated: Date.now(),
      };
      save(next, "verification_started");
      return next;
    });
    try {
      await launchVerification(this.store.root, task, this.config, (pid) => {
        const previous = task;
        const verifier = previous.verifier;
        if (!verifier) throw new Error("Missing verifier identity");
        const claim = this.transition(
          parent,
          id,
          (current) => ({ ...current, verifier: { ...verifier, pid } }),
          "verifier_started",
          previous,
        );
        task = claim.task;
        if (!claim.applied) throw new Error("Verification custody changed before launch");
      });
      return this.recoverVerification(task);
    } catch (error) {
      if (task.verifier?.pid && !verifierStopped(task))
        return this.update(
          parent,
          id,
          (current) => ({ ...current, error: errorMessage(error) }),
          "verification_interrupted",
          task,
        );
      return this.update(
        parent,
        id,
        (current) => ({ ...current, status: "ready", error: errorMessage(error) }),
        "verification_failed",
        task,
      );
    }
  }

  private recoverVerification(task: Task): Task {
    if (!verifierStopped(task))
      throw new Error("Verification process is live or unknown; custody retained");
    const verification = verificationResult(this.store.root, task);
    return this.update(
      task.parent,
      task.id,
      (current) => ({
        ...current,
        status: "ready",
        verification,
        error: verification
          ? undefined
          : "Verifier stopped without evidence; run verification again",
      }),
      "verified",
      task,
    );
  }

  /** Records a coordinator verdict against passing, current workspace evidence. */
  accept(parent: string, id: string, verdict: string): Task {
    if (!verdict.trim()) throw new Error("Explain the evidence for accepting the criteria");
    return this.store.transaction((tasks, save) => {
      const task = tasks.get(id);
      if (!task || task.parent !== parent) throw new Error("Assignment ownership mismatch");
      if (task.status !== "ready" || !task.verification?.passed)
        throw new Error("Passing verification is required before acceptance");
      if ([...tasks.values()].some((entry) => activeStatuses.has(entry.status)))
        throw new Error("Active work prevents acceptance");
      if (
        fingerprint(this.store.root, [...task.files, ...this.config.verificationInputs]) !==
        task.verification.fingerprint
      )
        throw new Error("Workspace changed since verification; run checks again");
      const accepted: Task = {
        ...task,
        status: "accepted",
        verdict,
        updated: Date.now(),
        revision: task.revision + 1,
      };
      save(accepted, "accepted");
      return accepted;
    });
  }

  private async execute(task: Task, signal?: AbortSignal): Promise<Task> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      combined.throwIfAborted();
      const result = await Promise.race([
        this.executor.run(task, combined),
        new Promise<never>((_, reject) =>
          combined.addEventListener(
            "abort",
            () => reject(new Error("Worker interrupted or timed out; reconcile before retrying")),
            { once: true },
          ),
        ),
      ]);
      return this.finish(task, result);
    } catch (error) {
      return this.update(
        task.parent,
        task.id,
        (current) => ({ ...current, status: "interrupted", error: errorMessage(error) }),
        "interrupted",
        task,
      );
    }
  }

  private finish(task: Task, result: WorkerResult): Task {
    return this.update(
      task.parent,
      task.id,
      (current) => ({
        ...current,
        session: current.session ?? task.session,
        handoff: result.handoff,
        usage: result.usage,
        error: result.error || (!result.handoff.trim() ? "Missing handoff" : undefined),
        status: result.error || !result.handoff.trim() ? "failed" : "ready",
      }),
      "worker_finished",
      task,
    );
  }
  private update(
    parent: string,
    id: string,
    change: (task: Task) => Task,
    action: string,
    expected?: Task,
  ): Task {
    return this.transition(parent, id, change, action, expected).task;
  }
  private transition(
    parent: string,
    id: string,
    change: (task: Task) => Task,
    action: string,
    expected?: Task,
  ): { task: Task; applied: boolean } {
    return this.store.transaction((tasks, save) => {
      const task = tasks.get(id);
      if (!task || task.parent !== parent) throw new Error("Assignment ownership mismatch");
      if (expected && task.revision !== expected.revision) return { task, applied: false };
      const next = { ...change(task), updated: Date.now(), revision: task.revision + 1 };
      save(next, action);
      return { task: next, applied: true };
    });
  }
  private admit(tasks: Task[], writer: boolean): void {
    const active = tasks.filter((task) => activeStatuses.has(task.status));
    if (active.some((task) => task.status === "verifying"))
      throw new Error("Verification owns workspace custody");
    if (writer && active.some((task) => task.role === "implement"))
      throw new Error("Another writer retains workspace custody");
    if (active.length >= this.config.maxConcurrent) throw new Error("Worker capacity reached");
  }
  private validateChecks(assignment: Assignment): void {
    if (assignment.role === "implement" && assignment.checks.length === 0)
      throw new Error("Implementation needs at least one configured verification check");
    for (const check of assignment.checks)
      if (!this.config.checks[check]) throw new Error(`Unknown verification check: ${check}`);
  }
  private sameAssignment(task: Task, assignment: Assignment): Task {
    if (JSON.stringify(assignmentSchema.parse(task)) !== JSON.stringify(assignment))
      throw new Error("Idempotency key already belongs to a different assignment");
    return task;
  }
  private prompt(task: Task): string {
    return `Outcome:\n${task.outcome}\n\nDone when:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}\n\nBoundaries:\nWorkspace: ${this.store.root}\nRole: ${task.role}\nAllowed paths: ${task.files.join(", ")}\nNo commits, branches, worktrees, shell commands, nested delegation, or changes to orchestration configuration. Preserve unrelated work.\n\nRequired handoff:\nSummarize changes or findings, evidence for each criterion, and unresolved issues. Your handoff does not accept the assignment. The coordinator runs verification separately.`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
