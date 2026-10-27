import { describe, it, expect } from "vitest";
import { getThinkingLevels } from "open-sse/providers/thinkingLevels.js";

const META_MODELS = [
  "muse-spark-1.3",
  "muse-spark-1.2",
  "muse-spark-1.1",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
];

describe("level thinking Muse (Meta Model API)", () => {
  it("semua model meta menawarkan max", () => {
    for (const m of META_MODELS) {
      const levels = getThinkingLevels("muse", m);
      expect(levels).toContain("max");
      expect(levels).toContain("xhigh");
    }
  });

  it("none tetap dilarang (Meta menolak reasoning none dengan 400)", () => {
    for (const m of META_MODELS) {
      expect(getThinkingLevels("muse", m)).not.toContain("none");
    }
  });

  it("urutan dari ringan ke berat tetap benar", () => {
    const levels = getThinkingLevels("muse", "muse-spark-1.3");
    expect(levels).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("provider lain tidak terpengaruh", () => {
    // codex GPT-5 (openai format default) tetap tanpa max
    const codex = getThinkingLevels("codex", "gpt-5.1");
    if (codex) expect(codex).not.toContain("max");
  });
});
