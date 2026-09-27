"use client";

import { useState } from "react";
import AutomationGate from "./components/AutomationGate";
import AutomationPanel from "./components/AutomationPanel";

/**
 * /dashboard/automation — tambah akun provider dari web.
 *
 * Halaman ini punya DUA lapis, dan keduanya beda peran:
 *
 *   1. Sesi dashboard — sudah berlaku sebelum halaman ini bisa dibuka sama
 *      sekali. Dijaga oleh sisa aplikasi, bukan di sini.
 *   2. Gerbang password (AUTOMATION_PASSWORD) — dijaga halaman ini, karena
 *      halaman ini bisa membuka dan memindahkan kredensial SEMUA akun.
 *
 * Yang dibuka gerbang adalah `AutomationPanel`; selama belum terbuka, tidak ada
 * satu pun permintaan API automation yang dijalankan — jadi tidak ada data akun
 * yang sempat dikirim ke browser orang yang belum memasukkan password.
 */
export default function AutomationPage() {
  const [unlocked, setUnlocked] = useState(false);

  if (!unlocked) {
    return <AutomationGate onUnlock={() => setUnlocked(true)} />;
  }

  return <AutomationPanel onLock={() => setUnlocked(false)} />;
}
