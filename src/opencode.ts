import type { PluginInput } from "@opencode-ai/plugin";
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk";
import { z } from "zod";
import type { Executor, ModelInfo, Task, Usage, WorkerResult, WorkerSnapshot } from "./types.js";

const permissionSchema = z.object({
  permission: z.string(),
  pattern: z.string(),
  action: z.enum(["allow", "ask", "deny"]),
});
const sessionSchema = z.object({
  id: z.string(),
  parentID: z.string().optional(),
  permission: z.array(permissionSchema).default([]),
  directory: z.string(),
});
type Client = PluginInput["client"];
const API_TIMEOUT = 15000;

function data<T>(response: { data?: T; error?: unknown }): T {
  if (response.error !== undefined || response.data === undefined)
    throw new Error(
      `OpenCode request failed: ${JSON.stringify(response.error ?? "empty response")}`,
    );
  return response.data;
}

/** Uses the host's SDK client so in-process transport and authentication are preserved. */
export class OpenCodeExecutor implements Executor {
  constructor(
    private readonly client: Client,
    private readonly root: string,
  ) {}

  /** Exposes connected catalogue capabilities without provider credentials or options. */
  async models(): Promise<ModelInfo[]> {
    const catalogue = data(
      await this.client.provider.list({
        query: { directory: this.root },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }),
    );
    const parsed = z
      .object({
        connected: z.array(z.string()),
        all: z.array(
          z.object({
            id: z.string(),
            models: z.record(
              z.string(),
              z.object({
                id: z.string(),
                tool_call: z.boolean().optional(),
                capabilities: z.object({ toolcall: z.boolean() }).optional(),
              }),
            ),
          }),
        ),
      })
      .parse(catalogue);
    return parsed.all.flatMap((provider) =>
      Object.values(provider.models).map((model) => ({
        id: `${provider.id}/${model.id}`,
        connected: parsed.connected.includes(provider.id),
        tools: model.capabilities?.toolcall ?? model.tool_call ?? false,
      })),
    );
  }

  /** Reads the model selected for the latest coordinator request. */
  async coordinator(sessionID: string): Promise<string> {
    const messages = data(
      await this.client.session.messages({
        path: { id: sessionID },
        query: { directory: this.root },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }),
    );
    const user = messages.findLast((message) => message.info.role === "user")?.info;
    if (user?.role !== "user") throw new Error("Cannot determine the current coordinator model");
    return `${user.model.providerID}/${user.model.modelID}`;
  }

  /** Creates an identifiable child carrying the parent's restrictive permission rules. */
  async create(task: Task): Promise<string> {
    const parent = sessionSchema.parse(
      data(
        await this.client.session.get({
          path: { id: task.parent },
          query: { directory: this.root },
          signal: AbortSignal.timeout(API_TIMEOUT),
        }),
      ),
    );
    if (parent.directory !== this.root) throw new Error("Parent belongs to another workspace");
    // The pinned server supports permission rules, although its legacy SDK omits the field.
    const messages = data(
      await this.client.session.messages({
        path: { id: task.parent },
        query: { directory: this.root },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }),
    );
    const user = messages.findLast((entry) => entry.info.role === "user")?.info;
    if (user?.role !== "user") throw new Error("Cannot determine parent permission context");
    const agents = z
      .array(z.object({ name: z.string(), permission: z.array(permissionSchema) }))
      .parse(
        data(
          await this.client.app.agents({
            query: { directory: this.root },
            signal: AbortSignal.timeout(API_TIMEOUT),
          }),
        ),
      );
    const agent = agents.find((entry) => entry.name === user.agent);
    if (!agent) throw new Error("Parent agent permission context is unavailable");
    const body = {
      parentID: task.parent,
      title: `omo:${task.id}`,
      permission: [...agent.permission, ...parent.permission].filter(
        (rule) => rule.action !== "allow" || rule.permission === "external_directory",
      ),
    };
    const created = sessionSchema.parse(
      data(
        await this.client.session.create({
          body,
          query: { directory: this.root },
          signal: AbortSignal.timeout(API_TIMEOUT),
        }),
      ),
    );
    if (created.parentID !== task.parent || created.directory !== this.root)
      throw new Error("Created child ownership mismatch");
    return created.id;
  }

