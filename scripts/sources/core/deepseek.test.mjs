import { test } from "node:test";
import assert from "node:assert/strict";
import { callTool, costUsd, createBudget } from "./deepseek.mjs";

const TOOL = { name: "submit", description: "d", input_schema: { type: "object", properties: {} } };

function fakeFetch(json, status = 200, seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) };
  };
}

test("costUsd uses $0.28/M input and $0.42/M output", () => {
  assert.ok(Math.abs(costUsd(1_000_000, 1_000_000) - 0.7) < 1e-9);
});

test("callTool sends a forced tool with thinking disabled and tracks usage", async () => {
  const seen = [];
  const budget = createBudget(0.1);
  const r = await callTool({
    system: "s",
    user: "u",
    tool: TOOL,
    budget,
    apiKey: "k",
    fetchImpl: fakeFetch({ content: [{ type: "tool_use", name: "submit", input: { gigs: [1] } }], usage: { input_tokens: 1000, output_tokens: 200 }, stop_reason: "tool_use" }, 200, seen),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.input, { gigs: [1] });
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.tool_choice, { type: "tool", name: "submit" });
  assert.equal(body.model, "deepseek-flash");
  assert.equal(seen[0].init.headers["x-api-key"], "k");
  assert.equal(budget.calls, 1);
  assert.equal(budget.inputTokens, 1000);
  assert.ok(budget.spentUsd > 0);
});

test("callTool refuses a call that could blow the budget, and without a key", async () => {
  const budget = createBudget(0.0001);
  const r = await callTool({ system: "s", user: "u".repeat(100_000), tool: TOOL, budget, apiKey: "k", fetchImpl: fakeFetch({}) });
  assert.deepEqual(r, { ok: false, reason: "budget_exhausted" });
  const r2 = await callTool({ system: "s", user: "u", tool: TOOL, budget: createBudget(), apiKey: "", fetchImpl: fakeFetch({}) });
  assert.equal(r2.reason, "no_api_key");
});

test("callTool reports a response without the tool_use block", async () => {
  const r = await callTool({ system: "s", user: "u", tool: TOOL, budget: createBudget(), apiKey: "k", fetchImpl: fakeFetch({ content: [{ type: "text", text: "hi" }], usage: {} }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no tool_use/);
});
