import { describe, it, expect, vi, beforeEach } from "vitest";

const proxyAwareFetch = vi.fn(async (url) => ({
  ok: true,
  status: 200,
  json: async () => url.includes(":loadCodeAssist")
    ? { cloudaicompanionProject: "project-1", currentTier: { name: "Pro" }, paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } }
    : url.includes(":retrieveUserQuotaSummary")
      ? { groups: [] }
      : { models: {} },
  text: async () => "{}",
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch,
}));

describe("Antigravity usage headers", () => {
  beforeEach(() => proxyAwareFetch.mockClear());

  it("uses the official IDE user agent and omits router-only source headers", async () => {
    const { getAntigravityUsage } = await import("../../open-sse/services/usage/google.js");

    await getAntigravityUsage("access-token", {});

    // loadCodeAssist + fetchAvailableModels + retrieveUserQuotaSummary
    expect(proxyAwareFetch).toHaveBeenCalledTimes(3);
    // Ambil UA dari sumbernya, jangan hardcode versi — fingerprint IDE
    // sengaja dinaikkan mengikuti rilis Antigravity (lihat providers/shared.js),
    // dan test yang mengunci string mentah akan usang di tiap bump.
    const { ANTIGRAVITY_IDE_USER_AGENT } =
      await import("../../open-sse/providers/shared.js");
    for (const [, options] of proxyAwareFetch.mock.calls) {
      expect(options.headers["User-Agent"]).toBe(ANTIGRAVITY_IDE_USER_AGENT);
      expect(options.headers).not.toHaveProperty("x-request-source");
    }
  });
});
