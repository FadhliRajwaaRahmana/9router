import { describe, expect, it } from "vitest";

import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";

// Jalur PASSTHROUGH (clientTool "claude" -> provider anthropic/claude) tidak lewat
// translateRequest, jadi capability resolver tidak pernah dipakai. Normalizer di
// claude.js yang harus tahu aturan per-model.
//
// Live: Anthropic menolak thinking.type "enabled" untuk keluarga 5.5 —
//   HTTP 400: "thinking.type.enabled" is not supported for this model.
//   Use "thinking.type.adaptive" and "output_config.effort".
// Sementara Claude Code justru mengirim {type:"enabled", budget_tokens:10000}
// (log server: THINK:10k), sehingga pola lama `/haiku/i` yang memaksakan bentuk
// budget untuk SEMUA haiku malah membuat setiap request 400.
const claudeCodeBody = () => ({
  model: "claude-haiku-5-5",
  max_tokens: 32000,
  stream: true,
  thinking: { type: "enabled", budget_tokens: 10000, display: "summarized" },
  messages: [{ role: "user", content: "list files" }],
});

describe("normalizeClaudePassthrough — thinking adaptive-only", () => {
  it("claude-haiku-5-5: enabled+budget dari Claude Code diubah ke adaptive+effort", () => {
    const body = claudeCodeBody();
    normalizeClaudePassthrough(body, "claude-haiku-5-5", "anthropic");

    expect(body.thinking.type).toBe("adaptive");
    expect(body.thinking.budget_tokens).toBeUndefined();
    expect(body.thinking.display).toBe("summarized");
    expect(body.output_config).toEqual({ effort: "medium" });
  });

  it("claude-haiku-5.5 (titik, jalur OAuth claude) juga adaptive", () => {
    const body = claudeCodeBody();
    body.model = "claude-haiku-5.5";
    normalizeClaudePassthrough(body, "claude-haiku-5.5", "claude");

    expect(body.thinking.type).toBe("adaptive");
    expect(body.output_config.effort).toBe("medium");
  });

  it("budget besar dipetakan ke effort tinggi, bukan selalu medium", () => {
    const body = claudeCodeBody();
    body.thinking.budget_tokens = 32000;
    normalizeClaudePassthrough(body, "claude-haiku-5-5", "anthropic");

    expect(body.output_config.effort).toBe("xhigh");
  });

  it("tanpa budget: tetap adaptive, tanpa effort karangan", () => {
    const body = claudeCodeBody();
    delete body.thinking.budget_tokens;
    normalizeClaudePassthrough(body, "claude-haiku-5-5", "anthropic");

    expect(body.thinking.type).toBe("adaptive");
    expect(body.output_config).toBeUndefined();
  });

  it("Claude Code sudah mengirim adaptive: effort dipertahankan apa adanya", () => {
    const body = claudeCodeBody();
    body.thinking = { type: "adaptive", display: "summarized" };
    body.output_config = { effort: "high" };
    normalizeClaudePassthrough(body, "claude-haiku-5-5", "anthropic");

    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.output_config).toEqual({ effort: "high" });
  });

  it("claude-haiku-4.5 tetap bentuk budget (menolak adaptive)", () => {
    const body = claudeCodeBody();
    body.model = "claude-haiku-4.5";
    body.thinking = { type: "adaptive" };
    body.output_config = { effort: "high" };
    normalizeClaudePassthrough(body, "claude-haiku-4.5", "anthropic");

    expect(body.thinking.type).toBe("enabled");
    expect(body.thinking.budget_tokens).toBeGreaterThan(0);
    expect(body.output_config).toBeUndefined();
  });

  it("model non-adaptive (claude-opus-4.5) tidak diubah", () => {
    const body = claudeCodeBody();
    body.model = "claude-opus-4-5";
    normalizeClaudePassthrough(body, "claude-opus-4-5", "anthropic");

    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 10000, display: "summarized" });
    expect(body.output_config).toBeUndefined();
  });

  it("thinking disabled tidak diubah", () => {
    const body = claudeCodeBody();
    body.thinking = { type: "disabled" };
    normalizeClaudePassthrough(body, "claude-haiku-5-5", "anthropic");

    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.output_config).toBeUndefined();
  });
});
