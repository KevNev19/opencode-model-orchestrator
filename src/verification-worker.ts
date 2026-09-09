import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { fingerprint, runCheck } from "./workspace.js";

const jobSchema = z.object({
  root: z.string(),
  token: z.string().uuid(),
  inputs: z.array(z.string()),
  checks: z.array(z.object({ name: z.string(), argv: z.array(z.string()) })),
  timeoutMs: z.number().positive(),
});
let started = false;
const SHUTDOWN_GRACE_MS = 5000;

function stopGroup(): never {
  process.kill(-process.pid, "SIGKILL");
  throw new Error("Verifier process group did not terminate");
}

process.on("disconnect", () => {
  if (!started) process.exit(0);
});
process.once("message", async (message) => {
  started = true;
  try {
    const job = jobSchema.parse(message);
    // This deadline survives loss of the coordinator, including inherited open pipes.
    setTimeout(stopGroup, job.timeoutMs * Math.max(1, job.checks.length) + SHUTDOWN_GRACE_MS);
    const before = fingerprint(job.root, job.inputs);
    const checks = [];
    for (const check of job.checks)
      checks.push(await runCheck(job.root, check.name, check.argv, job.timeoutMs, true));
    const after = fingerprint(job.root, job.inputs);
    const result = {
      token: job.token,
      verification: {
        fingerprint: after,
        checks,
        passed: before === after && checks.every((check) => check.passed),
        at: Date.now(),
      },
    };
    const output = join(job.root, ".orchestrator", `verification-${job.token}.json`);
    const fd = openSync(`${output}.tmp`, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(result));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(`${output}.tmp`, output);
    // Checks may leave descendants behind; release custody only after this group stops.
    stopGroup();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    stopGroup();
  }
});
