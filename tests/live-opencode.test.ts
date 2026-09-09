import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { Store } from "../src/store.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No TCP port");
  return address.port;
}

for (const scenario of ["success", "parent-read-deny"]) {
  test(`real OpenCode integration: ${scenario}`, {
    skip: !process.env.OPENCODE_TEST_BINARY,
    timeout: 120000,
  }, async (t) => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "orchestrator-live-")));
    const root = join(base, "project");
    mkdirSync(root);
    t.after(() => rmSync(base, { recursive: true, force: true }));
    writeFileSync(join(root, "value.mjs"), "export const value = 1;\n");
    writeFileSync(join(root, "secret.txt"), "private fixture content");
    const models: string[] = [];
    const advertisedTools: string[][] = [];
    let coordinatorRequests = 0;
    let workerRequests = 0;
    const modelServer = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          model: string;
          messages: Array<{ role: string; content: unknown }>;
          tools?: Array<{ function: { name: string } }>;
        };
        models.push(body.model);
        advertisedTools.push(body.tools?.map((entry) => entry.function.name) ?? []);
        let call: { name: string; args: Record<string, unknown> } | undefined;
        if (
          body.model === "coordinator" &&
          body.tools?.some((entry) => entry.function.name === "orchestrator_delegate")
        ) {
          coordinatorRequests++;
          const task = new Store(root).list()[0];
          if (coordinatorRequests === 1)
            call = {
              name: "orchestrator_delegate",
              args: {
                key: "live-change",
                role: "implement",
                outcome: "Set value to 2",
                acceptance: ["value exports 2"],
                files: ["value.mjs"],
                checks: ["value"],
              },
            };
          else if (coordinatorRequests === 2 && task)
            call = { name: "orchestrator_verify", args: { id: task.id } };
          else if (coordinatorRequests === 3 && task)
            call = {
              name: "orchestrator_accept",
              args: {
                id: task.id,
                evidence: "The real node assertion verified that value equals 2.",
              },
            };
        } else if (body.model === "coder") {
          workerRequests++;
          if (workerRequests === 1)
            call =
              scenario === "parent-read-deny"
                ? { name: "read", args: { filePath: join(root, "secret.txt") } }
                : {
                    name: "write",
                    args: {
                      filePath: join(root, "value.mjs"),
                      content: "export const value = 2;\n",
                    },
                  };
        }
        const responseID = `chatcmpl-${models.length}`;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (delta: unknown, finish: string | null) =>
          res.write(
            `data: ${JSON.stringify({ id: responseID, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        if (call)
          send(
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${models.length}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.args) },
                },
              ],
            },
            null,
          );
        else
          send(
            {
              role: "assistant",
              content:
                body.model === "coder"
                  ? "Changed value.mjs to export 2. Coordinator must verify it."
                  : "The requested change has been verified and accepted.",
            },
            null,
          );
        send({}, call ? "tool_calls" : "stop");
        res.write(
          `data: ${JSON.stringify({ id: responseID, object: "chat.completion.chunk", created: 0, model: body.model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`,
        );
        res.end("data: [DONE]\n\n");
      } catch (error) {
        res.writeHead(500);
        res.end(String(error));
      }
    });
    const modelPort = await listen(modelServer);
    t.after(() => {
      modelServer.closeAllConnections();
      modelServer.close();
    });
    const reservation = createServer();
    const port = await listen(reservation);
    await new Promise<void>((done) => reservation.close(() => done()));
    writeFileSync(
      join(root, "orchestrator.json"),
      JSON.stringify({
        routes: {
          explore: { models: ["fixture/coder"] },
          implement: { models: ["fixture/coder"] },
          review: { models: ["fixture/coder"] },
        },
        checks: {
          value: [
            process.execPath,
            "--input-type=module",
            "-e",
            "import {value} from './value.mjs'; if(value !== 2) process.exit(1)",
          ],
        },
      }),
    );
    writeFileSync(
      join(root, "opencode.json"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(resolve("dist/plugin.js")).href],
        model: "fixture/coordinator",
        small_model: "fixture/coordinator",
        permission: "allow",
        ...(scenario === "parent-read-deny"
          ? { agent: { build: { permission: { read: { "*": "allow", "*secret*": "deny" } } } } }
          : {}),
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Local test fixture",
            options: { baseURL: `http://127.0.0.1:${modelPort}/v1`, apiKey: "local-test-only" },
            models: {
              coordinator: {
                name: "coordinator",
                tool_call: true,
                limit: { context: 32000, output: 4000 },
              },
              coder: { name: "coder", tool_call: true, limit: { context: 32000, output: 4000 } },
            },
          },
        },
      }),
    );
    const runtime = spawn(
      process.env.OPENCODE_TEST_BINARY ?? "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: root,
        env: {
          ...process.env,
          OPENCODE_SERVER_PASSWORD: "",
          OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
          XDG_CONFIG_HOME: join(base, "runtime-config"),
          XDG_DATA_HOME: join(base, "runtime-data"),
          XDG_CACHE_HOME: join(base, "runtime-cache"),
          XDG_STATE_HOME: join(base, "runtime-state"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let logs = "";
    runtime.stdout.on("data", (chunk) => {
      logs += chunk.toString();
    });
    runtime.stderr.on("data", (chunk) => {
      logs += chunk.toString();
    });
    t.after(async () => {
      runtime.kill("SIGTERM");
      if (runtime.exitCode === null)
        await Promise.race([
          new Promise<void>((done) => runtime.once("exit", () => done())),
          delay(3000).then(() => {
            runtime.kill("SIGKILL");
          }),
        ]);
    });
    const url = `http://127.0.0.1:${port}`;
    for (let count = 0; count < 100; count++) {
      try {
        if ((await fetch(`${url}/global/health`)).ok) break;
      } catch {
        /* Server startup may take several seconds. */
      }
      if (runtime.exitCode !== null) throw new Error(`OpenCode exited: ${logs}`);
      await delay(200);
    }
    const client = createOpencodeClient({ baseUrl: url, directory: root });
    const session = await client.session.create({
      body: { title: "Local orchestration integration" },
    });
    assert.ok(session.data, JSON.stringify(session.error) + logs);
    const reply = await client.session.prompt({
      path: { id: session.data.id },
      body: {
        model: { providerID: "fixture", modelID: "coordinator" },
        agent: "build",
        parts: [
          { type: "text", text: "Set value to 2. Delegate, verify and accept the assignment." },
        ],
      },
      signal: AbortSignal.timeout(80000),
    });
    assert.ok(reply.data, JSON.stringify(reply.error) + logs);
    const tasks = new Store(root).list();
    const history = await client.session.messages({ path: { id: session.data.id } });
    assert.equal(
      tasks.length,
      1,
      JSON.stringify({ history: history.data, logs, models, advertisedTools }),
    );
    assert.equal(
      tasks[0]?.status,
      scenario === "success" ? "accepted" : "failed",
      JSON.stringify({ tasks, logs, reply: reply.data }, null, 2),
    );
    assert.equal(tasks[0]?.model, "fixture/coder");
    assert.equal(
      readFileSync(join(root, "value.mjs"), "utf8"),
      scenario === "success" ? "export const value = 2;\n" : "export const value = 1;\n",
    );
    assert.ok(models.includes("coordinator") && models.includes("coder"));
  });
}
