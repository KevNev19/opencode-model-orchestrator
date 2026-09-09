import { fork } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { OrchestratorConfig } from "./config.js";
import { isCode } from "./store.js";
import { type Task, taskSchema } from "./types.js";

const resultSchema = z.object({
  token: z.string().uuid(),
  verification: taskSchema.shape.verification.unwrap(),
});
const IPC_GRACE_MS = 5000;
const OUTPUT_LIMIT = 32000;

/** Launches a waiting child; no check starts until its PID is durably recorded. */
export async function launchVerification(
  root: string,
  task: Task,
  config: OrchestratorConfig,
  recordPid: (pid: number) => void,
): Promise<void> {
  if (process.platform === "win32") throw new Error("Verification requires macOS or Linux");
  const verifier = task.verifier;
  if (!verifier) throw new Error("Missing verifier identity");
  const compiled = fileURLToPath(new URL("./verification-worker.js", import.meta.url));
  const sourceBuild = fileURLToPath(new URL("../dist/verification-worker.js", import.meta.url));
  const worker = existsSync(compiled) ? compiled : sourceBuild;
  if (!existsSync(worker)) throw new Error("Build the package before running verification");
  const checks = task.checks.map((name) => {
    const argv = config.checks[name];
    if (!argv) throw new Error(`Verification check was removed: ${name}`);
    return { name, argv };
  });
  await new Promise<void>((done, reject) => {
    const child = fork(worker, [], {
      execPath: "node",
      execArgv: [],
      cwd: root,
      detached: true,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let errors = "";
    child.stderr?.on("data", (chunk) => {
      errors = (errors + chunk.toString()).slice(-OUTPUT_LIMIT);
    });
    const timer = setTimeout(
      () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if (!isCode(error, "ESRCH")) reject(error);
          }
        }
      },
      config.checkTimeoutMs * Math.max(1, checks.length) + IPC_GRACE_MS,
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("spawn", () => {
      try {
        if (!child.pid) throw new Error("Verifier PID unavailable");
        recordPid(child.pid);
        child.send(
          {
            root,
            token: verifier.token,
            inputs: [...task.files, ...config.verificationInputs],
            checks,
            timeoutMs: config.checkTimeoutMs,
          },
          (error) => {
            if (error) {
              child.disconnect();
              reject(error);
            }
          },
        );
      } catch (error) {
        child.disconnect();
        reject(error);
      }
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 || signal === "SIGKILL") done();
      else reject(new Error(errors || "Verification process failed or timed out"));
    });
  });
}

/** A live or unknown process retains custody; this function never signals it. */
export function verifierStopped(task: Task): boolean {
  const verifier = task.verifier;
  if (!verifier || verifier.host !== hostname()) return false;
  const pid = verifier.pid ? -verifier.pid : verifier.ownerPid;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (isCode(error, "ESRCH")) return true;
    if (isCode(error, "EPERM")) return false;
    throw error;
  }
}

/** Loads only the output associated with the recorded verifier token. */
export function verificationResult(root: string, task: Task): Task["verification"] {
  if (!task.verifier) return undefined;
  const file = join(root, ".orchestrator", `verification-${task.verifier.token}.json`);
  if (!existsSync(file)) return undefined;
  const result = resultSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (result.token !== task.verifier.token) throw new Error("Verification ownership mismatch");
  return result.verification;
}
