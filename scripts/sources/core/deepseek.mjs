/**
 * Minimal DeepSeek client for structured extraction, Anthropic-compatible Messages API.
 * Mirrors lib/ai/anthropic.ts (base URL https://api.deepseek.com/anthropic, model `deepseek-flash`).
 *
 * Verified quirks (see lib/ai/anthropic.ts and scraper/llm_client.py):
 *   - forcing `tool_choice: {type:"tool"}` requires `thinking: {type:"disabled"}` (else HTTP 400);
 *   - `output_config.format` json_schema is silently ignored, so structured output goes through a forced tool;
 *   - run calls sequentially (callers loop; this module never fires requests in parallel).
 *
 * Spend is tracked per budget object and capped; callTool refuses a call that could exceed the cap
 * (worst case = estimated input + max_tokens of output).
 *
 * Never during DeepSeek's peak hours (double price): 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri,
 * per https://api-docs.deepseek.com/quick_start/pricing. callTool refuses with reason
 * "deepseek_peak_hours". Same windows as scraper/deepseek_hours.py; change both together.
 */

export const DEEPSEEK_URL = "https://api.deepseek.com/anthropic/v1/messages";
export const DEEPSEEK_MODEL = "deepseek-flash";
// USD per million tokens (deepseek-flash list price, as given for this project). Update here if pricing changes.
export const INPUT_USD_PER_M = 0.28;
export const OUTPUT_USD_PER_M = 0.42;
export const DEFAULT_MAX_SPEND_USD = 0.1;
export const REQUEST_TIMEOUT_MS = 120_000;
export const PEAK_HOURS_UTC = [[1, 4], [6, 10]]; // [start, end) hours, Monday-Friday

export function inPeak(now = new Date()) {
  const day = now.getUTCDay(); // 0 Sunday, 6 Saturday
  if (day === 0 || day === 6) return false;
  const hour = now.getUTCHours();
  return PEAK_HOURS_UTC.some(([start, end]) => start <= hour && hour < end);
}

export function costUsd(inputTokens, outputTokens) {
  return (inputTokens * INPUT_USD_PER_M + outputTokens * OUTPUT_USD_PER_M) / 1_000_000;
}

/** Rough token estimate (~3.2 chars/token is pessimistic for English + markup). */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 3.2);
}

export function createBudget(maxUsd = DEFAULT_MAX_SPEND_USD) {
  return { maxUsd, inputTokens: 0, outputTokens: 0, calls: 0, spentUsd: 0 };
}

function addUsage(budget, usage) {
  const i = Number(usage?.input_tokens ?? 0);
  const o = Number(usage?.output_tokens ?? 0);
  budget.inputTokens += i;
  budget.outputTokens += o;
  budget.calls += 1;
  budget.spentUsd = costUsd(budget.inputTokens, budget.outputTokens);
}

/**
 * One forced-tool call. `tool` = { name, description, input_schema }.
 * Returns { ok:true, input, usage } or { ok:false, reason }. Never throws.
 * `fetchImpl`, `apiKey` and `now` are injectable for tests.
 */
export async function callTool({ system, user, tool, maxTokens = 4096, budget, apiKey = process.env.DEEPSEEK_API_KEY, fetchImpl = fetch, now = new Date() }) {
  if (!apiKey) return { ok: false, reason: "no_api_key" };
  if (inPeak(now)) return { ok: false, reason: "deepseek_peak_hours" };
  const worstCase = costUsd(estimateTokens(system) + estimateTokens(user) + 200, maxTokens);
  if (budget.spentUsd + worstCase > budget.maxUsd) return { ok: false, reason: "budget_exhausted" };

  const body = {
    model: DEEPSEEK_MODEL,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
    system,
    messages: [{ role: "user", content: user }],
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetchImpl(DEEPSEEK_URL, {
        method: "POST",
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 3000));
          continue;
        }
        return { ok: false, reason: `HTTP ${res.status}` };
      }
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
      const json = await res.json();
      addUsage(budget, json.usage);
      const block = (json.content ?? []).find((b) => b.type === "tool_use" && b.name === tool.name);
      if (!block || typeof block.input !== "object" || block.input == null) {
        return { ok: false, reason: `no tool_use block (stop_reason=${json.stop_reason ?? "?"})`, usage: json.usage };
      }
      return { ok: true, input: block.input, usage: json.usage, stopReason: json.stop_reason };
    } catch (err) {
      if (attempt === 1) return { ok: false, reason: err?.name === "AbortError" ? "timed out" : `network error: ${err.message}` };
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: "failed" };
}
