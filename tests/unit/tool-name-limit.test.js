import { describe, it, expect } from "vitest";
import { shortenToolName, shortenToolNamesInBody } from "open-sse/utils/toolNameLimit.js";

const LONG = "mcp__aiven__aiven_vcs_integration_repository_container_manifest_files_list";

describe("toolNameLimit", () => {
  it("memendekkan ke <= batas dan deterministik", () => {
    const a = shortenToolName(LONG, 64);
    const b = shortenToolName(LONG, 64);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).toBe(b);
    expect(a.startsWith("mcp__aiven__")).toBe(true);
  });
  it("tidak mengubah nama yang sudah pendek", () => {
    expect(shortenToolName("Read", 64)).toBeNull();
  });
  it("nama panjang berbeda tidak bertabrakan", () => {
    const x = shortenToolName(LONG, 64);
    const y = shortenToolName(LONG + "_x", 64);
    expect(x).not.toBe(y);
  });
  it("mengganti nama di tools[] dan mengembalikan map", () => {
    const body = { tools: [{ type: "function", function: { name: LONG, parameters: {} } }] };
    const map = shortenToolNamesInBody(body, 64);
    expect(map.size).toBe(1);
    expect(body.tools[0].function.name.length).toBeLessThanOrEqual(64);
    expect([...map.values()][0]).toBe(LONG);
  });
  it("tool_choice ikut diganti", () => {
    const body = { tools: [{ type: "function", function: { name: LONG } }],
                   tool_choice: { type: "function", function: { name: LONG } } };
    shortenToolNamesInBody(body, 64);
    expect(body.tool_choice.function.name).toBe(body.tools[0].function.name);
  });
});

describe("integrasi translator openai-responses", () => {
  // Translator sendiri hanya memotong di 128 (batas Responses API), jadi nama
  // 74 char lolos apa adanya. Pemendekan ke 64 dilakukan DefaultExecutor
  // SEBELUM translator, sehingga nama sudah pendek saat sampai di sini.
  it("nama <=128 dibiarkan utuh (pemendekan terjadi di executor)", async () => {
    const { openaiToOpenAIResponsesRequest } = await import(
      "open-sse/translator/request/openai-responses.js"
    );
    const LONG = "mcp__aiven__aiven_vcs_integration_repository_container_manifest_files_list";
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: LONG, description: "d",
                parameters: { type: "object", properties: {} } } }],
    };
    const out = openaiToOpenAIResponsesRequest("muse-spark-1.3", body, true, {});
    expect(out.tools[0].name).toBe(LONG);
    expect(out._toolNameMap).toBeUndefined();
  }, 20000);

  it("nama >128 dipendekkan DAN dipetakan", async () => {
    const { openaiToOpenAIResponsesRequest } = await import(
      "open-sse/translator/request/openai-responses.js"
    );
    const HUGE = "mcp__x__" + "a".repeat(200);
    const body = {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: HUGE, description: "d",
                parameters: { type: "object", properties: {} } } }],
    };
    const out = openaiToOpenAIResponsesRequest("muse-spark-1.3", body, true, {});
    expect(out.tools[0].name.length).toBeLessThanOrEqual(128);
    expect(out._toolNameMap.get(out.tools[0].name)).toBe(HUGE);
  }, 20000);
});
