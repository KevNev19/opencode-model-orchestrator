import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { Executor } from "../src/types.js";

const cli = resolve("dist/cli.js");
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestrator-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, "--root", root], {
      encoding: "utf8",
    });
  return { root, run };
}

test("CLI validates commands before reading state and init preserves existing configuration", (t) => {
  const { root, run } = fixture(t);
  const unknown = run("typo");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown command/);
  assert.deepEqual(JSON.parse(run("status").stdout), []);
  assert.equal(JSON.parse(run("report").stdout).assignments, 0);
  const initialized = run("init", "--model", "fixture/coder");
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(loadConfig(root).routes.implement.models[0], "fixture/coder");
  const loader = readFileSync(join(root, ".opencode/plugins/model-orchestrator.js"), "utf8");
  assert.match(loader, /export \{ default \} from "file:\/\//);
  assert.equal(run("init", "--model", "fixture/other").status, 1);
  assert.equal(loadConfig(root).routes.implement.models[0], "fixture/coder");
});

test("CLI status hashes ignored verification inputs and reports only recorded worker usage", async (t) => {
  const { root, run } = fixture(t);
  assert.equal(run("init", "--model", "fixture/coder").status, 0);
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, ".gitignore"), ".orchestrator/\ncode.txt\nfixture.txt\n");
  writeFileSync(join(root, "code.txt"), "source");
  writeFileSync(join(root, "fixture.txt"), "input");
  const config = loadConfig(root);
  config.verificationInputs = ["fixture.txt"];
  config.checks.test = [process.execPath, "-e", "process.exit(0)"];
  writeFileSync(join(root, "orchestrator.json"), JSON.stringify(config));
  const executor: Executor = {
    models: async () => [{ id: "fixture/coder", connected: true, tools: true }],
    create: async () => "child",
    run: async () => ({
      handoff: "Done",
      usage: { input: 10, output: 20, reasoning: 5, cacheRead: 2, cacheWrite: 0, cost: 0.1 },
    }),
    inspect: async () => ({ state: "idle", parent: "parent" }),
    abort: async () => {},
  };
  const runtime = new Orchestrator(root, config, executor);
  const task = await runtime.delegate("parent", "fixture/coder", {
    key: "cli",
    role: "implement",
    outcome: "Inspect source",
    acceptance: ["Unchanged"],
    files: ["code.txt"],
    checks: ["test"],
  });
  assert.equal((await runtime.verify("parent", task.id)).verification?.passed, true);
  assert.equal(JSON.parse(run("status").stdout)[0].verificationCurrent, true);
  writeFileSync(join(root, "fixture.txt"), "changed ignored input");
  assert.equal(JSON.parse(run("status").stdout)[0].verificationCurrent, false);
  const report = JSON.parse(run("report").stdout);
  assert.equal(report.recordedWorkerExecutions, 1);
  assert.equal(report.recordedWorkerCost, 0.1);
  assert.equal(report.workerTokens.reasoning, 5);
  assert.equal(JSON.parse(run("report", "--session", "foreign").stdout).assignments, 0);
});
