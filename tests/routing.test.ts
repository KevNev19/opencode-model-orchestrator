import assert from "node:assert/strict";
import { test } from "node:test";
import { configSchema, selectModel } from "../src/config.js";

test("routes only to configured connected models and prefers an independent reviewer", () => {
  const config = configSchema.parse({
    routes: {
      explore: { models: ["local/fast"] },
      implement: { models: ["remote/coder", "local/fast"] },
      review: { models: ["local/fast", "remote/coder"], preferDifferent: true },
    },
  });
  const models = [
    { id: "local/fast", connected: true, tools: true },
    { id: "remote/coder", connected: true, tools: true },
  ];
  assert.equal(selectModel(config, "review", "local/fast", models).model, "remote/coder");
  const remote = models[1];
  assert.ok(remote);
  remote.connected = false;
  assert.equal(selectModel(config, "implement", "local/fast", models).model, "local/fast");
  assert.throws(() => selectModel(config, "explore", "local/fast", []), /No connected/);
});
