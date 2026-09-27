"use client";

import { useMemo, useState } from "react";
import { Button, Input } from "@/shared/components";
import {
  selectByIndex,
  selectAgGroupDepleted,
  CLINE_CATEGORY_LABEL,
  selectClineByCategory,
  selectExpiredConnections,
  selectInactiveConnections,
  domainBreakdown,
} from "@/lib/automation/filters";

/**
 * Operasi khas per provider — kelanjutan menu skrip terminalnya.
 *
 * ProviderPanel menangani operasi UMUM (cek kuota, tes koneksi, tes prompt,
 * hapus manual, impor, generate TXT). Berkas ini menangani yang KHAS:
 *
 *   antigravity → kuota selektif per nomor (menu 5), hapus 0% per grup
 *                  (menu 7: claude/gemini/both), refresh token,
 *                  hapus nonaktif per domain + dry-run (menu 12)
 *   grok-cli    → kuota selektif, refresh, hapus BLOCKED, hapus by-pattern
 *   cline       → refresh token (menu 6), bersih per kategori
 *                  MATI/LIMIT/ERROR/EXPIRED (menu 5)
 *   bai         → verifikasi key via inferensi (check_key_quota_live)
 *   tokenharbour→ verifikasi key, lihat kedaluwarsa, nonaktifkan/hapus expired
 *   kiro        → refresh token, ringkasan TOTAL POOL KUOTA dari hasil pindaian
 *   semua       → generator TXT pembuat (paste email + 1 password → file)
 *
 * Bagian mana yang tampil diatur `kinds` di katalog — yang tidak didukung
 * providernya tidak dirender sama sekali.
 *
 * Dua hal yang SENGAJA tidak ada di sini (lihat ProviderPanel): login browser
 * pakai `email:password`, dan hapus otomatis saat pemindaian. Setiap hapus di
 * sini memakai daftar pratinjau yang terlihat dulu + konfirmasi.
 */
export default function ProviderOps({
  providerId,
  info,
  rows = [],
  visible = [],
  scanResults = [],
  running,
  runOp,
  onDelete,
  onChanged,
}) {
  const kinds = info?.kinds || {};
  const hasOps =
    kinds.selective || kinds.refresh || kinds.verify || kinds.cleanup ||
    kinds.patternDelete || kinds.blocked || kinds.expiryOps || kinds.inactive ||
    providerId === "antigravity" || providerId === "kiro";

  if (!hasOps) return null;

  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-subtle">
        Operasi {info?.label || providerId}
      </h3>

      {kinds.selective ? (
        <SelectiveOps rows={visible.length ? visible : rows} running={running} runOp={runOp} />
      ) : null}

      {providerId === "antigravity" ? (
        <AgGroupDelete scanResults={scanResults} running={running} onDelete={onDelete} />
      ) : null}

      {providerId === "kiro" ? <KiroPool scanResults={scanResults} /> : null}

      {kinds.refresh ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="autorenew"
            disabled={running || !rows?.length}
            onClick={() => runOp("refresh").then((d) => d && onChanged?.())}
            title="Perbarui access token semua akun provider ini tanpa login ulang (menu 6 skrip cline)"
          >
            Refresh token
          </Button>
          <span className="text-[11px] text-text-subtle">Tanpa login ulang; token mati dilaporkan per akun.</span>
        </div>
      ) : null}

      {kinds.verify ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="verified"
            disabled={running || !rows?.length}
            onClick={() => runOp("verify")}
            title="Uji setiap key dengan inferensi nyata — 401/402/429 dibedakan (check_key_quota_live)"
          >
            Verifikasi key
          </Button>
          <span className="text-[11px] text-text-subtle">Inferensi nyata per key: valid / ditolak / habis / laju.</span>
        </div>
      ) : null}

      {kinds.cleanup ? <ClineCleanup rows={rows} running={running} onDelete={onDelete} /> : null}

      {kinds.blocked ? <BlockedRow rows={rows} running={running} onDelete={onDelete} /> : null}

      {kinds.patternDelete ? (
        <PatternDelete rows={visible.length ? visible : rows} running={running} onDelete={onDelete} />
      ) : null}

      {kinds.expiryOps ? (
        <ExpiryOps rows={rows} running={running} runOp={runOp} onDelete={onDelete} onChanged={onChanged} />
      ) : null}

      {kinds.inactive ? <InactiveOps rows={rows} running={running} onDelete={onDelete} /> : null}

      <TxtBuilder providerId={providerId} />
    </div>
  );
}

