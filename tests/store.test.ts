import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store } from "../src/store.js";

test("journal locks recover even when a previous lock recovery process died", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await new Promise<void>((done, reject) => {
    child.once("exit", () => done());
    child.once("error", reject);
  });
  assert.ok(child.pid);
  const store = new Store(root);
  const deadOwner = { pid: child.pid, host: hostname(), token: randomUUID() };
  const deadRecovery = { ...deadOwner, token: randomUUID() };
  writeFileSync(join(store.directory, "transaction.lock"), JSON.stringify(deadOwner));
  const recovery = join(store.directory, `recovery-${deadOwner.token}.lock`);
  writeFileSync(recovery, JSON.stringify(deadRecovery));
  assert.deepEqual(store.list(), []);
  assert.equal(existsSync(recovery), false);
  assert.equal(existsSync(join(store.directory, "transaction.lock")), false);
});
