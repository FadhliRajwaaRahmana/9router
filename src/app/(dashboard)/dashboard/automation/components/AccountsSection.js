"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { Button, Input, SegmentedControl } from "@/shared/components";
import JobRunner, { useJob } from "./JobRunner";

/**
 * Daftar akun + operasi massal.
 *
 * Ini penggabungan dari bagian "List/Test/Cek Quota/Hapus" di keenam skrip
 * terminal. Tiga prinsip yang membedakannya dari versi skrip:
 *
 * 1. **Memindai dan menghapus adalah dua tindakan terpisah.** Skrip `ag`
 *    menghapus akun DI DALAM pemindaian begitu persentasenya di bawah ambang —
 *    dan karena sentinel `-1` ("kuota tidak terbaca") juga bernilai `< 1`, akun
 *    yang kuotanya gagal dibaca ikut terhapus tanpa sempat dilihat. Di sini
 *    pemindaian hanya MENGISI daftar usulan; operator yang menekan tombol
 *    hapus, dan hanya setelah melihat siapa saja yang masuk.
 *
 * 2. **Hasil pemindaian menempel pada baris, bukan hilang di daftar terpisah.**
 *    Skrip mencetak tabel lalu kembali ke menu; mencari "akun mana yang tadi
 *    habis" berarti menggulir ke atas. Di sini hasilnya tersimpan di state dan
 *    muncul di baris akunnya sendiri, jadi bisa disaring dan diurutkan.
 *
 * 3. **Token tidak pernah dikirim ke browser.** Kolom kredensial hanya berisi
 *    penanda; skrip mencetak 25 karakter pertama API key ke layar.
 */
const STATE_LABEL = {
  healthy: { text: "Sehat", cls: "text-success" },
  low: { text: "Menipis", cls: "text-warning" },
  critical: { text: "Kritis", cls: "text-warning" },
  depleted: { text: "Habis", cls: "text-error" },
  unlimited: { text: "Tanpa batas", cls: "text-text-muted" },
  unsupported: { text: "Tanpa cek kuota", cls: "text-text-muted" },
  unknown: { text: "Tidak terbaca", cls: "text-text-muted" },
};

const FILTERS = [
  { value: "all", label: "Semua" },
  { value: "quota", label: "Kuota terbaca" },
  { value: "problem", label: "Bermasalah" },
  { value: "inactive", label: "Nonaktif" },
];

