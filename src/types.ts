import { z } from "zod";

export const roleSchema = z.enum(["explore", "implement", "review"]);
export type Role = z.infer<typeof roleSchema>;
export const modelSchema = z.string().regex(/^[^/\s]+\/\S+$/, "Use provider/model");
export const usageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  reasoning: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cost: z.number().nonnegative().nullable(),
});
export type Usage = z.infer<typeof usageSchema>;

export const assignmentSchema = z.object({
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  role: roleSchema,
  outcome: z.string().min(1).max(16000),
  acceptance: z.array(z.string().min(1).max(2000)).min(1).max(20),
  files: z.array(z.string().min(1)).min(1).max(100),
  checks: z.array(z.string()).default([]),
});
export type Assignment = z.infer<typeof assignmentSchema>;
export const taskSchema = assignmentSchema.extend({
  id: z.string().uuid(),
  parent: z.string(),
  coordinator: modelSchema,
  model: modelSchema,
  routeReason: z.string(),
  session: z.string().optional(),
  message: z.string(),
  status: z.enum([
    "reserved",
    "running",
    "interrupted",
    "cancelling",
    "ready",
    "failed",
    "verifying",
    "accepted",
    "cancelled",
  ]),
  created: z.number(),
  updated: z.number(),
  attempt: z.number().int().positive(),
  revision: z.number().int().positive(),
  abortConfirmed: z.boolean().optional(),
  verifier: z
    .object({
      token: z.string().uuid(),
      ownerPid: z.number().int().positive(),
      host: z.string(),
      pid: z.number().int().positive().optional(),
    })
    .optional(),
  prompt: z.string(),
  handoff: z.string().optional(),
  error: z.string().optional(),
  usage: usageSchema.optional(),
  verification: z
    .object({
      fingerprint: z.string(),
      checks: z.array(
        z.object({
          name: z.string(),
          argv: z.array(z.string()),
          exitCode: z.number().nullable(),
          output: z.string(),
          passed: z.boolean(),
        }),
      ),
      passed: z.boolean(),
      at: z.number(),
    })
    .optional(),
  verdict: z.string().optional(),
});
export type Task = z.infer<typeof taskSchema>;
export const activeStatuses = new Set<Task["status"]>([
  "reserved",
  "running",
  "interrupted",
  "cancelling",
  "verifying",
]);

export interface ModelInfo {
  id: string;
  connected: boolean;
  tools: boolean;
}
export interface WorkerResult {
  handoff: string;
  usage: Usage;
  error?: string;
}
export interface WorkerSnapshot {
  state: "busy" | "idle" | "missing";
  session?: string;
  parent?: string;
  result?: WorkerResult;
}
export interface Executor {
  models(): Promise<ModelInfo[]>;
  create(task: Task): Promise<string>;
  run(task: Task, signal: AbortSignal): Promise<WorkerResult>;
  inspect(task: Task): Promise<WorkerSnapshot>;
  abort(task: Task): Promise<void>;
}
