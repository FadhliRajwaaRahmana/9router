/**
 * OpenCode Go declares THREE endpoints and the relay validates the thinking
 * shape per ENDPOINT, not per provider (live probe 2026-11-09, one key,
 * deepseek-v4.1-flash):
 *
 *   /zen/go/v1/chat/completions  tolerates BOTH `reasoning_effort` and
 *                                `thinking:{type:"enabled"}` → 200
 *   /zen/go/v1/messages          accepts `thinking:{type:enabled|adaptive|disabled}`
 *                                (200) but answers HTTP 400
 *                                "reasoning_effort: requires a native Anthropic
 *                                Messages target" the moment reasoning_effort
 *                                is present
 *   /zen/go/v1/responses         wants the NESTED `reasoning:{effort}`; a
 *                                top-level reasoning_effort answers 503
 *                                "Upstream request failed: Endpoint is unavailable."
 *
 * capabilities.js describes the *Chat* wire for this family (deepseek →
 * reasoning_effort), so a Claude-shaped client routed to /messages inherited
 * reasoning_effort and 400'd on EVERY turn — including thinking-off, which needs
 * no field at all because `thinking.type:"disabled"` already satisfies it.
 *
 * resolveFormat() already prefers a transport-declared `thinkingFormat` over the
 * capability one, so the fix is to declare the shape on the two transports that
 * constrain it instead of teaching every model a second format.
 *
 * The CHAT transport intentionally keeps NO `thinkingFormat`: that endpoint
 * tolerates both shapes, so each model should keep resolving its own native
 * wire format through capabilities.js (same rationale as tokenharbor.js).
 * Declaring "openai" there would force the OpenAI shape onto qwen
 * (`enable_thinking`) and minimax (`thinking`), which the chat lane presently
 * gets right per model.
 */
import { describe, expect, it } from "vitest";
import { applyThinking } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { PROVIDERS } from "../../open-sse/providers/index.js";

const PROVIDER = "opencode-go";
const MODEL = "deepseek-v4.1-flash";

function transportFor(format) {
  return (PROVIDERS[PROVIDER].transports || []).find((t) => t.format === format);
}

// The relay's own per-endpoint rules, mirrored as assertion helpers.
function assertNoTopLevelEffort(body) {
  expect(body.reasoning_effort).toBeUndefined();
}

describe("OpenCode Go per-transport thinking format", () => {
  it("declares the format on the endpoints that constrain it", () => {
    expect(transportFor("claude")?.thinkingFormat).toBe("claude-adaptive");
    expect(transportFor("openai-responses")?.thinkingFormat).toBe("openai-responses");
    // Chat tolerates everything: resolution stays per model. See the header note.
    expect(transportFor("openai")?.thinkingFormat).toBeUndefined();
  });

  describe("claude wire (/zen/go/v1/messages)", () => {
    it("sends the Anthropic thinking object, never reasoning_effort", () => {
      const body = { model: MODEL, max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 2048 } };
      applyThinking("claude", MODEL, body, PROVIDER);

      assertNoTopLevelEffort(body);
      // Adaptive switch + output_config.effort, not the budget shape: the relay
      // answers 200 to both, but adaptive is the one shape every opencode-go
      // model on this endpoint accepts — claude-haiku-5-5 400s on
      // thinking.type "enabled", and a transport-level format preempts that
      // model's capability override, so the safe shape has to win here.
      expect(body.thinking).toMatchObject({ type: "adaptive" });
      expect(body.output_config?.effort).toBeTruthy();
    });

    it("expresses thinking-off as thinking.type disabled, still without reasoning_effort", () => {
      const body = { model: MODEL, max_tokens: 4096, thinking: { type: "disabled" } };
      applyThinking("claude", MODEL, body, PROVIDER);

      assertNoTopLevelEffort(body);
      expect(body.thinking).toEqual({ type: "disabled" });
    });

    it("keeps the claude shape for a non-deepseek model on the same endpoint", () => {
      const body = { model: "minimax-m3", max_tokens: 4096, thinking: { type: "enabled", budget_tokens: 2048 } };
      applyThinking("claude", "minimax-m3", body, PROVIDER);

      assertNoTopLevelEffort(body);
      // minimax has its own native shape; whichever it is, it must not be a
      // bare OpenAI effort on the Anthropic wire.
      expect(body.thinking || body.output_config).toBeTruthy();
    });
  });

  describe("responses wire (/zen/go/v1/responses)", () => {
    it("nests the effort under reasoning, never at the top level", () => {
      const body = { model: MODEL, input: "hi", max_output_tokens: 4096, reasoning: { effort: "high" } };
      applyThinking("openai-responses", MODEL, body, PROVIDER);

      assertNoTopLevelEffort(body);
      expect(body.reasoning?.effort).toBe("high");
    });
  });

  describe("chat wire (/zen/go/v1/chat/completions)", () => {
    it("still carries reasoning_effort — that endpoint tolerates it", () => {
      const body = { model: MODEL, messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" };
      applyThinking("openai", MODEL, body, PROVIDER);

      expect(body.reasoning_effort).toBe("high");
    });
  });
});