export default function AccountsSection() {
  const [data, setData] = useState(null);
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  /** Dinaikkan untuk memicu muat ulang setelah penghapusan. */
  const [reloadKey, setReloadKey] = useState(0);

  /** Muat ulang daftar akun dari server. */
  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (provider) params.set("provider", provider);
    const res = await fetch(`/api/automation/connections?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    setData(d.connections || []);
    setProviders(d.providers || []);
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    // Ditunda satu microtask: `load` memanggil setState, dan memanggilnya
    // langsung di badan effect membuat React melakukan render berantai.
    queueMicrotask(async () => {
      if (cancelled) return;
      setLoading(true);
      setError("");
      try {
        await load();
      } catch (e) {
        if (!cancelled) setError(e.message || "Gagal memuat akun");
      } finally {
        if (!cancelled) setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load, reloadKey]);

  // Job ditangani hook yang sama dengan tab lain, supaya kemajuan, pembatalan,
  // dan pemulihan setelah refresh berperilaku identik di mana pun.
  const job = useJob();

  /**
   * Hasil pemindaian terakhir, per id koneksi.
   *
   * Dihitung dari hasil job, BUKAN disalin ke state lewat effect. Menyalinnya
   * berarti dua sumber kebenaran untuk hal yang sama (hasil job dan salinannya),
   * dan keduanya bisa berbeda saat job berikutnya belum selesai. Dibaca saat
   * render, hasilnya selalu yang terbaru dan tidak ada render berantai.
   */
  const scan = useMemo(() => {
    const map = {};
    for (const r of job.results || []) {
      if (r?.id) map[r.id] = r;
    }
    return map;
  }, [job.results]);

  const visible = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.filter((c) => {
      if (q && ![c.email, c.name, c.id].some((v) => String(v || "").toLowerCase().includes(q))) {
        return false;
      }
      const s = scan[c.id];
      if (filter === "quota") return !!s && s.state && s.state !== "unsupported";
      if (filter === "problem") {
        const badQuota = s && ["depleted", "critical", "low"].includes(s.state);
        // `errorState` sudah diklasifikasi di server: hanya kredensial mati dan
        // kuota habis. `lastError` mentah sengaja TIDAK dipakai — 146 dari 156
        // akun grok-cli punya `400 input_too_large` yang bukan masalah akun.
        const badCred =
          c.errorState === "invalid" || c.errorState === "depleted" || c.status === "cooling";
        return badQuota || badCred || !c.isActive;
      }
      if (filter === "inactive") return !c.isActive;
      return true;
    });
  }, [data, query, filter, scan]);

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllVisible = () => setSelected(new Set(visible.map((c) => c.id)));
  const clearSelection = () => setSelected(new Set());

  const runOp = async (op, payload = {}) => {
    setError("");
    const res = await fetch("/api/automation/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op, provider: provider || null, ...payload }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(d?.error || `HTTP ${res.status}`);
      return null;
    }
    // Job dipantau hook yang sama di tab mana pun, jadi halaman ini cukup
    // menyerahkan id-nya.
    if (d.jobId) job.watch(d.jobId, { total: d.total, kind: op });
    return d;
  };

  /**
   * Usulan hapus — HANYA keadaan final, dan hanya dari dua sumber yang sudah
   * diklasifikasi:
   *   · hasil pemindaian kuota (`state: depleted` — angka benar-benar terbaca)
   *   · `errorState` koneksi (`invalid` / `depleted` dari `lastError`)
   *
   * Yang TIDAK PERNAH masuk: kuota yang tidak terbaca, kesalahan jaringan,
   * laju (429), dan masalah request seperti prompt kepanjangan.
   */
  const deleteCandidates = useMemo(() => {
    if (!data) return [];
    return data
      .map((c) => ({ ...c, ...(scan[c.id] || {}) }))
      .filter((c) => c.state === "depleted" || c.errorState === "invalid" || c.errorState === "depleted");
  }, [data, scan]);

  const doDelete = async (ids, reason) => {
    if (!ids.length) return;
    setError("");
    const d = await runOp("delete", { ids, reason });
    if (d) {
      clearSelection();
      // Muat ulang supaya baris yang terhapus benar-benar hilang; menghapusnya
      // dari state lokal saja akan berbohong kalau penghapusan gagal separuh.
      setReloadKey((n) => n + 1);
    }
  };

  if (loading && !data) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-11 animate-pulse rounded-lg bg-border-subtle/60" />
        ))}
      </div>
    );
  }

  const running = job.status === "running";

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-error/20 bg-error/10 px-3 py-2 text-xs font-medium text-error"
        >
          {error}
        </p>
      ) : null}

      {/* Kendali */}
      <div className="flex flex-col gap-3 rounded-[14px] border border-border bg-surface p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-1.5 sm:w-56">
            <label htmlFor="acct-provider" className="text-xs font-medium text-text-main">
              Provider
            </label>
            <select
              id="acct-provider"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                clearSelection();
              }}
              className="w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
            >
              <option value="">Semua provider</option>
              {providers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>

          <div className="flex-1">
            <Input
              label="Cari"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="email, nama, atau id"
            />
          </div>
        </div>

        <SegmentedControl options={FILTERS} value={filter} onChange={setFilter} size="sm" />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon="data_usage"
            disabled={running || !data?.length}
            onClick={() => runOp("quota")}
          >
            Cek kuota
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="network_check"
            disabled={running || !data?.length}
            onClick={() => runOp("test")}
          >
            Test koneksi
          </Button>
          <Button size="sm" variant="ghost" icon="refresh" onClick={load} disabled={running}>
            Muat ulang
          </Button>
          {selected.size > 0 ? (
            <>
              <span className="text-xs text-text-muted">{selected.size} dipilih</span>
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Batal pilih
              </Button>
              <Button
                size="sm"
                variant="danger"
                icon="delete"
                disabled={running}
                onClick={() => {
                  const n = selected.size;
                  if (!confirm(`Hapus permanen ${n} akun ini? Tindakan ini tidak bisa dibatalkan.`)) {
                    return;
                  }
                  doDelete([...selected], "manual");
                }}
              >
                Hapus terpilih
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {job.status !== "idle" ? <JobRunner job={job} /> : null}

      {/* Usulan hapus — muncul HANYA setelah pemindaian, dan tidak pernah
          menghapus sendiri. */}
      {!running && deleteCandidates.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-[14px] border border-warning/30 bg-warning/10 p-4">
          <p className="text-sm font-medium text-text-main">
            {deleteCandidates.length} akun layak dipertimbangkan untuk dihapus
          </p>
          <p className="text-xs text-text-muted">
            Kuota habis, atau kredensialnya ditolak provider. Kesalahan jaringan dan kuota yang
            tidak terbaca sengaja TIDAK masuk daftar ini.
          </p>
          <div className="max-h-40 overflow-y-auto">
            <ul className="flex flex-col gap-0.5">
              {deleteCandidates.slice(0, 40).map((c) => (
                <li key={c.id} className="font-mono text-xs text-text-muted">
                  {c.email || c.name || c.id.slice(0, 8)} — {c.state === "depleted" ? "kuota habis" : c.error}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Button
              size="sm"
              variant="danger"
              icon="delete_sweep"
              onClick={() => {
                if (!confirm(`Hapus permanen ${deleteCandidates.length} akun ini?`)) return;
                doDelete(
                  deleteCandidates.map((c) => c.id),
                  "kuota habis / kredensial ditolak",
                );
              }}
            >
              Hapus {deleteCandidates.length} akun ini
            </Button>
          </div>
        </div>
      ) : null}

      {/* Tabel */}
      <div className="overflow-x-auto rounded-[14px] border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Akun provider dengan status dan hasil pemindaian</caption>
          <thead className="bg-bg-subtle text-[10px] uppercase tracking-wide text-text-muted">
            <tr>
              <th scope="col" className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label="Pilih semua yang terlihat"
                  checked={visible.length > 0 && selected.size >= visible.length}
                  onChange={(e) => (e.target.checked ? selectAllVisible() : clearSelection())}
                  className="size-3.5 accent-[var(--color-primary)]"
                />
              </th>
              <th scope="col" className="px-3 py-2 font-medium">Akun</th>
              <th scope="col" className="px-3 py-2 font-medium">Provider</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Kuota</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Aksi</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {visible.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-text-muted">
                  {data?.length ? "Tidak ada akun yang cocok dengan saringan." : "Belum ada akun."}
                </td>
              </tr>
            ) : (
              visible.map((c) => {
                const s = scan[c.id];
                const label = s?.state ? STATE_LABEL[s.state] : null;
                return (
                  <tr key={c.id} className="transition-colors hover:bg-bg-hover">
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        aria-label={`Pilih ${c.email || c.name || c.id}`}
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelect(c.id)}
                        className="size-3.5 accent-[var(--color-primary)]"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-text-main">
                        {c.email || c.name || `${c.id.slice(0, 8)}…`}
                      </div>
                      {c.keyPreview ? (
                        <div className="font-mono text-[10px] text-text-subtle">{c.keyPreview}</div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-text-muted">{c.providerLabel}</td>
                    <td className="px-3 py-2">
                      <span className={
                        c.status === "active" ? "text-success"
                        : c.status === "cooling" ? "text-warning"
                        : "text-text-muted"
                      }>
                        {c.status === "active" ? "aktif"
                         : c.status === "cooling" ? "cooldown"
                         : "nonaktif"}
                      </span>
                      {/* Hanya error yang BERMAKNA bagi akun yang ditampilkan.
                          `400 input_too_large` disembunyikan karena itu masalah
                          prompt; menampilkannya membuat operator mengira
                          akunnya rusak. */}
                      {c.errorState && c.errorState !== "none" && c.errorState !== "request_too_large" ? (
                        <div
                          className={`max-w-[16rem] truncate text-[10px] ${
                            c.errorState === "invalid" || c.errorState === "depleted"
                              ? "text-error"
                              : "text-text-subtle"
                          }`}
                          title={String(c.lastError || "")}
                        >
                          {c.errorReasonCode || c.errorState}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {s?.remaining != null ? (
                        <span className={label?.cls || ""}>
                          {s.remaining}%
                          {s.reason ? (
                            <span className="ml-1 text-[10px] text-text-subtle">{s.reason}</span>
                          ) : null}
                        </span>
                      ) : label ? (
                        <span className={label.cls}>{label.text}</span>
                      ) : (
                        <span className="text-text-subtle">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => doDelete([c.id], "manual")}
                        aria-label={`Hapus ${c.email || c.name || c.id}`}
                        className="rounded-md p-1 text-text-subtle transition-colors hover:bg-error/10 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
                      >
                        <span className="material-symbols-outlined text-[16px]" aria-hidden="true">
                          delete
                        </span>
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-text-muted">
        Menampilkan {visible.length} dari {data?.length ?? 0} akun
        {selected.size ? ` · ${selected.size} dipilih` : ""}.
      </p>
    </div>
  );
}
