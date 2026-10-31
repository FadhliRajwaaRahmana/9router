/**
 * Muse (Meta Responses API): kembalikan phase "commentary" pada preamble yang
 * di-replay.
 *
 * Akar masalah "berhenti sendiri": Meta menandai teks yang ditulis model
 * SEBELUM tool call dengan `phase: "commentary"`, dan pesan asisten tanpa
 * phase dibaca sebagai jawaban akhir. Claude Code bicara format Anthropic yang
 * tidak punya field phase, jadi setiap preamble ("Saya cek dulu…") sampai ke
 * Meta seolah-olah giliran yang sudah selesai. Di sesi panjang Muse meniru
 * pola itu: mengumumkan langkah berikutnya lalu berhenti tanpa tool call.
 *
 * Diukur pada 4 titik henti asli dari transkrip Claude Code (8 sampel per
 * titik, muse-spark-1.3-contributor): tanpa phase 16/32 balasan berhenti tanpa
 * tool call; dengan phase dipulihkan 10/64.
 */
import { describe, it, expect } from "vitest";
import "../translator/registerAll.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { labelCommentaryPhase } from "../../open-sse/translator/concerns/responsesPhase.js";

const MODEL = "muse-spark-1.3-contributor";

// Bentuk request Claude Code yang sebenarnya (disederhanakan): preamble +
// tool_use, hasil tool, lalu jawaban akhir tanpa tool call.
const CLAUDE_BODY = {
  model: MODEL,
  max_tokens: 32000,
  stream: true,
  system: [{ type: "text", text: "You are a coding agent." }],
  messages: [
    { role: "user", content: "Install dependency lalu jalankan tes." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Saya install dependency dulu." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm install" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "added 12 packages" }] },
    { role: "assistant", content: [{ type: "text", text: "Dependency terpasang." }] },
    { role: "user", content: "lanjut jalankan tes" },
  ],
  tools: [{ name: "Bash", description: "Run a shell command", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
  thinking: { type: "adaptive", display: "omitted" },
  output_config: { effort: "max" },
};

// Jalur produksi: translator claude → openai-responses, lalu executor.
function toUpstream(provider) {
  const creds = { apiKey: "test", providerSpecificData: {} };
  const translated = translateRequest("claude", "openai-responses", MODEL, structuredClone(CLAUDE_BODY), true, creds, provider);
  return new DefaultExecutor(provider).transformRequest(MODEL, translated, true, creds);
}

const assistantMessages = (body) => body.input.filter((i) => i.type === "message" && i.role === "assistant");

describe("muse: phase commentary pada preamble yang di-replay", () => {
  it("preamble sebelum tool call diberi phase commentary", () => {
    const [preamble] = assistantMessages(toUpstream("muse"));
    expect(preamble.content[0].text).toBe("Saya install dependency dulu.");
    expect(preamble.phase).toBe("commentary");
  });

  it("jawaban akhir (tanpa tool call sesudahnya) dibiarkan tanpa phase", () => {
    const [, finalAnswer] = assistantMessages(toUpstream("muse"));
    expect(finalAnswer.content[0].text).toBe("Dependency terpasang.");
    expect(finalAnswer.phase).toBeUndefined();
  });

  it("meta-code ikut — endpoint Meta yang sama", () => {
    const [preamble, finalAnswer] = assistantMessages(toUpstream("meta-code"));
    expect(preamble.phase).toBe("commentary");
    expect(finalAnswer.phase).toBeUndefined();
  });

  it("provider tanpa quirk tidak menerima field phase", () => {
    for (const msg of assistantMessages(toUpstream("openai"))) {
      expect(msg).not.toHaveProperty("phase");
    }
  });
});

describe("labelCommentaryPhase", () => {
  const call = { type: "function_call", call_id: "c1", name: "Bash", arguments: "{}" };
  const asst = (text, extra = {}) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }], ...extra });
  const user = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] });

  it("phase dari klien tidak ditimpa", () => {
    const body = { input: [asst("a", { phase: "final_answer" }), call, asst("b", { phase: "commentary" })] };
    labelCommentaryPhase(body);
    expect(body.input[0].phase).toBe("final_answer");
    expect(body.input[2].phase).toBe("commentary");
  });

  it("deretan pesan asisten yang berakhir di tool call semuanya commentary", () => {
    const body = { input: [user("u"), asst("a"), asst("b"), call] };
    labelCommentaryPhase(body);
    expect(body.input[1].phase).toBe("commentary");
    expect(body.input[2].phase).toBe("commentary");
  });

  it("custom_tool_call dihitung sebagai tool call", () => {
    const body = { input: [asst("a"), { type: "custom_tool_call", call_id: "c2", name: "apply_patch", input: "" }] };
    labelCommentaryPhase(body);
    expect(body.input[0].phase).toBe("commentary");
  });

  it("item tanpa type tapi ber-role assistant tetap dikenali", () => {
    const body = { input: [{ role: "assistant", content: "a" }, call] };
    labelCommentaryPhase(body);
    expect(body.input[0].phase).toBe("commentary");
  });

  it("pesan user tidak pernah diberi phase", () => {
    const body = { input: [user("u"), call] };
    labelCommentaryPhase(body);
    expect(body.input[0]).not.toHaveProperty("phase");
  });

  it("input string dibiarkan", () => {
    const body = { input: "halo" };
    labelCommentaryPhase(body);
    expect(body.input).toBe("halo");
  });

  it("item milik pemanggil tidak dimutasi", () => {
    const original = asst("a");
    const body = { input: [original, call] };
    labelCommentaryPhase(body);
    expect(original).not.toHaveProperty("phase");
    expect(body.input[0].phase).toBe("commentary");
  });
});
