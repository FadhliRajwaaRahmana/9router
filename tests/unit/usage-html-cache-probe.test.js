/**
 * Periksa HTML halaman /dashboard/usage: chunk mana yang direferensikan, dan
 * header cache-nya. Ini menentukan apakah browser bisa "terjebak" memuat
 * chunk lama meski chunk baru sudah tersedia di server.
 */
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";

describe("PROBE cache HTML usage", () => {
  it("chunk yang direferensikan HTML vs yang tersedia", async () => {
    const { createDashboardAuthToken } = await import("../../src/lib/auth/dashboardSession.js");
    const t = await createDashboardAuthToken({});

    const out = [];
    const r = await fetch("http://localhost:20128/dashboard/usage", {
      headers: { Cookie: `auth_token=${t}` },
    });
    out.push(`HTTP ${r.status}`);
    out.push(`cache-control: ${r.headers.get("cache-control") || "(tidak ada)"}`);
    out.push(`x-nextjs-cache: ${r.headers.get("x-nextjs-cache") || "(tidak ada)"}`);
    out.push(`etag: ${r.headers.get("etag") || "(tidak ada)"}`);

    const html = await r.text();
    out.push(`panjang HTML: ${html.length}`);

    const chunks = [...new Set([...html.matchAll(/5497-[a-f0-9]+\.js/g)].map((m) => m[0]))];
    out.push(`chunk UsageStats direferensikan: ${chunks.join(", ") || "(tidak ada di HTML)"}`);

    // Cek chunk mana yang benar-benar ada di server.
    const fs = await import("node:fs");
    const { resolve } = await import("node:path");
    const { execSync } = await import("node:child_process");
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const dir = resolve(globalRoot, "9router-imagefix/app/.next-cli-build/static/chunks");
    let available = [];
    try {
      available = fs.readdirSync(dir).filter((f) => f.startsWith("5497-"));
    } catch (e) {
      out.push(`gagal baca dir: ${e.message}`);
    }
    out.push(`chunk tersedia di server: ${available.join(", ")}`);

    const mismatch = chunks.length > 0 && !chunks.some((c) => available.includes(c));
    out.push("");
    if (mismatch) {
      out.push("❌ MISMATCH — HTML menunjuk chunk yang TIDAK ada di server.");
      out.push("   Browser akan gagal memuat → atau memakai versi cache lama.");
    } else if (chunks.length) {
      out.push("✅ HTML menunjuk chunk yang ADA di server.");
    } else {
      out.push("ℹ️  Chunk tidak ditemukan di HTML (mungkin di-load dinamis).");
    }

    const txt = out.join("\n");
    writeFileSync("C:/Users/Developer/9router-fix/usage-html-cache.txt", txt);
    console.log(txt);
  }, 120000);
});