/**
 * Pilih akun per nomor ala skrip `ag` menu 5: "50", "1,5,12", "1-10", "all".
 * Urutannya = urutan baris yang terlihat di layar (1-based seperti skrip).
 */
function SelectiveOps({ rows, running, runOp }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  const picked = useMemo(() => {
    if (!text.trim()) return null;
    return selectByIndex(rows, text);
  }, [rows, text]);

  const run = (op) => {
    setError("");
    if (!text.trim()) {
      setError("Isi dulu nomornya — kosong berarti semua (pakai tombol di atas).");
      return;
    }
    const ids = (picked || []).map((r) => r.id);
    if (!ids.length) {
      setError("Tidak ada nomor valid yang cocok.");
      return;
    }
    runOp(op, { ids });
  };

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Cek akun tertentu
        <span className="ml-2 font-normal text-text-subtle">menu 5 skrip: nomor, koma, rentang, atau all</span>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="mis. 50 · 1, 5, 12 · 1-10 · all" disabled={running} />
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" disabled={running || !rows?.length} onClick={() => run("quota")}>
            Kuota pilihan
          </Button>
          <Button size="sm" variant="secondary" disabled={running || !rows?.length} onClick={() => run("test")}>
            Tes pilihan
          </Button>
        </div>
      </div>
      {picked ? (
        <p className="text-[11px] tabular-nums text-text-muted">{picked.length} dari {rows.length} akun cocok.</p>
      ) : null}
      {error ? <p role="alert" className="text-[11px] font-medium text-error">{error}</p> : null}
    </div>
  );
}

/**
 * Hapus 0% per grup untuk Antigravity (menu 7 skrip `ag`).
 *
 * Dibaca dari HASIL pemindaian kuota terakhir (state job), bukan dari
 * pemindaian baru — operator melihat angkanya dulu, baru memutuskan.
 * Ambang `< 1` sama seperti skrip, tapi grup yang tidak terbaca (`null`)
 * tidak pernah lolos (bug sentinel skrip tidak ditiru).
 */
const AG_MODES = [
  { value: "claude", label: "Claude & GPT 0%" },
  { value: "gemini", label: "Gemini 0%" },
  { value: "both", label: "Keduanya 0%" },
];

