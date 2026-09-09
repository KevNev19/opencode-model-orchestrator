import { resolve } from "node:path";
import type { Store } from "./store.js";
import { assertLocalPath, inScope } from "./workspace.js";

export const readTools = ["read", "glob", "grep", "list", "webfetch", "websearch", "skill"];
const writes = new Set(["edit", "write", "apply_patch"]);
const coordinatorTools = new Set([
  ...readTools,
  "question",
  "todowrite",
  "todoread",
  "orchestrator_models",
  "orchestrator_delegate",
  "orchestrator_status",
  "orchestrator_reconcile",
  "orchestrator_cancel",
  "orchestrator_retry",
  "orchestrator_verify",
  "orchestrator_accept",
]);

/** Enforces managed-session tool boundaries, not an operating-system sandbox. */
export function guardTool(
  store: Store,
  sessionID: string,
  tool: string,
  args: Record<string, unknown>,
): void {
  const tasks = store.list();
  const worker = tasks.find((task) => task.session === sessionID);
  if (!worker) {
    if (coordinatorTools.has(tool)) return;
    throw new Error(
      "Managed orchestration is enabled. Delegate edits with orchestrator_delegate and run configured checks with orchestrator_verify.",
    );
  }
  if (worker.status !== "running")
    throw new Error("Worker custody has ended or is interrupted; reconcile the assignment");
  if (readTools.includes(tool)) return;
  if (worker.role !== "implement" || !writes.has(tool))
    throw new Error(`Tool ${tool} is not allowed for this worker`);
  const paths = tool === "apply_patch" ? patchPaths(args.patchText) : [args.filePath];
  if (paths.length === 0) throw new Error("No writable paths found");
  for (const file of paths) {
    if (typeof file !== "string" || !file) throw new Error("Missing write path");
    const relative = assertLocalPath(store.root, resolve(store.root, file));
    if (
      relative
        .split("/")
        .some((part) => [".git", ".orchestrator", ".opencode", "node_modules"].includes(part)) ||
      ["orchestrator.json", "opencode.json", "opencode.jsonc"].includes(relative)
    )
      throw new Error("Worker cannot modify orchestration or repository control files");
    if (!inScope(relative, worker.files))
      throw new Error(`Path is outside this assignment: ${relative}`);
  }
}

function patchPaths(value: unknown): string[] {
  if (typeof value !== "string") throw new Error("Missing patch text");
  return value.split("\n").flatMap((line) => {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$/.exec(line);
    return match?.[1] ? [match[1].trim()] : [];
  });
}
