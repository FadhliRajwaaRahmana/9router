import { describe, expect, it } from "vitest";

import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";
import "../translator/registerAll.js";

// Provider `anthropic` (API key langsung ke api.anthropic.com) tidak punya
// override untuk Claude 5.5, jadi claude-haiku-5-5 jatuh ke pola umum
// *claude*haiku* -> "claude-budget". Itu mengirim thinking.type "enabled",
// yang ditolak mentah-mentah oleh modelnya (HTTP 400 live):
//   "thinking.type.enabled" is not supported for this model.
//   Use "thinking.type.adaptive" and "output_config.effort" ...
// Provider lain yang native Anthropic (opencode-go, github, commandcode)
// sudah punya override claude-adaptive; provider aslinya sendiri terlewat.
function viaAnthropic(model, body) {
  const openai = translateRequest(FORMATS.CLAUDE, FORMATS.OPENAI, model, structuredClone(body), body.stream ?? true, null, "anthropic");
  delete openai._toolNameMap;
  delete openai._customToolNames;
  openai.model = model;
  const claude = translateRequest(FORMATS.OPENAI, FORMATS.CLAUDE, model, openai, true, null, "anthropic");
  delete claude._toolNameMap;
  return claude;
}

const classifierRequest = {
  max_tokens: 4096,
  stream: false,
  thinking: { type: "disabled" },
  system: [{ type: "text", text: "You are a security monitor." }],
  messages: [{ role: "user", content: "Evaluate the last action." }],
};

const mainLoopRequest = {
  max_tokens: 32000,
  stream: true,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort: "high" },
  tools: [{ name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  messages: [{ role: "user", content: "list files" }],
};

describe("anthropic provider: Claude 5.5 memakai aturan thinking 5.5", () => {
  it("claude-haiku-5-5: adaptive, bukan budget", () => {
    expect(getCapabilitiesForModel("anthropic", "claude-haiku-5-5")).toMatchObject({
      thinkingFormat: "claude-adaptive",
    });
    expect(getThinkingLevels("anthropic", "claude-haiku-5-5")).toContain("high");
  });

  it("claude-haiku-5-5: loop utama kirim adaptive + effort, bukan budget", () => {
    const out = viaAnthropic("claude-haiku-5-5", mainLoopRequest);
    expect(out.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(out.output_config).toEqual({ effort: "high" });
  });

  it("claude-haiku-4-5 tetap budget (menolak adaptive)", () => {
    const out = viaAnthropic("claude-haiku-4.5", mainLoopRequest);
    expect(out.thinking?.type).toBe("enabled");
    expect(out.thinking?.budget_tokens).toBeGreaterThan(0);
  });
});
