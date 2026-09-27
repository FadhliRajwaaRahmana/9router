"use client";

import { useState } from "react";
import { SegmentedControl } from "@/shared/components";
import OAuthSection from "./OAuthSection";
import BulkImportSection from "./BulkImportSection";
import ExportSection from "./ExportSection";

const TABS = [
  { value: "oauth", label: "Tambah via OAuth" },
  { value: "bulk", label: "Bulk import" },
  { value: "export", label: "Export" },
];

/**
 * Isi halaman Automation — hanya dirender setelah gerbang password terbuka.
 *
 * Ketiga bagian dipisah karena masing-masing punya bentuk interaksi yang
 * berbeda (alur berjalan menunggu operator, tempel-token sekali jalan, dan
 * unduh berkas), dan menggabungkannya jadi satu halaman panjang membuat
 * ketiganya saling mengganggu.
 */
export default function AutomationPanel({ onLock }) {
  const [tab, setTab] = useState("oauth");
  const [locked, setLocked] = useState(false);

  const lockNow = async () => {
    setLocked(true);
    try {
      await fetch("/api/automation/gate", { method: "DELETE" });
    } finally {
      onLock();
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-lg font-semibold text-text-main">Automation</h1>
          <p className="mt-0.5 text-sm text-text-muted">
            Tambah akun provider dari sini, lalu pakai atau pindahkan kredensialnya.
          </p>
        </div>
        <button
          type="button"
          onClick={lockNow}
          disabled={locked}
          className="flex shrink-0 items-center gap-1.5 self-start rounded-lg border border-border bg-bg-subtle px-2.5 py-1.5 text-xs font-medium text-text-muted transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
        >
          <span className="material-symbols-outlined text-[15px]" aria-hidden="true">
            lock
          </span>
          <span>Kunci lagi</span>
        </button>
      </div>

      <SegmentedControl options={TABS} value={tab} onChange={setTab} className="w-full sm:w-auto" />

      {tab === "oauth" ? <OAuthSection /> : null}
      {tab === "bulk" ? <BulkImportSection /> : null}
      {tab === "export" ? <ExportSection /> : null}
    </div>
  );
}
