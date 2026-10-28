import { describe, it, expect } from "vitest";

// Floor dipasang di DefaultExecutor.transformRequest (tidak diekspor), jadi uji
// lewat jalur publik: buat executor muse, panggil transformRequest, periksa body.
// Kredensial dummy cukup karena floor tidak menyentuh network.
import { DefaultExecutor } from "open-sse/executors/default.js";
import { META_MAX_EFFORT_FLOOR } from "open-sse/config/runtimeConfig.js";

const DUMMY_CREDS = { apiKey: "test", providerSpecificData: {} };

function run(provider, body) {
  const ex = new DefaultExecutor(provider);
  // transformRequest(model, body, stream, credentials)
  return ex.transformRequest("muse-spark-1.3", { ...body }, true, DUMMY_CREDS);
}

describe("floor budget effort max Meta (muse)", () => {
  it("max + budget kecil dinaikkan ke floor", () => {
    const out = run("muse", {
      reasoning: { effort: "max" },
      max_tokens: 2048,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBe(META_MAX_EFFORT_FLOOR);
    expect(META_MAX_EFFORT_FLOOR).toBe(8192);
  });

  it("max + budget besar tidak diturunkan", () => {
    const out = run("muse", {
      reasoning: { effort: "max" },
      max_tokens: 64000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBe(64000);
  });

  it("xhigh tidak tersentuh walau budget kecil", () => {
    const out = run("muse", {
      reasoning: { effort: "xhigh" },
      max_tokens: 200,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBe(200);
  });

  it("tanpa effort tidak tersentuh", () => {
    const out = run("muse", {
      max_tokens: 200,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBe(200);
  });

  it("tanpa budget eksplisit tidak tersentuh", () => {
    const out = run("muse", {
      reasoning: { effort: "max" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.max_tokens).toBeUndefined();
    expect(out.max_output_tokens).toBeUndefined();
    expect(out.max_completion_tokens).toBeUndefined();
  });

  it("provider lain tidak tersentuh walau effort max", () => {
    const ex = new DefaultExecutor("codebuddy-intl");
    const out = ex.transformRequest(
      "deepseek-v4",
      { reasoning_effort: "max", max_tokens: 200, messages: [{ role: "user", content: "hi" }] },
      true,
      DUMMY_CREDS
    );
    expect(out.max_tokens).toBe(200);
  });
});
