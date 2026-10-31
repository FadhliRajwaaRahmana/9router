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

  // Setelah tool bernama panjang dipanggil sekali, klien me-replay panggilan
  // itu dengan ejaannya sendiri (panjang). Meta juga memvalidasi nama di
  // riwayat — terukur 400 `name must be at most 64 characters, got 74` — jadi
  // seluruh sesi gagal mulai giliran itu kalau riwayat tidak ikut dipendekkan.
  it("nama di riwayat function_call (Responses) ikut dipendekkan, sama dengan deklarasi", () => {
    const body = {
      tools: [{ type: "function", name: LONG, parameters: {} }],
      input: [
        { type: "function_call", call_id: "c1", name: LONG, arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "[]" },
      ],
    };
    shortenToolNamesInBody(body, 64);
    expect(body.input[0].name.length).toBeLessThanOrEqual(64);
    expect(body.input[0].name).toBe(body.tools[0].name);
  });

  it("nama di riwayat tool_calls (Chat) dan tool_use (Anthropic) ikut dipendekkan", () => {
    const body = {
      messages: [
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: LONG, arguments: "{}" } }] },
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: LONG, input: {} }] },
      ],
    };
    const map = shortenToolNamesInBody(body, 64);
    const short = shortenToolName(LONG, 64);
    expect(body.messages[0].tool_calls[0].function.name).toBe(short);
    expect(body.messages[1].content[0].name).toBe(short);
    expect(map.get(short)).toBe(LONG);
  });

  it("riwayat bernama pendek tidak disentuh", () => {
    const body = { input: [{ type: "function_call", call_id: "c1", name: "Read", arguments: "{}" }] };
    expect(shortenToolNamesInBody(body, 64)).toBeNull();
    expect(body.input[0].name).toBe("Read");
  });
});

describe("DefaultExecutor muse: riwayat tool bernama panjang", () => {
  it("dipendekkan sebelum dikirim agar Meta tidak menolak 400", async () => {
    const { DefaultExecutor } = await import("open-sse/executors/default.js");
    const body = {
      model: "muse-spark-1.3-contributor",
      tools: [{ type: "function", name: LONG, parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "c1", name: LONG, arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "[]" },
      ],
    };
    const out = new DefaultExecutor("muse").transformRequest("muse-spark-1.3-contributor", body, true, { apiKey: "test" });
    const call = out.input.find((i) => i.type === "function_call");
    expect(call.name.length).toBeLessThanOrEqual(64);
    expect(call.name).toBe(out.tools[0].name);
    expect(out._toolNameMap.get(call.name)).toBe(LONG);
  }, 20000);
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
