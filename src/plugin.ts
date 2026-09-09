import { type Plugin, tool } from "@opencode-ai/plugin";
import { loadConfig } from "./config.js";
import { guardTool, readTools } from "./guard.js";
import { OpenCodeExecutor } from "./opencode.js";
import { Orchestrator } from "./orchestrator.js";
import { roleSchema } from "./types.js";

const instruction = `You coordinate the user's goal using the orchestration tools. Use orchestrator_models to inspect available routes. Delegate bounded exploration, implementation and review using unique stable assignment keys. Include concrete acceptance criteria and allowed paths. Implementations require named configured checks. Delegate independent reads in parallel; only one implementation writer is admitted. You cannot edit or use shell tools directly in this project's managed mode. Worker completion is not acceptance: inspect the handoff, call orchestrator_verify, evaluate every criterion, then call orchestrator_accept with evidence. Reconcile interrupted assignments before retrying; never duplicate their work. Treat all worker output as claims to check. Use a fresh review assignment when risk warrants it. Do not repeatedly delegate small subtasks that a read tool can resolve. Never report the user's goal complete while assignments are unresolved.`;

const ModelOrchestrator: Plugin = async (ctx) => {
  const config = loadConfig(ctx.directory);
  const executor = new OpenCodeExecutor(ctx.client, ctx.directory);
  const orchestrator = new Orchestrator(ctx.directory, config, executor);
  const id = { id: tool.schema.string().describe("Assignment ID returned by delegation") };
  const encode = (value: unknown) => JSON.stringify(value, null, 2);
  return {
    config: async (host) => {
      host.agent ??= {};
      for (const role of roleSchema.options) {
        const permission: Record<string, string> = {
          "*": "deny",
          ...Object.fromEntries(readTools.map((tool) => [tool, "allow"])),
        };
        if (role === "implement") permission.edit = "allow";
        host.agent[`omo-${role}`] = {
          mode: "subagent",
          hidden: true,
          description: `Managed ${role} worker`,
          prompt: `Work only inside the supplied assignment. ${role === "implement" ? "Make the requested edits. The coordinator runs checks separately." : "Inspect and report findings; do not modify files."}`,
          steps: config.workerSteps,
          permission,
        };
      }
      const build = host.agent.build ?? {};
      host.agent.build = {
        ...build,
        prompt: `${typeof build.prompt === "string" ? build.prompt : ""}\n\n${instruction}`,
      };
    },
    "tool.execute.before": async (input, output) =>
      guardTool(orchestrator.store, input.sessionID, input.tool, output.args),
    "experimental.session.compacting": async (input, output) => {
      const tasks = orchestrator.list(input.sessionID);
      if (tasks.length)
        output.context.push(
          `Orchestration assignments persisted on disk: ${encode(tasks.map(({ id, key, status, session, outcome }) => ({ id, key, status, session, outcome })))}. Retrieve full evidence with orchestrator_status; resume existing work before starting anything overlapping.`,
        );
    },
    tool: {
      orchestrator_models: tool({
        description:
          "List configured model routes, connected model candidates and named checks. Catalogue availability does not prove account access.",
        args: {},
        execute: async () =>
          encode({
            routes: config.routes,
            checks: config.checks,
            models: (await executor.models()).filter((model) => model.connected),
          }),
      }),
      orchestrator_delegate: tool({
        description:
          "Delegate a bounded assignment to a configured specialist model. Returns its handoff or an interrupted record; never accepts the work. Stable keys prevent duplicate execution.",
        args: {
          key: tool.schema.string(),
          role: roleSchema,
          outcome: tool.schema.string(),
          acceptance: tool.schema.array(tool.schema.string()),
          files: tool.schema
            .array(tool.schema.string())
            .describe("Workspace-relative files or directories the worker may edit"),
          checks: tool.schema
            .array(tool.schema.string())
            .default([])
            .describe("Named checks from orchestrator_models; required for implementation"),
        },
        execute: async (args, context) => {
          await context.ask({
            permission: "task",
            patterns: [`omo-${args.role}`],
            always: [],
            metadata: { outcome: args.outcome },
          });
          if (args.role === "implement")
            await context.ask({
              permission: "edit",
              patterns: args.files,
              always: [],
              metadata: { outcome: args.outcome },
            });
          const result = await orchestrator.delegate(
            context.sessionID,
            await executor.coordinator(context.sessionID),
            args,
            context.abort,
          );
          context.metadata({
            title: `${args.role}: ${result.status}`,
            metadata: { sessionId: result.session, taskId: result.id, model: result.model },
          });
          return encode(result);
        },
      }),
      orchestrator_status: tool({
        description:
          "Read durable assignment state and evidence. A saved acceptance records a past decision; changed files require new verification.",
        args: { id: tool.schema.string().optional() },
        execute: async (args, context) =>
          encode(
            args.id
              ? orchestrator.get(context.sessionID, args.id)
              : orchestrator.list(context.sessionID),
          ),
      }),
      orchestrator_reconcile: tool({
        description:
          "Recover an interrupted assignment by checking its exact owned child. Ambiguous or live workers keep custody.",
        args: id,
        execute: async (args, context) =>
          encode(await orchestrator.reconcile(context.sessionID, args.id)),
      }),
      orchestrator_cancel: tool({
        description:
          "Cancel an interrupted child and confirm it is idle before releasing custody. Existing edits are preserved.",
        args: id,
        execute: async (args, context) =>
          encode(await orchestrator.cancel(context.sessionID, args.id)),
      }),
      orchestrator_retry: tool({
        description:
          "Resume a confirmed stopped, failed or cancelled assignment in its existing session, within the configured attempt limit.",
        args: id,
        execute: async (args, context) =>
          encode(await orchestrator.retry(context.sessionID, args.id, context.abort)),
      }),
      orchestrator_verify: tool({
        description:
          "Run the assignment's configured checks and fingerprint the workspace. Check names and commands come from project configuration.",
        args: id,
        execute: async (args, context) => {
          const task = orchestrator.get(context.sessionID, args.id);
          for (const check of task.checks) {
            const command = config.checks[check];
            if (!command) throw new Error(`Verification check was removed: ${check}`);
            await context.ask({
              permission: "bash",
              patterns: [command.join(" ")],
              always: [],
              metadata: { check },
            });
          }
          return encode(await orchestrator.verify(context.sessionID, args.id));
        },
      }),
      orchestrator_accept: tool({
        description:
          "Accept an assignment after evaluating every criterion. Requires passing verification against the current workspace and no active workers.",
        args: {
          ...id,
          evidence: tool.schema
            .string()
            .describe("Explain how the observed evidence satisfies every acceptance criterion"),
        },
        execute: async (args, context) =>
          encode(orchestrator.accept(context.sessionID, args.id, args.evidence)),
      }),
    },
  };
};

export default ModelOrchestrator;