function AgGroupDelete({ scanResults, running, onDelete }) {
  const [mode, setMode] = useState("both");
  const cands = useMemo(() => selectAgGroupDepleted(scanResults, mode), [scanResults, mode]);
  if (!scanResults?.length) return null;
  const modeLabel = AG_MODES.find((m) => m.value === mode)?.label || mode;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Hapus kuota 0% per grup
        <span className="ml-2 font-normal text-text-subtle">menu 7 skrip ag — dari hasil pindaian terakhir</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="group" aria-label="Kriteria grup">
          {AG_MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => setMode(m.value)}
              aria-pressed={mode === m.value}
              className={`h-7 shrink-0 rounded-[8px] px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                mode === m.value ? "bg-primary-strong text-white" : "bg-surface-2 text-text-muted hover:text-text-main"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !cands.length}
          onClick={() => {
            if (!confirm(`Hapus permanen ${cands.length} akun (${modeLabel})?`)) return;
            onDelete(cands.map((c) => c.id));
          }}
        >
          Hapus {cands.length} akun
        </Button>
      </div>
    </div>
  );
}

/**
 * Ringkasan TOTAL POOL KUOTA Kiro dari hasil pindaian (kolom agregat skrip).
 *
 * `pool` dihitung per akun oleh classifyUsage (jumlah used/total semua baris
 * AGENTIC_REQUEST); di sini dijumlahkan lintas akun.
 */
function KiroPool({ scanResults }) {
  const pool = useMemo(() => {
    const rows = (scanResults || []).filter((r) => r?.pool && Number.isFinite(r.pool.total) && r.pool.total > 0);
    if (!rows.length) return null;
    const used = rows.reduce((s, r) => s + r.pool.used, 0);
    const total = rows.reduce((s, r) => s + r.pool.total, 0);
    return { used, total, remaining: Math.max(0, total - used), accounts: rows.length };
  }, [scanResults]);
  if (!pool) return null;

  const pct = pool.total > 0 ? Math.round((pool.remaining / pool.total) * 100) : 0;
  return (
    <p className="rounded-[10px] border border-border-subtle bg-bg-subtle/50 px-3 py-2 text-xs tabular-nums text-text-main">
      Total pool kuota: <strong>{pool.remaining.toLocaleString("en-US")}</strong> / {pool.total.toLocaleString("en-US")} tersisa
      <span className="ml-2 text-text-muted">({pct}% · {pool.accounts} akun terbaca)</span>
    </p>
  );
}

/** Bersih per kategori ala skrip `cline` menu 5: MATI / LIMIT / ERROR / EXPIRED. */
const CLINE_CATS = ["mati", "limit", "error", "expired"];

function ClineCleanup({ rows, running, onDelete }) {
  const [cat, setCat] = useState("mati");
  const cands = useMemo(() => selectClineByCategory(rows, cat), [rows, cat]);

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Bersihkan per kategori
        <span className="ml-2 font-normal text-text-subtle">menu 5 skrip cline — dibaca dari daftar akun</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Kategori cline">
          {CLINE_CATS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              aria-pressed={cat === c}
              className={`h-7 shrink-0 rounded-[8px] px-2.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 ${
                cat === c ? "bg-primary-strong text-white" : "bg-surface-2 text-text-muted hover:text-text-main"
              }`}
            >
              {CLINE_CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !cands.length}
          onClick={() => {
            if (!confirm(`Hapus permanen ${cands.length} akun kategori ${CLINE_CATEGORY_LABEL[cat]}?`)) return;
            onDelete(cands.map((c) => c.id));
          }}
        >
          Hapus {cands.length} akun
        </Button>
      </div>
    </div>
  );
}

/**
 * Hapus akun BLOCKED / tim diblokir ala skrip `grok` menu 6.
 *
 * `team_blocked` dikenali dari `lastError`: pola `spending-limit`,
 * `personal-team-blocked`, atau kata "blocked" — sumber yang sama dengan
 * yang dibaca skrip dari billing xAI. Akun 402-kuota-habis (depleted) ikut,
 * karena di Grok keduanya berarti "tidak bisa belanja".
 */
function BlockedRow({ rows, running, onDelete }) {
  const cands = useMemo(
    () =>
      (rows || []).filter((c) => {
        const raw = String(c.lastError || "").toLowerCase();
        const blocked = /spending.?limit|personal-team-blocked|team.?blocked|\bblocked\b/.test(raw);
        return blocked || c.errorState === "depleted";
      }),
    [rows],
  );
  if (!cands.length) return null;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Hapus akun BLOCKED
        <span className="ml-2 font-normal text-text-subtle">menu 6 skrip grok — tim diblokir / spending-limit / kuota habis</span>
      </p>
      <div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running}
          onClick={() => {
            if (!confirm(`Hapus permanen ${cands.length} akun BLOCKED?`)) return;
            onDelete(cands.map((c) => c.id));
          }}
        >
          Hapus {cands.length} akun
        </Button>
      </div>
    </div>
  );
}

/**
 * Hapus massal by-pattern ala skrip `grok` menu 8: pratinjau 10 pertama +
 * konfirmasi. Polanya substring case-insensitive pada email/nama.
 */
function PatternDelete({ rows, running, onDelete }) {
  const [text, setText] = useState("");

  const matched = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return null;
    return (rows || []).filter((c) =>
      [c.email, c.name, c.id].some((v) => String(v || "").toLowerCase().includes(q)),
    );
  }, [rows, text]);

  if (!rows?.length) return null;

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Hapus by-pattern
        <span className="ml-2 font-normal text-text-subtle">menu 8 skrip grok — substring email/nama</span>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="mis. @gmaoiil.com" disabled={running} />
        </div>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !matched?.length}
          onClick={() => {
            if (!matched?.length) return;
            if (!confirm(`Hapus permanen ${matched.length} akun yang cocok "${text.trim()}"?`)) return;
            onDelete(matched.map((c) => c.id));
            setText("");
          }}
        >
          Hapus{matched?.length ? ` ${matched.length}` : ""} akun
        </Button>
      </div>
      {matched ? (
        <div className="text-[11px] text-text-muted">
          <p className="tabular-nums">{matched.length} cocok.</p>
          {matched.slice(0, 10).map((c) => (
            <p key={c.id} className="truncate font-mono">{c.email || c.name || c.id}</p>
          ))}
          {matched.length > 10 ? <p>…dan {matched.length - 10} lainnya.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Operasi kedaluwarsa TokenHarbor (menu 5-6 skrip: `--view-expiring`,
 * `--cleanup`, `--delete-expired`).
 *
 * "Lihat" hanya menyaring (dry-run); "Nonaktifkan" mengikuti perilaku default
 * skrip (UPDATE isActive=0, baris tetap ada); "Hapus" = `--delete-expired`.
 * `hoursAhead` = `--view-expiring N` (akun yang kedaluwarsa dalam N jam ke depan
 * ikut tampil).
 */
function fmtRemaining(ms) {
  if (ms <= 0) return "kedaluwarsa";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m lagi`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}j lagi`;
  return `${Math.floor(h / 24)}h lagi`;
}

function ExpiryOps({ rows, running, runOp, onDelete, onChanged }) {
  const [hoursAhead, setHoursAhead] = useState(0);
  const expired = useMemo(
    () => selectExpiredConnections(rows, { hoursAhead: Number(hoursAhead) || 0 }),
    [rows, hoursAhead],
  );

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Kedaluwarsa
        <span className="ml-2 font-normal text-text-subtle">menu 5-6 skrip tokenharbor — gagal parse = permanen</span>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-32">
          <Input label="Lihat N jam ke depan" type="number" value={hoursAhead} onChange={(e) => setHoursAhead(e.target.value)} disabled={running} />
        </div>
        <span className="pb-2 text-[11px] tabular-nums text-text-muted">
          {expired.length} akun{Number(hoursAhead) > 0 ? ` (kedaluwarsa + ${hoursAhead}j ke depan)` : " kedaluwarsa"}.
        </span>
      </div>
      {expired.length > 0 ? (
        <>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            {expired.slice(0, 20).map((c) => (
              <li key={c.id} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="min-w-0 truncate font-mono text-text-main">{c.email || c.name || c.id}</span>
                <span className="shrink-0 tabular-nums text-text-muted">{fmtRemaining(c.remainingMs)}</span>
              </li>
            ))}
            {expired.length > 20 ? (
              <li className="text-[11px] text-text-subtle">…dan {expired.length - 20} lainnya.</li>
            ) : null}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon="pause_circle"
              disabled={running}
              onClick={() =>
                runOp("deactivate", { ids: expired.map((c) => c.id) }).then((d) => d && onChanged?.())
              }
              title="UPDATE isActive=0 — perilaku default skrip; baris tetap ada dan bisa diaktifkan lagi"
            >
              Nonaktifkan {expired.length}
            </Button>
            <Button
              size="sm"
              variant="danger"
              icon="delete_sweep"
              disabled={running}
              onClick={() => {
                if (!confirm(`Hapus permanen ${expired.length} akun kedaluwarsa?`)) return;
                onDelete(expired.map((c) => c.id));
              }}
              title="Hapus baris permanen — --delete-expired di skrip"
            >
              Hapus {expired.length}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Hapus akun nonaktif ala skrip `ag` menu 12: sebaran domain + dry-run.
 *
 * Dry-run = pratinjau klasifikasi tanpa menghapus (`--inactive-dry-run`).
 * Fail-safe: hanya `isActive === false` yang dianggap nonaktif.
 */
function InactiveOps({ rows, running, onDelete }) {
  const [showDomains, setShowDomains] = useState(false);
  const inactive = useMemo(() => selectInactiveConnections(rows), [rows]);
  const domains = useMemo(() => (showDomains ? domainBreakdown(rows) : []), [showDomains, rows]);

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-bg-subtle/50 p-3">
      <p className="text-xs font-medium text-text-main">
        Akun nonaktif
        <span className="ml-2 font-normal text-text-subtle">menu 12 skrip ag — dry-run dulu, hapus sesudahnya</span>
      </p>
      <p className="text-[11px] tabular-nums text-text-muted">
        {inactive.length} nonaktif dari {rows?.length || 0} akun. Alasan per akun terlihat di bawah.
      </p>
      {inactive.length > 0 ? (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {inactive.slice(0, 20).map((c) => (
            <li key={c.id} className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 truncate font-mono text-text-main">{c.email || c.name || c.id}</span>
              <span className="shrink-0 font-mono text-text-subtle">{c.inactiveReason}</span>
            </li>
          ))}
          {inactive.length > 20 ? (
            <li className="text-[11px] text-text-subtle">…dan {inactive.length - 20} lainnya.</li>
          ) : null}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={() => setShowDomains((v) => !v)} aria-expanded={showDomains}>
          {showDomains ? "Sembunyikan" : "Sebaran domain"}
        </Button>
        <Button
          size="sm"
          variant="danger"
          icon="delete_sweep"
          disabled={running || !inactive.length}
          onClick={() => {
            if (!confirm(`Hapus permanen ${inactive.length} akun nonaktif?`)) return;
            onDelete(inactive.map((c) => c.id));
          }}
        >
          Hapus {inactive.length} nonaktif
        </Button>
      </div>
      {showDomains ? (
        <ul className="flex flex-col gap-1">
          {domains.map((d) => (
            <li key={d.domain} className="flex items-baseline justify-between gap-2 text-[11px] tabular-nums">
              <span className="min-w-0 truncate font-mono text-text-main">{d.domain}</span>
              <span className="shrink-0 text-text-muted">
                {d.total} akun · {d.active} aktif{d.dead ? " · domain mati total" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Generator TXT pembuat (menu 10 skrip `ag`, menu 9 `grok`, menu 8 `kiro`/`bai`):
 * paste email + satu password seragam → unduh `email:password`.
 *
 * Murni client-side: tidak ada kredensial yang dikirim ke server, tidak ada
 * login. Bentuk keluarannya sama dengan yang dimakan skrip (`email:password`
 * per baris) supaya bisa dipakai untuk tambah akun lewat skrip.
 */
function TxtBuilder({ providerId }) {
  const [emails, setEmails] = useState("");
  const [password, setPassword] = useState("");

  const lines = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const raw of emails.split("\n")) {
      const e = raw.trim();
      if (!e || !e.includes("@")) continue;
      const k = e.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(`${e}:${password}`);
    }
    return out;
  }, [emails, password]);

  const download = () => {
    if (!lines.length || !password) return;
    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain; charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `accounts_${providerId || "bulk"}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <details className="rounded-[10px] border border-border-subtle bg-bg-subtle/50">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text-main">
        Buat berkas akun — paste email + 1 password
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <p className="text-[11px] text-text-muted">
          Keluaran <code className="font-mono">email:password</code> per baris — bentuk yang dimakan skrip
          tambah-akun. Tidak dikirim ke mana pun; berkas dibuat di browser.
        </p>
        <textarea
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          spellCheck={false}
          aria-label="Daftar email, satu per baris"
          placeholder={"satu email per baris\nbaris tanpa @ dilewati, duplikat dibuang"}
          className="min-h-[80px] w-full resize-y rounded-lg border border-border bg-surface p-2 font-mono text-xs text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        />
        <Input label="Satu password untuk semua" type="text" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password seragam" />
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" icon="description" disabled={!lines.length || !password} onClick={download}>
            Unduh {lines.length} baris
          </Button>
        </div>
      </div>
    </details>
  );
}
