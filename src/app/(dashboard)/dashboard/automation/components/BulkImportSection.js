"use client";

import { useState } from "react";
import { Button } from "@/shared/components";

const PLACEHOLDER = `[
  {
    "provider": "codex",
    "accessToken": "eyJhbGciOi...",
    "refreshToken": "v1.Mr...",
    "email": "nama@contoh.com"
  },
  { "provider": "grok-cli", "accessToken": "..." }
]`;

/**
 * Bulk import kredensial yang sudah dimiliki.
 *
 * Tempel JSON atau pilih berkas. Bentuknya sengaja permisif — menerima array,
 * satu objek, atau objek terbungkus `{ accounts: [...] }` — karena berkas yang
 * beredar di antara mesin datang dalam ketiga bentuk itu, dan menolak salah
 * satunya berarti operator harus mengedit berkas dengan tangan lebih dulu.
 *
 * Hasilnya ditampilkan PER BARIS, bukan sebagai satu angka. Import 50 akun
 * yang gagal separuh tidak berguna kalau yang terlihat hanya "25 gagal";
 * operator perlu tahu yang mana.
 */
export default function BulkImportSection() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const submit = async () => {
    setError("");
    setResult(null);

    const trimmed = text.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      setError(`JSON tidak valid: ${e.message}`);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/automation/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error || `HTTP ${res.status}`);
        return;
      }
      setResult(data);
    } catch (e) {
      setError(e.message || "Import gagal");
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setText(await file.text());
    // Izinkan memilih berkas yang sama dua kali berturut-turut.
    e.target.value = "";
  };

  const failed = (result?.results || []).filter((r) => !r.ok);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-text-main">Tempel kredensial</p>
            <p className="mt-0.5 text-xs text-text-muted">
              Setiap akun butuh <code className="font-mono">provider</code> dan{" "}
              <code className="font-mono">accessToken</code>. Akun yang sudah ada dilewati, jadi
              menempel dua kali aman.
            </p>
          </div>
          <label className="cursor-pointer rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text focus-within:ring-2 focus-within:ring-primary/45">
            <span className="material-symbols-outlined mr-1 align-middle text-[15px]" aria-hidden="true">
              upload_file
            </span>
            Pilih berkas
            <input type="file" accept=".json,.txt,application/json" onChange={onFile} className="hidden" />
          </label>
        </div>

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={PLACEHOLDER}
          disabled={busy}
          spellCheck={false}
          aria-label="Kredensial akun dalam format JSON"
          className="min-h-[220px] w-full resize-y rounded-[10px] border border-border bg-bg-subtle p-3 font-mono text-xs text-text-main placeholder-text-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 disabled:opacity-50"
        />

        {error ? (
          <p role="alert" className="text-xs font-medium text-error">
            {error}
          </p>
        ) : null}

        <div>
          <Button onClick={submit} disabled={busy || !text.trim()} loading={busy}>
            Import
          </Button>
        </div>
      </div>

      {result ? (
        <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
          <p className="text-sm font-medium text-text-main">
            {result.success} ditambahkan
            {result.skipped ? `, ${result.skipped} dilewati` : ""}
            {result.failed ? `, ${result.failed} gagal` : ""} dari {result.total}
          </p>

          {failed.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {failed.map((r) => (
                <li key={r.index} className="text-xs text-error">
                  Baris {r.index + 1}: {r.error}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-text-muted">
              Semuanya masuk tanpa masalah. Lihat di halaman Providers untuk mengatur urutannya.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
