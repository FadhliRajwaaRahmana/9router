"use client";

import { useState, useEffect } from "react";
import { Card, Select, Badge } from "@/shared/components";

/**
 * Pemilih host Antigravity.
 *
 * Default `daily-only` mengikuti perilaku 9Router upstream DAN CLIProxyAPI —
 * keduanya memakai `daily` saja dan mengandalkan rotasi AKUN saat gagal, bukan
 * rotasi host. Itu lebih aman karena host sandbox memberlakukan gerbang
 * tambahan: request dengan project yang tidak dikenali ditolak
 * 403 SUBSCRIPTION_REQUIRED (#3501), sementara `daily` menerimanya.
 *
 * Preset sandbox tetap disediakan karena kapasitas Google bergeser — pada
 * 2026-09-13 `daily` hanya 5% sukses untuk claude-opus sementara sandbox 100%.
 */
const PRESETS = [
  {
    value: "daily-only",
    label: "Daily only",
    hint: "Host resmi IDE. Paling aman — rotasi akun saat gagal.",
    urls: ["daily-cloudcode-pa.googleapis.com"],
  },
  {
    value: "daily-autopush",
    label: "Daily + Autopush",
    hint: "Tambah satu pool sandbox sebagai cadangan kapasitas.",
    urls: ["daily-cloudcode-pa.googleapis.com", "autopush-cloudcode-pa.sandbox.googleapis.com"],
  },
  {
    value: "all-hosts",
    label: "Semua host (daily + 2 sandbox)",
    hint: "Kapasitas maksimum. Sandbox bisa menolak 403 #3501 pada sebagian akun.",
    urls: [
      "daily-cloudcode-pa.googleapis.com",
      "autopush-cloudcode-pa.sandbox.googleapis.com",
      "staging-cloudcode-pa.sandbox.googleapis.com",
    ],
  },
];

export default function AntigravityHostCard() {
  const [mode, setMode] = useState("daily-only");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((s) => {
        if (!cancelled) {
          setMode(s?.antigravityHostMode || "daily-only");
          setLoaded(true);
        }
      })
      .catch(() => setLoaded(true));
    return () => { cancelled = true; };
  }, []);

  const save = async (next) => {
    setSaving(true);
    setMsg("");
    const prev = mode;
    setMode(next);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ antigravityHostMode: next }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setMsg("Tersimpan — berlaku pada request berikutnya.");
    } catch (e) {
      setMode(prev);
      setMsg(`Gagal menyimpan: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  const active = PRESETS.find((p) => p.value === mode) || PRESETS[0];

  return (
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Host Antigravity</h2>
          <p className="text-sm text-text-muted">
            Host mana yang dicoba, berurut. Berlaku pada request berikutnya — tanpa restart.
          </p>
        </div>
        <Badge variant={mode === "daily-only" ? "success" : "warning"}>
          {mode === "daily-only" ? "Aman" : "Sandbox aktif"}
        </Badge>
      </div>

      <Select
        label="Mode host"
        value={mode}
        disabled={saving || !loaded}
        onChange={(e) => save(e.target.value)}
      >
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value}>{p.label}</option>
        ))}
      </Select>

      <p className="mt-2 text-sm text-text-muted">{active.hint}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {active.urls.map((u, i) => (
          <span
            key={u}
            className="rounded border border-border-subtle bg-bg-subtle px-2 py-1 font-mono text-xs text-text-muted"
          >
            {i + 1}. {u.replace(".googleapis.com", "")}
          </span>
        ))}
      </div>

      {mode !== "daily-only" && (
        <p className="mt-3 rounded border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-text-muted">
          Host sandbox memberlakukan gerbang tambahan: request dengan project yang tidak
          dikenali ditolak <span className="font-mono">403 SUBSCRIPTION_REQUIRED (#3501)</span>.
          Kalau muncul error itu, kembali ke <strong>Daily only</strong>.
        </p>
      )}

      {msg && <p className="mt-2 text-sm text-text-muted">{msg}</p>}
    </Card>
  );
}
