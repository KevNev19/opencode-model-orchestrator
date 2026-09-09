import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configSchema } from "../src/config.js";
import { guardTool } from "../src/guard.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { Executor, Task, WorkerResult, WorkerSnapshot } from "../src/types.js";

const result: WorkerResult = {
  handoff: "Implemented the requested change.",
  usage: { input: 10, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
};
class FakeExecutor implements Executor {
  launches = 0;
  snapshot: WorkerSnapshot = { state: "idle", parent: "parent", result };
  fail = false;
  models = async () => [{ id: "test/coder", connected: true, tools: true }];
  create = async () => `child-${++this.launches}`;
  run = async (_task: Task, _signal: AbortSignal) => {
    if (this.fail) throw new Error("connection lost");
    return result;
  };
  inspect = async () => this.snapshot;
  abort = async () => {};
}
function fixture(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "code.ts"), "export const value = 1;\n");
  const config = configSchema.parse({
    routes: Object.fromEntries(
      ["explore", "implement", "review"].map((role) => [role, { models: ["test/coder"] }]),
    ),
    checks: { test: [process.execPath, "-e", "process.exit(0)"] },
  });
  const executor = new FakeExecutor();
  return { root, config, executor, orchestrator: new Orchestrator(root, config, executor) };
}
const assignment = {
  key: "change",
  role: "implement" as const,
  outcome: "Change the value",
  acceptance: ["Value is updated"],
  files: ["code.ts"],
  checks: ["test"],
};

test("duplicate dispatch returns the original task; worker completion still requires verification and acceptance", async (t) => {
  const { orchestrator, executor } = fixture(t);
  const first = await orchestrator.delegate("parent", "test/coder", assignment);
  const duplicate = await orchestrator.delegate("parent", "test/coder", assignment);
  assert.equal(first.id, duplicate.id);
  assert.equal(executor.launches, 1);
  assert.equal(first.status, "ready");
  assert.throws(() => orchestrator.accept("parent", first.id, "All criteria met"), /verification/i);
  await orchestrator.verify("parent", first.id);
  assert.equal(orchestrator.accept("parent", first.id, "All criteria met").status, "accepted");
});

test("changes to source after checks invalidate acceptance", async (t) => {
  const { orchestrator, root } = fixture(t);
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  await orchestrator.verify("parent", task.id);
  writeFileSync(join(root, "code.ts"), "export const value = 2;\n");
  assert.throws(() => orchestrator.accept("parent", task.id, "All criteria met"), /changed/i);
});

test("an ambiguous interruption holds custody across restart until the owned child is reconciled", async (t) => {
  const { orchestrator, executor, root, config } = fixture(t);
  executor.fail = true;
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  assert.equal(task.status, "interrupted");
  const restarted = new Orchestrator(root, config, executor);
  await assert.rejects(
    restarted.delegate("parent", "test/coder", { ...assignment, key: "other" }),
    /writer|custody/i,
  );
  executor.snapshot = { state: "busy", parent: "parent" };
  assert.equal((await restarted.reconcile("parent", task.id)).status, "interrupted");
  executor.snapshot = { state: "idle", parent: "foreign", result };
  await assert.rejects(restarted.reconcile("parent", task.id), /ownership/i);
  executor.snapshot = { state: "idle", parent: "parent", result };
  assert.equal((await restarted.reconcile("parent", task.id)).status, "ready");
  assert.equal(executor.launches, 1);
});

test("simultaneous duplicate requests launch exactly one worker", async (t) => {
  const { orchestrator, executor } = fixture(t);
  const tasks = await Promise.all([
    orchestrator.delegate("parent", "test/coder", assignment),
    orchestrator.delegate("parent", "test/coder", assignment),
  ]);
  assert.equal(tasks[0]?.id, tasks[1]?.id);
  assert.equal(executor.launches, 1);
  await assert.rejects(
    orchestrator.delegate("parent", "test/coder", { ...assignment, outcome: "Different work" }),
    /different assignment/,
  );
});

