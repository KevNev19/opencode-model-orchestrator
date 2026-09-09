import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { type ModelInfo, modelSchema, type Role } from "./types.js";

const routeSchema = z.object({
  models: z.array(modelSchema).min(1),
  byCoordinator: z.record(z.string(), z.array(modelSchema).min(1)).default({}),
  preferDifferent: z.boolean().default(false),
});
export const configSchema = z
  .object({
    routes: z.object({ explore: routeSchema, implement: routeSchema, review: routeSchema }),
    maxConcurrent: z.number().int().min(1).max(8).default(3),
    timeoutMs: z.number().int().min(100).max(3600000).default(600000),
    maxAttempts: z.number().int().min(1).max(5).default(2),
    workerSteps: z.number().int().min(1).max(100).default(30),
    checks: z.record(z.string(), z.array(z.string().min(1)).min(1)).default({}),
    verificationInputs: z.array(z.string()).default([]),
    checkTimeoutMs: z.number().int().min(100).max(600000).default(120000),
  })
  .strict();
export type OrchestratorConfig = z.infer<typeof configSchema>;

/** Loads and validates the project's explicit orchestration configuration. */
export function loadConfig(root: string): OrchestratorConfig {
  return configSchema.parse(JSON.parse(readFileSync(join(root, "orchestrator.json"), "utf8")));
}

/** Chooses the first available configured route, honoring coordinator overrides. */
export function selectModel(
  config: OrchestratorConfig,
  role: Role,
  coordinator: string,
  models: ModelInfo[],
) {
  const route = config.routes[role];
  const candidates = route.byCoordinator[coordinator] ?? route.models;
  const available = candidates.filter((id) =>
    models.some((model) => model.id === id && model.connected && model.tools),
  );
  const selected = route.preferDifferent
    ? (available.find((id) => id !== coordinator) ?? available[0])
    : available[0];
  if (!selected)
    throw new Error(
      `No connected, tool-capable model in the ${role} route: ${candidates.join(", ")}`,
    );
  return {
    model: selected,
    reason: `${role}: ${route.byCoordinator[coordinator] ? "coordinator override" : "configured priority"}; selected ${selected}${route.preferDifferent && selected !== coordinator ? "; different from coordinator" : ""}. Availability is catalogue evidence, not an authentication test.`,
  };
}
