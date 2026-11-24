// Fable 5.2 menolak thinking.type "enabled"/budget_tokens dengan 400; model ini
// adaptive-only dan mengatur kedalaman lewat output_config.effort. Tanpa entri
// exact, id jatuh ke pola `*claude*fable*` -> claude-budget (bug produksi 24 Nov).
import { describe, expect, it } from "vitest";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";

const IDS = ["claude-fable-5-2", "claude-fable-5.2"];

describe("Claude Fable 5.2 capabilities", () => {
  for (const id of IDS) {
    it(`${id}: adaptive, tidak bisa disable, forced tool choice dimatikan`, () => {
      expect(getCapabilitiesForModel("cc", id)).toMatchObject({
        thinkingFormat: "claude-adaptive",
        thinkingCanDisable: false,
        forcedToolChoice: false,
        contextWindow: 1000000,
        maxOutput: 128000,
      });
    });
  }

  // Ejaan lain (tanpa prefix claude-) tidak boleh ikut terkena — planet
  // "fable-5-2" bukan model Claude dan tidak punya aturan Anthropic.
  it("id non-Claude tidak ikut diubah", () => {
    expect(getCapabilitiesForModel("cc", "fable-5-2").thinkingFormat).toBeFalsy();
  });
});

describe("normalizeClaudePassthrough — Fable 5.2", () => {
  for (const id of IDS) {
    it(`${id}: enabled+budget dari Claude Code jadi adaptive+effort`, () => {
      const body = {
        model: id,
        thinking: { type: "enabled", budget_tokens: 10000, display: "summarized" },
        tool_choice: { type: "any" },
        messages: [{ role: "user", content: "halo" }],
      };
      normalizeClaudePassthrough(body, id, "cc");

      expect(body.thinking).toMatchObject({ type: "adaptive", display: "summarized" });
      expect(body.thinking.budget_tokens).toBeUndefined();
      expect(body.output_config).toEqual({ effort: "medium" });
      expect(body.tool_choice).toEqual({ type: "auto" });
    });

    it(`${id}: adaptive+effort dari klien sudah benar tetap utuh`, () => {
      const body = {
        model: id,
        thinking: { type: "adaptive" },
        output_config: { effort: "high" },
        messages: [{ role: "user", content: "halo" }],
      };
      normalizeClaudePassthrough(body, id, "cc");

      expect(body.thinking).toEqual({ type: "adaptive" });
      expect(body.output_config).toEqual({ effort: "high" });
    });
  }
});
