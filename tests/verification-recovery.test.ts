import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { configSchema } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import { isCode, Store } from "../src/store.js";
import type { Executor } from "../src/types.js";

test("verification survives the coordinator process dying and is reconciled without rerunning checks", {
  timeout: 15000,
}, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verification-recovery-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "value.txt"), "stable");
  const config = configSchema.parse({
    routes: Object.fromEntries(
      ["explore", "implement", "review"].map((role) => [role, { models: ["test/model"] }]),
    ),
    checks: {
      wait: [
        process.execPath,
        "-e",
        String.raw`
      const fs = require('node:fs');
      const child = require('node:child_process').spawn(process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
      child.unref();
      fs.writeFileSync('.orchestrator/descendant-pid', String(child.pid));
      fs.appendFileSync('.orchestrator/check-runs', 'run\n');
      setTimeout(() => process.exit(0), 750);
    `,
      ],
    },
  });
  const moduleUrl = pathToFileURL(resolve("dist/orchestrator.js")).href;
  const script = `import { Orchestrator } from ${JSON.stringify(moduleUrl)};
    const executor = {
      models: async () => [{ id: 'test/model', connected: true, tools: true }],
      create: async () => 'child',
      run: async () => ({ handoff: 'Done', usage: {input:1,output:1,reasoning:0,cacheRead:0,cacheWrite:0,cost:0} }),
      inspect: async () => ({state:'idle',parent:'parent'}), abort: async () => {}
    };
    const runtime = new Orchestrator(${JSON.stringify(root)}, ${JSON.stringify(config)}, executor);
    const task = await runtime.delegate('parent', 'test/model', {key:'crash', role:'implement', outcome:'Inspect stable file', acceptance:['Stable'], files:['value.txt'], checks:['wait']});
    await runtime.verify('parent', task.id);`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let ownerError = "";
  owner.stderr.on("data", (data) => {
    ownerError += data.toString();
  });
  t.after(() => {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
  });
  const store = new Store(root);
  const checkRuns = join(root, ".orchestrator", "check-runs");
  let task = store.list()[0];
  for (let count = 0; count < 150 && (!task?.verifier?.pid || !existsSync(checkRuns)); count++) {
    await delay(20);
    try {
      task = store.list()[0];
    } catch (error) {
      if (!String(error).includes("busy")) throw error;
    }
  }
  assert.ok(
    task?.verifier?.pid,
    `Verifier PID must be recorded before killing the coordinator: ${ownerError} ${JSON.stringify(task)}`,
  );
  const id = task.id;
  assert.equal(existsSync(checkRuns), true, "Check must have started before the coordinator dies");
  const noWorkers: Executor = {
    models: async () => [],
    create: async () => {
      throw new Error("Unexpected worker launch");
    },
    run: async () => {
      throw new Error("Unexpected worker run");
    },
    inspect: async () => ({ state: "missing" }),
    abort: async () => {
      throw new Error("Unexpected abort");
    },
  };
  const restarted = new Orchestrator(root, config, noWorkers);
  await assert.rejects(restarted.reconcile("parent", id), /live or unknown/);
  const exited = new Promise<void>((done) => owner.once("exit", () => done()));
  owner.kill("SIGKILL");
  await exited;
  let recovered = false;
  for (let count = 0; count < 150; count++) {
    try {
      task = await restarted.reconcile("parent", id);
      recovered = task.status === "ready";
      if (recovered) break;
    } catch (error) {
      if (!String(error).includes("live or unknown")) throw error;
    }
    await delay(20);
  }
  assert.equal(recovered, true);
  assert.equal(task?.verification?.passed, true);
  assert.equal(readFileSync(checkRuns, "utf8"), "run\n");
  const descendant = Number(readFileSync(join(root, ".orchestrator", "descendant-pid"), "utf8"));
  let descendantStopped = false;
  for (let count = 0; count < 150; count++) {
    try {
      process.kill(descendant, 0);
    } catch (error) {
      if (isCode(error, "ESRCH")) {
        descendantStopped = true;
        break;
      }
      if (!isCode(error, "EPERM")) throw error;
    }
    await delay(20);
  }
  assert.equal(descendantStopped, true, "Verification must stop background check descendants");
  assert.equal(
    restarted.accept("parent", id, "The recorded check passed against the stable file").status,
    "accepted",
  );
});
