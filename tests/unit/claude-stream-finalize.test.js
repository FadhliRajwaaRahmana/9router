import { describe, it, expect } from "vitest";
import { createSSETransformStreamWithLogger } from "open-sse/utils/stream.js";
import { closeOpenClaudeBlocks } from "open-sse/utils/stream.js";
import { FORMATS } from "open-sse/translator/formats.js";

const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;

/**
 * Jalankan stream melalui transform SSE.
 * Argumen mengikuti createSSETransformStreamWithLogger:
 *   targetFormat = format UPSTREAM, sourceFormat = format KLIEN.
 */
async function run(targetFormat, sourceFormat, chunks) {
  const stream = createSSETransformStreamWithLogger(
    targetFormat, sourceFormat, "p", null, null, "m", "c", {}, null
  );
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  // Baca paralel sebelum menulis — kalau tidak, writer menunggu backpressure.
  const reading = (async () => {
    const reader = stream.readable.getReader();
    let all = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      all += dec.decode(value);
    }
    return all;
  })();

  const writer = stream.writable.getWriter();
  for (const chunk of chunks) await writer.write(enc.encode(sse(chunk)));
  await writer.close();
  return reading;
}

const count = (s, k) => (s.match(new RegExp(`"${k}"`, "g")) || []).length;

// Upstream menutup koneksi tanpa pernah mengirim finish_reason.
const TRUNCATED = [
  { id: "chatcmpl-abcdefgh1234", model: "m",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: "" } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"file_path":' } }] }, finish_reason: null }] },
];

const NORMAL = [
  { id: "chatcmpl-abcdefgh1234", model: "m",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "Read", arguments: '{"file_path":"a"}' } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
];

describe("penutupan blok Claude saat upstream berakhir tanpa finish_reason", () => {
  it("menutup setiap blok yang terbuka dan mengirim message_stop", async () => {
    const all = await run(FORMATS.OPENAI, FORMATS.CLAUDE, TRUNCATED);

    expect(count(all, "content_block_start")).toBe(1);
    expect(count(all, "content_block_start")).toBe(count(all, "content_block_stop"));
    expect(count(all, "message_stop")).toBe(1);
    // Argumen parsial harus ikut terkirim, bukan input kosong.
    expect(all).toContain("input_json_delta");
  }, 20000);

  it("tidak menggandakan penutupan pada stream yang normal", async () => {
    const all = await run(FORMATS.OPENAI, FORMATS.CLAUDE, NORMAL);

    expect(count(all, "content_block_start")).toBe(count(all, "content_block_stop"));
    expect(count(all, "message_stop")).toBe(1);
  }, 20000);

  it("tidak menyentuh klien non-Claude", async () => {
    const all = await run(FORMATS.OPENAI, FORMATS.OPENAI, TRUNCATED);
    expect(all).not.toContain("content_block_start");
  }, 20000);
});

describe("closeOpenClaudeBlocks", () => {
  it("mengembalikan urutan event yang sah dan menandai blok sudah ditutup", () => {
    const state = {
      toolCalls: new Map([[0, { id: "call_1", name: "Read", blockIndex: 0 }]]),
      toolArgBuffers: new Map([[0, '{"file_path":']]),
      nextBlockIndex: 1,
      textBlockStarted: false,
      thinkingBlockStarted: false,
    };

    const events = closeOpenClaudeBlocks(state);

    expect(events.map((e) => e.type)).toEqual([
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[1].index).toBe(0);
    expect(state.stoppedToolBlocks.has(0)).toBe(true);
    expect(state.emittedToolArgs.has(0)).toBe(true);
  });

  it("tidak membuka atau menutup apa pun ketika state kosong", () => {
    const events = closeOpenClaudeBlocks({ toolCalls: new Map(), nextBlockIndex: 0 });
    expect(events.map((e) => e.type)).toEqual(["message_delta", "message_stop"]);
  });

  it("aman saat state null", () => {
    expect(closeOpenClaudeBlocks(null)).toEqual([]);
  });
});

describe("closeOpenClaudeBlocks idempoten", () => {
  it("panggilan kedua tidak menutup blok yang sama lagi", () => {
    const state = {
      toolCalls: new Map([[0, { id: "call_1", name: "Read", blockIndex: 0 }]]),
      toolArgBuffers: new Map([[0, '{"a":1}']]),
      nextBlockIndex: 1,
    };
    const first = closeOpenClaudeBlocks(state);
    const second = closeOpenClaudeBlocks(state);

    expect(first.filter((e) => e.type === "content_block_stop")).toHaveLength(1);
    expect(second.filter((e) => e.type === "content_block_stop")).toHaveLength(0);
    expect(second.filter((e) => e.type === "input_json_delta" ||
                                e.delta?.type === "input_json_delta")).toHaveLength(0);
  });
});
