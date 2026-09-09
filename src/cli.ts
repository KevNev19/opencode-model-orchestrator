#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { configSchema, loadConfig } from "./config.js";
import { Store } from "./store.js";
import { activeStatuses, modelSchema, roleSchema } from "./types.js";
import { fingerprint } from "./workspace.js";

const TESTED_VERSION = "1.18.30";
const VERSION_TIMEOUT_MS = 10000;
const plugin = join(dirname(fileURLToPath(import.meta.url)), "plugin.js");
const commands = new Set(["init", "doctor", "status", "report"]);
const help = `Usage: oc-orchestrator <init|doctor|status|report> [options]

init --model provider/model  Create project routes and a local plugin loader.
                            All roles initially use this model; edit routes to specialize.
doctor                      Check routes, configured checks, build and local OpenCode.
status [--session ID]        Show durable assignments and whether verification is current.
report [--session ID]        Summarize recorded worker usage and outcomes.

Options: --root PATH (default: current directory), --model ID, --session ID, --help

Requires OpenCode ${TESTED_VERSION}, Node 22.6+ and macOS or Linux. Managed mode
delegates edits, denies workers shell/MCP tools, and runs only named verification
commands from orchestrator.json. It does not sandbox external processes. Existing
edits are never rolled back automatically. Implementation requires at least one
configured check. The coordinator assesses semantic acceptance; passing commands
alone do not establish correctness.

Setup: npm install && npm run build
Then: node dist/cli.js init --model <your-connected-provider/model>
Edit orchestrator.json to set routes and checks; start OpenCode in that project.
Set verificationInputs for ignored files that affect checks. Assignment paths are
always included alongside tracked and nonignored workspace files.
Ask Build to delegate an implementation, verify it and accept it with evidence.
Use orchestrator_reconcile after interruption; retry reuses the owned child.
An unknown child, corrupt journal, or unknown verifier process retains custody.
An unconfirmed cancellation requires manual inspection; the plugin cannot safely
release it or retry automatically, even after restarting the coordinator.
Remove the generated loader to disable managed mode once all workers are stopped.
`;

function main(): void {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      model: { type: "string" },
      session: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (!command || values.help) {
    process.stdout.write(help);
    return;
  }
  if (!commands.has(command)) throw new Error(`Unknown command: ${command}`);
  if (positionals.length !== 1) throw new Error("Expected one command; use --help for usage");
  const root = realpathSync(resolve(values.root ?? process.cwd()));
  switch (command) {
    case "init":
      initialize(root, values.model);
      break;
    case "doctor":
      doctor(root);
      break;
    case "status":
      status(root, values.session);
      break;
    case "report":
      report(root, values.session);
      break;
  }
}

function initialize(root: string, requestedModel?: string): void {
  const model = modelSchema.parse(requestedModel);
  if (!existsSync(plugin)) throw new Error("Build the package before initializing a project");
  const configFile = join(root, "orchestrator.json");
  const loader = join(root, ".opencode", "plugins", "model-orchestrator.js");
  if (existsSync(configFile) || existsSync(loader))
    throw new Error("Configuration or loader already exists; inspect it instead of overwriting");
  const config = configSchema.parse({
    routes: Object.fromEntries(roleSchema.options.map((role) => [role, { models: [model] }])),
  });
  mkdirSync(dirname(loader), { recursive: true });
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  writeFileSync(
    loader,
    `export { default } from ${JSON.stringify(pathToFileURL(plugin).href)};\n`,
    {
      flag: "wx",
    },
  );
  print({
    config: configFile,
    loader,
    next: "Set model routes and verification checks in orchestrator.json, then start OpenCode. Ignore .orchestrator/ in version control.",
  });
}

function doctor(root: string): void {
  const config = loadConfig(root);
  const runtime = spawnSync("opencode", ["--version"], {
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
  });
  const version = runtime.stdout?.trim();
  const checksConfigured = Object.keys(config.checks).length > 0;
  const compatible = runtime.status === 0 && version === TESTED_VERSION;
  const buildExists = existsSync(plugin);
  print({
    compatible,
    testedVersion: TESTED_VERSION,
    version: version || null,
    runtimeSignal: runtime.signal,
    runtimeError: runtime.error?.message || runtime.stderr?.trim() || null,
    buildExists,
    checksConfigured,
    routes: config.routes,
    note: "Provider authentication and live model access are not tested by this command.",
  });
  if (!compatible || !checksConfigured || !buildExists) process.exitCode = 1;
}

function snapshot(root: string, session?: string) {
  const snapshot = existsSync(join(root, ".orchestrator", "journal.jsonl"))
    ? new Store(root).snapshot()
    : { tasks: [], events: [] };
  return {
    tasks: snapshot.tasks.filter((task) => !session || task.parent === session),
    events: snapshot.events.filter((event) => !session || event.task.parent === session),
  };
}

function status(root: string, session?: string): void {
  const { tasks } = snapshot(root, session);
  const config = existsSync(join(root, "orchestrator.json")) ? loadConfig(root) : undefined;
  print(
    tasks.map((task) => ({
      ...task,
      verificationCurrent: Boolean(
        config &&
          task.verification &&
          task.verification.fingerprint ===
            fingerprint(root, [...task.files, ...config.verificationInputs]),
      ),
    })),
  );
}

function report(root: string, session?: string): void {
  const { tasks, events } = snapshot(root, session);
  const executions = events.filter((event) => event.action === "worker_finished");
  const sumUsage = (field: "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite") =>
    executions.reduce((total, event) => total + (event.task.usage?.[field] ?? 0), 0);
  print({
    assignments: tasks.length,
    accepted: tasks.filter((task) => task.status === "accepted").length,
    unresolved: tasks.filter((task) => activeStatuses.has(task.status)).length,
    recordedWorkerExecutions: executions.length,
    workerTokens: {
      input: sumUsage("input"),
      output: sumUsage("output"),
      reasoning: sumUsage("reasoning"),
      cacheRead: sumUsage("cacheRead"),
      cacheWrite: sumUsage("cacheWrite"),
    },
    recordedWorkerCost: executions.every((event) => event.task.usage?.cost != null)
      ? executions.reduce((total, event) => total + (event.task.usage?.cost ?? 0), 0)
      : null,
    note: "Worker usage only; excludes coordinator, uncompleted attempts and provider billing adjustments. Token categories may overlap. Zero reported cost does not imply free service. This is not comparative benchmark evidence.",
  });
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
