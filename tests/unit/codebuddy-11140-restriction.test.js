/**
 * Regression: 11140 (account restricted) must NOT be treated like 11128 (channel check).
 *
 * Root causes pinned (live, 2026-10-28):
 *  1. errorConfig.js matched text "request illegal" for BOTH 11128 and 11140,
 *     giving a restricted account a 15s cooldown — the router then hammered the
 *     restricted account every 15s across every model, which is exactly the
 *     "unusual activity" pattern that deepens the restriction.
 *  2. OAuth userAgent (2.63.2) mismatched the chat UA (2.108.1); a mixed-version
 *     client is trivially detectable.
 */
import { describe, it, expect } from "vitest";
import { ERROR_RULES } from "../../open-sse/config/errorConfig.js";
import { PROVIDERS, PROVIDER_OAUTH } from "../../open-sse/config/providers.js";

function cooldownFor({ provider, message }) {
  for (const rule of ERROR_RULES) {
    if (rule.provider && rule.provider !== provider) continue;
    if (rule.text && !message.toLowerCase().includes(rule.text.toLowerCase())) continue;
    if (rule.status) continue;
    return rule;
  }
  return null;
}

describe("11140 account restriction vs 11128 channel check", () => {
  const MSG_11140 = "Your account has been restricted due to unusual activity (code 11140)";
  const MSG_11128 = "Request blocked channel verification (code 11128)";

  it("11140 mendapat cooldown panjang (>= 1 jam), BUKAN 15 detik", () => {
    const rule = cooldownFor({ provider: "codebuddy-intl", message: MSG_11140 });
    expect(rule).not.toBeNull();
    expect(rule.cooldownMs).toBeGreaterThanOrEqual(60 * 60 * 1000);
  });

  it("11128 tetap cooldown pendek (15 detik)", () => {
    const rule = cooldownFor({ provider: "codebuddy-intl", message: MSG_11128 });
    expect(rule).not.toBeNull();
    expect(rule.cooldownMs).toBe(15 * 1000);
  });

  it("aturan 11140 menang atas aturan generik 'request illegal'", () => {
    const rule = cooldownFor({ provider: "codebuddy-intl", message: MSG_11140 });
    // "request illegal" generik memberi 15s; kalau rule ini yang menang, fix gagal.
    expect(rule.cooldownMs).not.toBe(15 * 1000);
  });

  it("versi OAuth sama dengan versi chat (tidak campuran)", () => {
    const built = PROVIDERS["codebuddy-intl"] || {};
    const chatUA = built.headers?.["User-Agent"] || built.transport?.headers?.["User-Agent"] || "";
    const oauthUA = built.oauth?.userAgent || PROVIDER_OAUTH?.["codebuddy-intl"]?.userAgent || "";
    const chatVer = String(chatUA).match(/(\d+\.\d+\.\d+)/)?.[1];
    const oauthVer = String(oauthUA).match(/(\d+\.\d+\.\d+)/)?.[1];
    expect(chatVer).toBeTruthy();
    expect(oauthVer).toBe(chatVer);
  });
});