  /** Runs one recorded prompt with the assigned model and requires a terminal handoff. */
  async run(task: Task, signal: AbortSignal): Promise<WorkerResult> {
    if (!task.session) throw new Error("Missing worker session");
    const slash = task.model.indexOf("/");
    data(
      await this.client.session.prompt({
        path: { id: task.session },
        query: { directory: this.root },
        body: {
          messageID: task.message,
          agent: `omo-${task.role}`,
          model: { providerID: task.model.slice(0, slash), modelID: task.model.slice(slash + 1) },
          parts: [{ type: "text", text: task.prompt }],
        },
        signal,
      }),
    );
    const snapshot = await this.inspect(task);
    if (snapshot.state !== "idle" || !snapshot.result)
      throw new Error("Worker response did not establish a terminal handoff");
    return snapshot.result;
  }

  /** Inspects only the recorded child or a uniquely identifiable child of its parent. */
  async inspect(task: Task): Promise<WorkerSnapshot> {
    if (!task.session) {
      const children = data(
        await this.client.session.children({
          path: { id: task.parent },
          query: { directory: this.root },
          signal: AbortSignal.timeout(API_TIMEOUT),
        }),
      );
      const matches = children.filter(
        (child) => child.title === `omo:${task.id}` && child.parentID === task.parent,
      );
      const match = matches[0];
      if (matches.length !== 1 || !match) return { state: "missing" };
      return this.inspect({ ...task, session: match.id });
    }
    const child = sessionSchema.parse(
      data(
        await this.client.session.get({
          path: { id: task.session },
          query: { directory: this.root },
          signal: AbortSignal.timeout(API_TIMEOUT),
        }),
      ),
    );
    if (child.directory !== this.root) throw new Error("Child belongs to another workspace");
    const statuses = data(
      await this.client.session.status({
        query: { directory: this.root },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }),
    );
    const status = statuses[task.session];
    if (status?.type && status.type !== "idle")
      return { state: "busy", parent: child.parentID, session: child.id };
    const messages = data(
      await this.client.session.messages({
        path: { id: task.session },
        query: { directory: this.root },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }),
    );
    return {
      state: "idle",
      parent: child.parentID,
      session: child.id,
      result: workerResult(messages, task.message, task.model),
    };
  }

  /** Aborts a native child only after checking its workspace and parent ownership. */
  async abort(task: Task): Promise<void> {
    const snapshot = await this.inspect(task);
    if (snapshot.state === "missing" || snapshot.parent !== task.parent || !snapshot.session)
      throw new Error("Cannot cancel a child without proven ownership");
    data(
      await this.client.session.abort({
        path: { id: snapshot.session },
        query: { directory: this.root },
        signal: AbortSignal.timeout(API_TIMEOUT),
      }),
    );
  }
}

/** Extracts one attempt's terminal handoff and usage, rejecting model or tool failures. */
export function workerResult(
  messages: Array<{ info: Message; parts: Part[] }>,
  messageID: string,
  expectedModel: string,
): WorkerResult | undefined {
  const relevant = messages.filter(
    (message): message is { info: AssistantMessage; parts: Part[] } =>
      message.info.role === "assistant" && message.info.parentID === messageID,
  );
  const last = relevant.at(-1);
  if (!last?.info.time.completed) return undefined;
  const finish = (last.info as AssistantMessage & { finish?: string }).finish;
  if (finish === "tool-calls" || finish === "unknown") return undefined;
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const { info } of relevant) {
    usage.input += info.tokens.input;
    usage.output += info.tokens.output;
    usage.reasoning += info.tokens.reasoning;
    usage.cacheRead += info.tokens.cache.read;
    usage.cacheWrite += info.tokens.cache.write;
    usage.cost = usage.cost === null || !Number.isFinite(info.cost) ? null : usage.cost + info.cost;
  }
  const modelMismatch = relevant.some(
    ({ info }) => `${info.providerID}/${info.modelID}` !== expectedModel,
  );
  const toolError = relevant
    .flatMap(({ parts }) => parts)
    .find((part) => part.type === "tool" && part.state.status === "error");
  return {
    handoff: last.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    usage,
    error: modelMismatch
      ? "Worker used an unexpected model"
      : last.info.error
        ? JSON.stringify(last.info.error)
        : toolError
          ? "Worker reported a tool error; inspect the session before retrying"
          : undefined,
  };
}