test("stale reconciliation cannot finish a newer running attempt", async (t) => {
  const { root, config, executor, orchestrator } = fixture(t);
  executor.fail = true;
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  let deliver: (snapshot: WorkerSnapshot) => void = () => {
    throw new Error("No pending snapshot");
  };
  const delayed = new FakeExecutor();
  delayed.inspect = () =>
    new Promise<WorkerSnapshot>((resolve) => {
      deliver = resolve;
    });
  const observer = new Orchestrator(root, config, delayed);
  const stale = observer.reconcile("parent", task.id);
  executor.snapshot = { state: "idle", parent: "parent" };
  assert.equal((await orchestrator.reconcile("parent", task.id)).status, "failed");
  let finish: (value: WorkerResult) => void = () => {
    throw new Error("No pending worker");
  };
  executor.run = () =>
    new Promise<WorkerResult>((resolve) => {
      finish = resolve;
    });
  const retry = orchestrator.retry("parent", task.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  deliver({ state: "idle", parent: "parent", result });
  assert.equal((await stale).status, "running");
  await assert.rejects(
    observer.delegate("parent", "test/coder", { ...assignment, key: "collision" }),
    /writer/,
  );
  finish(result);
  assert.equal((await retry).status, "ready");
});

test("worker guards reject shell, nested delegation, foreign paths and dangling symlinks", async (t) => {
  const { root, orchestrator, executor } = fixture(t);
  let finish: (value: WorkerResult) => void = () => {
    throw new Error("No pending worker");
  };
  executor.run = () =>
    new Promise<WorkerResult>((resolve) => {
      finish = resolve;
    });
  const pending = orchestrator.delegate("parent", "test/coder", { ...assignment, files: ["."] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const task = orchestrator.list("parent")[0];
  assert.ok(task?.session);
  assert.doesNotThrow(() =>
    guardTool(orchestrator.store, task.session ?? "", "write", { filePath: "code.ts" }),
  );
  for (const tool of ["bash", "task", "orchestrator_delegate", "custom_mcp_tool"])
    assert.throws(() => guardTool(orchestrator.store, task.session ?? "", tool, {}), /not allowed/);
  assert.throws(
    () => guardTool(orchestrator.store, "parent", "write", { filePath: "code.ts" }),
    /Managed/,
  );
  assert.throws(
    () => guardTool(orchestrator.store, "parent", "orchestrator_unrelated_mcp", {}),
    /Managed/,
  );
  assert.throws(
    () => guardTool(orchestrator.store, task.session ?? "", "write", { filePath: "../outside" }),
    /outside/,
  );
  symlinkSync(join(root, "..", "missing-external-target"), join(root, "dangling"));
  assert.throws(
    () => guardTool(orchestrator.store, task.session ?? "", "write", { filePath: "dangling" }),
    /Symlink/,
  );
  assert.throws(
    () =>
      guardTool(orchestrator.store, task.session ?? "", "apply_patch", {
        patchText:
          "*** Begin Patch\n*** Update File: code.ts\n*** Move to: ../outside\n*** End Patch",
      }),
    /outside/,
  );
  finish(result);
  await pending;
  assert.throws(
    () => guardTool(orchestrator.store, task.session ?? "", "write", { filePath: "code.ts" }),
    /custody/,
  );
});

test("failed checks and workspace changes during checks cannot be accepted", async (t) => {
  const { orchestrator, config } = fixture(t);
  config.checks.test = [process.execPath, "-e", "process.exit(1)"];
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  assert.equal((await orchestrator.verify("parent", task.id)).verification?.passed, false);
  assert.throws(() => orchestrator.accept("parent", task.id, "Looks fine"), /verification/);
  config.checks.test = [
    process.execPath,
    "-e",
    "require('node:fs').writeFileSync('code.ts', 'changed by test')",
  ];
  assert.equal((await orchestrator.verify("parent", task.id)).verification?.passed, false);
});

test("explicit assignment inputs are hashed even when ignored by git", async (t) => {
  const { root, orchestrator } = fixture(t);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, ".gitignore"), "code.ts\n.orchestrator/\n");
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  assert.equal((await orchestrator.verify("parent", task.id)).verification?.passed, true);
  writeFileSync(join(root, "code.ts"), "changed ignored source");
  assert.throws(() => orchestrator.accept("parent", task.id, "Passed"), /changed/);
});

test("incomplete durable records fail closed instead of forgetting writer custody", async (t) => {
  const { root, orchestrator, executor } = fixture(t);
  executor.fail = true;
  await orchestrator.delegate("parent", "test/coder", assignment);
  appendFileSync(join(root, ".orchestrator", "journal.jsonl"), '{"partial":');
  assert.throws(() => orchestrator.list("parent"), /Incomplete journal/);
});

test("bounded retries reuse the child session and refuse a third attempt", async (t) => {
  const { orchestrator, executor } = fixture(t);
  executor.fail = true;
  executor.snapshot = { state: "idle", parent: "parent" };
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  await orchestrator.reconcile("parent", task.id);
  assert.equal((await orchestrator.retry("parent", task.id)).session, task.session);
  await orchestrator.reconcile("parent", task.id);
  await assert.rejects(orchestrator.retry("parent", task.id), /Attempt limit/);
  assert.equal(executor.launches, 1);
});

test("an outstanding abort cannot be reconciled into a retry of the same child", async (t) => {
  const { root, config, executor, orchestrator } = fixture(t);
  executor.fail = true;
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  let completeAbort = () => {};
  executor.abort = () =>
    new Promise<void>((done) => {
      completeAbort = done;
    });
  const cancellation = orchestrator.cancel("parent", task.id);
  const observer = new Orchestrator(root, config, executor);
  assert.equal(observer.get("parent", task.id).status, "cancelling");
  await assert.rejects(observer.reconcile("parent", task.id), /unconfirmed/);
  await assert.rejects(observer.cancel("parent", task.id), /unconfirmed/);
  await assert.rejects(observer.retry("parent", task.id), /Reconcile or cancel/);
  completeAbort();
  assert.equal((await cancellation).status, "cancelled");
  executor.fail = false;
  assert.equal((await observer.retry("parent", task.id)).status, "ready");
  assert.equal(executor.launches, 1);
});

test("terminal recovery persists the child discovered after an ambiguous creation", async (t) => {
  const { executor, orchestrator } = fixture(t);
  executor.create = async () => {
    throw new Error("Lost create response");
  };
  executor.snapshot = { state: "idle", parent: "parent", session: "discovered", result };
  const first = await orchestrator.delegate("parent", "test/coder", assignment);
  assert.equal(first.session, undefined);
  assert.equal((await orchestrator.reconcile("parent", first.id)).session, "discovered");
  const second = await orchestrator.delegate("parent", "test/coder", {
    ...assignment,
    key: "second",
  });
  assert.equal((await orchestrator.cancel("parent", second.id)).session, "discovered");
  assert.equal((await orchestrator.retry("parent", second.id)).status, "ready");
});

test("an ambiguous abort response retains custody instead of authorizing a retry", async (t) => {
  const { executor, orchestrator } = fixture(t);
  executor.fail = true;
  executor.abort = async () => {
    throw new Error("Lost abort response");
  };
  const task = await orchestrator.delegate("parent", "test/coder", assignment);
  await assert.rejects(orchestrator.cancel("parent", task.id), /Lost abort/);
  assert.equal(orchestrator.get("parent", task.id).status, "cancelling");
  await assert.rejects(orchestrator.reconcile("parent", task.id), /unconfirmed/);
  await assert.rejects(orchestrator.retry("parent", task.id), /Reconcile or cancel/);
});
