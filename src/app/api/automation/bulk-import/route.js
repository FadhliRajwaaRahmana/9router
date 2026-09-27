import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";
import { createProviderConnection } from "@/models";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Bulk import kredensial yang sudah dimiliki operator.
 *
 * Menerima:
 *   - array objek:      [{ provider, accessToken, refreshToken }, ...]
 *   - objek terbungkus: { accounts: [...] }
 *   - satu objek
 *
 * ── Mengapa SERIAL, bukan paralel ───────────────────────────────────────────
 *
 * `createProviderConnection` membaca prioritas tertinggi lalu menata ulang di
 * dalam transaksi. Memanggilnya paralel membuat dua permintaan membaca
 * prioritas yang sama dan menulis nomor kembar — urutan akun jadi tidak
 * deterministik, dan itulah yang menentukan akun mana dipakai lebih dulu saat
 * rotasi. Jalur codex/bulk-import di repo ini sudah memakai alasan yang sama.
 *
 * ── Apa yang TIDAK dilakukan ────────────────────────────────────────────────
 *
 * Tidak memvalidasi token ke upstream. Validasi berarti satu permintaan keluar
 * per akun, dan untuk import 50 akun itu membuat halaman menggantung tanpa
 * alasan — token yang salah akan ketahuan sendiri saat request pertama lewat.
 * Yang dilakukan adalah memastikan bentuknya masuk akal sebelum disimpan.
 */
export const POST = requireGate(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return NextResponse.json(
      { error: `Invalid JSON body: ${err.message}` },
      { status: 400, headers: NO_STORE },
    );
  }

  let accounts;
  if (Array.isArray(body)) accounts = body;
  else if (body && typeof body === "object" && Array.isArray(body.accounts)) accounts = body.accounts;
  else if (body && typeof body === "object") accounts = [body];
  else accounts = null;

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return NextResponse.json({ error: "No accounts provided" }, { status: 400, headers: NO_STORE });
  }

  // Cegah satu kiriman raksasa yang menghabiskan memori server.
  const MAX = 500;
  if (accounts.length > MAX) {
    return NextResponse.json(
      { error: `Too many accounts in one request (max ${MAX})` },
      { status: 400, headers: NO_STORE },
    );
  }

  const results = [];
  let success = 0;
  let skipped = 0;

  for (let i = 0; i < accounts.length; i++) {
    const raw = accounts[i];
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Item is not an object");
      }
      const provider = raw.provider || raw.providerId;
      if (!provider) throw new Error("Missing provider");
      const accessToken = raw.accessToken || raw.access_token;
      if (!accessToken) throw new Error("Missing accessToken");

      // Kembar: provider yang sama dengan accessToken yang sama. Tanpa ini,
      // menjalankan import dua kali menggandakan daftar akun, dan rotasi akan
      // memilih akun yang sama berulang kali tanpa operator sadar.
      const existing = await getProviderConnections({ provider });
      const dupe = existing.some((c) => c.accessToken === accessToken);
      if (dupe) {
        skipped++;
        results.push({ index: i, provider, ok: true, skipped: true, reason: "Already present" });
        continue;
      }

      const conn = await createProviderConnection({
        provider,
        authType: raw.authType || "oauth",
        accessToken,
        refreshToken: raw.refreshToken || raw.refresh_token || null,
        idToken: raw.idToken || raw.id_token || null,
        email: raw.email || null,
        name: raw.name || null,
        expiresAt: raw.expiresAt || null,
        testStatus: "active",
        // Field khusus provider (mis. profileArn Kiro) ikut apa adanya.
        ...(raw.providerSpecificData ? { providerSpecificData: raw.providerSpecificData } : {}),
      });

      success++;
      results.push({ index: i, provider, ok: true, id: conn.id });
    } catch (err) {
      results.push({ index: i, ok: false, error: err.message || "Import failed" });
    }
  }

  return NextResponse.json(
    { success, skipped, failed: accounts.length - success - skipped, total: accounts.length, results },
    { headers: NO_STORE },
  );
});
