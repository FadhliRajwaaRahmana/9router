/**
 * Unit tests for the provider validation probe-URL resolver.
 *
 * Root cause this pins down: the `default` branch of /api/providers/validate
 * bailed out with "Provider validation not supported" for any provider whose
 * transport format is not exactly "openai" — which includes every
 * `openai-responses` provider (muse/Meta). The dashboard turns that 400 into
 * "Invalid", so a perfectly valid Meta API key looked rejected.
 *
 * It also guessed `{baseUrl}/models` by string surgery, which for muse
 * (baseUrl = https://api.meta.ai/v1/responses) produced
 * https://api.meta.ai/v1/responses — a POST-only endpoint that answers GET
 * with 405. The registry already carries the right URL in `validateUrl`.
 */

import { describe, it, expect } from "vitest";
import { resolveValidateProbeUrl, isValidationSupported } from "open-sse/services/providerValidateProbe.js";

describe("resolveValidateProbeUrl", () => {
  it("pakai validateUrl dari registry bila ada (muse -> /v1/models)", () => {
    const cfg = {
      baseUrl: "https://api.meta.ai/v1/responses",
      format: "openai-responses",
      validateUrl: "https://api.meta.ai/v1/models",
    };
    expect(resolveValidateProbeUrl(cfg)).toBe("https://api.meta.ai/v1/models");
  });

  it("tidak menebak /responses menjadi /models (itu POST-only, GET 405)", () => {
    const cfg = { baseUrl: "https://api.meta.ai/v1/responses", format: "openai-responses" };
    expect(resolveValidateProbeUrl(cfg)).not.toBe("https://api.meta.ai/v1/responses");
  });

  it("tetap menurunkan /models dari baseUrl chat/completions", () => {
    const cfg = { baseUrl: "https://api.example.com/v1/chat/completions", format: "openai" };
    expect(resolveValidateProbeUrl(cfg)).toBe("https://api.example.com/v1/models");
  });

  it("menghapus akhiran /chatbot", () => {
    const cfg = { baseUrl: "https://api.example.com/v1/chatbot", format: "openai" };
    expect(resolveValidateProbeUrl(cfg)).toBe("https://api.example.com/v1/models");
  });

  it("menambahkan /models polos bila baseUrl bukan endpoint lengkap", () => {
    const cfg = { baseUrl: "https://api.example.com/v1", format: "openai" };
    expect(resolveValidateProbeUrl(cfg)).toBe("https://api.example.com/v1/models");
  });

  it("kembalikan null bila cfg tidak punya baseUrl", () => {
    expect(resolveValidateProbeUrl({ format: "openai" })).toBeNull();
  });
});

describe("isValidationSupported", () => {
  it("dukung provider openai-responses yang punya validateUrl (kasus muse)", () => {
    const cfg = {
      baseUrl: "https://api.meta.ai/v1/responses",
      format: "openai-responses",
      validateUrl: "https://api.meta.ai/v1/models",
    };
    expect(isValidationSupported(cfg)).toBe(true);
  });

  it("dukung provider openai biasa", () => {
    expect(isValidationSupported({ baseUrl: "https://api.example.com/v1", format: "openai" })).toBe(true);
  });

  it("tolak provider tanpa baseUrl", () => {
    expect(isValidationSupported({ format: "openai" })).toBe(false);
  });

  it("tolak cfg kosong", () => {
    expect(isValidationSupported(null)).toBe(false);
    expect(isValidationSupported(undefined)).toBe(false);
  });
});
