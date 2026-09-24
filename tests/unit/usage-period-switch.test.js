/**
 * Usage dashboard: mengganti period HARUS mengubah angka.
 *
 * Laporan (24 Sep 2026): pilih Today / 24h / All tidak ada perubahan.
 *
 * Data & backend TERBUKTI benar — dihitung langsung dari SQLite:
 *   today :  211 baris,    42.109.097 token
 *   24h   : 1596 baris,   483.731.444 token
 *   7d    : 9342 request, 2.505.433.893 token
 *   all   : 53997 request, 15.079.769.084 token
 *
 * Jadi bug-nya di jalur data FRONTEND/SSE. Dua sebab:
 *
 * 1. SSE mengirim `cachedStats` milik period LAMA tapi melabelinya dengan
 *    `period` yang BARU. Klien memeriksa `data.period === period` → cocok →
 *    data lama diterima. Angka di layar tidak berubah.
 *
 * 2. REST memakai `{...prev, ...data}` (merge), sehingga key yang tidak ada di
 *    respons baru tetap tertinggal.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");
const STREAM = readFileSync(resolve(REPO, "src/app/api/usage/stream/route.js"), "utf8");
const STATS = readFileSync(resolve(REPO, "src/shared/components/UsageStats.js"), "utf8");

describe("usage — pergantian period", () => {
  it("SSE mencatat period milik cache", () => {
    // Tanpa ini, cache period lama bisa dilabeli period baru.
    expect(STREAM).toContain("cachedStatsPeriod");
    expect(STREAM).toMatch(/cachedStatsPeriod\s*=\s*period/);
  });

  it("push cepat SSE dilewati bila cache bukan milik period ini", () => {
    // Pola lama: `if (state.cachedStats)` saja — selalu lolos.
    expect(STREAM).not.toMatch(/if \(state\.cachedStats\) \{/);
    expect(STREAM).toMatch(/state\.cachedStatsPeriod === period/);
  });

  it("sendPending juga memeriksa period cache", () => {
    const pending = STREAM.slice(STREAM.indexOf("state.sendPending = async"));
    const head = pending.slice(0, 400);
    expect(head).toContain("cachedStatsPeriod !== period");
  });

  it("REST mengganti key turunan, bukan sekadar merge", () => {
    // Merge saja menyisakan byModel/byProvider dari period sebelumnya.
    expect(STATS).toMatch(/byProvider:\s*data\.byProvider \?\? \{\}/);
    expect(STATS).toMatch(/byModel:\s*data\.byModel \?\? \{\}/);
    expect(STATS).toMatch(/byAccount:\s*data\.byAccount \?\? \{\}/);
    expect(STATS).toMatch(/last10Minutes:\s*data\.last10Minutes \?\? \[\]/);
  });

  it("REST membatalkan fetch lama saat period berganti", () => {
    // Tanpa AbortController, respons period lama bisa menimpa yang baru.
    expect(STATS).toContain("AbortController");
    expect(STATS).toMatch(/return \(\) => ac\.abort\(\)/);
  });

  it("kedua endpoint tetap menerima period yang sama", () => {
    // Kontrak API tidak boleh berubah — bug-nya di pemakaian, bukan di API.
    expect(STATS).toContain("/api/usage/stats?period=");
    expect(STATS).toContain("/api/usage/stream?period=");
    expect(STREAM).toMatch(/getUsageStats\(period\)/);
  });
});
