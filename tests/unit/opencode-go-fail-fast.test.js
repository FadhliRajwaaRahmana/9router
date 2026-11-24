// Live 24 Nov: satu stall koneksi ke opencode.ai berakhir 249166 ms sebelum
// account fallback jalan. Penyebabnya bukan model lambat, tapi kebijakan retry:
// timeout 60 s × 4 percobaan (1 awal + 3 retry 502) + 3 × 3 s delay = 249 s.
// Provider ini sehat di 3–7 s (TTFT terukur), jadi timeout harus fail-fast.
import { describe, expect, it } from "vitest";
import opencodeGo from "../../open-sse/providers/registry/opencode-go.js";
import { DEFAULT_RETRY_CONFIG } from "../../open-sse/config/runtimeConfig.js";

describe("OpenCode Go fail-fast", () => {
  it("timeout terkunci 45 detik, bukan default 60", () => {
    expect(opencodeGo.timeoutMs).toBe(45000);
  });

  it("noRetryTimeoutMs sama dengan timeoutMs agar stall tidak diulang", () => {
    // BaseExecutor melempar langsung ketika timeoutMs >= noRetryTimeoutMs,
    // sehingga account fallback berputar alih-alih menunggu 4x.
    expect(opencodeGo.noRetryTimeoutMs).toBe(opencodeGo.timeoutMs);
  });

  it("retry 502/503 maksimal sekali dengan delay pendek", () => {
    const merged = { ...DEFAULT_RETRY_CONFIG, ...opencodeGo.retry };
    expect(merged["502"]).toEqual({ attempts: 1, delayMs: 1000 });
    expect(merged["503"]).toEqual({ attempts: 1, delayMs: 1500 });
    // 429 tetap tanpa retry: rotasi akun lebih cepat daripada menunggu.
    expect(merged["429"].attempts).toBe(0);
  });

  it("jalur stall terburuk jauh di bawah 249 detik", () => {
    const merged = { ...DEFAULT_RETRY_CONFIG, ...opencodeGo.retry };
    const worst = opencodeGo.timeoutMs * (1 + merged["502"].attempts) + merged["502"].delayMs;
    expect(worst).toBeLessThan(100000);
  });
});
