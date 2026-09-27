/**
 * Katalog provider menu Automation.
 *
 * ── Enam provider, sesuai enam skrip ────────────────────────────────────────
 *
 *   antigravity  ←  add-account-ag-9router.py        (117 akun)
 *   b.ai         ←  add-account-bai-9router.py       (600 akun)
 *   cline        ←  add-account-cline-oauth-...py    (2 akun)
 *   grok-cli     ←  add-account-grok-9router.py      (156 akun)
 *   tokenharbour ←  add-account-tokenharbor-...py    (118 akun)
 *   freebuff     ←  add-freebuff-deviceflow-...py    (1 akun)
 *
 * Katalog ini MENENTUKAN bentuk menu: provider yang tidak ada di sini tidak
 * muncul, dan fitur yang tidak dicentang tidak ditawarkan. Itu disengaja —
 * menu yang menawarkan tombol yang selalu gagal lebih buruk daripada menu
 * pendek.
 *
 * ── `kinds` menentukan operasi apa saja yang benar-benar didukung ───────────
 *
 * Tiap nilai di sini punya alasan yang bisa ditunjukkan, bukan tebakan:
 *
 *   quota   → provider punya handler di `open-sse/services/usage.js`
 *   test    → provider punya entri di `api/providers/[id]/test/testUtils.js`
 *   prompt  → bisa diuji lewat `/v1/chat/completions` dengan `x-connection-id`
 *   import  → ada format berkas token yang jelas (dari skripnya)
 *   calls   → skripnya bisa MEMBUAT akun baru lewat browser (TIDAK dibangun)
 *
 * `quota: false` bukan berarti providernya buruk — hanya berarti 9Router belum
 * punya cara membaca kuotanya, dan menawarkan tombolnya akan berbohong.
 */

/** Akun kustom dengan id panjang; dipakai untuk menemukannya di database. */
export const CUSTOM_PROVIDER_IDS = {
  bai: "openai-compatible-chat-7665141b-a127-4995-9278-94eaec46f1b6",
  tokenharbour: "openai-compatible-chat-d6371244-0ef9-4eca-91f7-2acf38219814",
};

export const AUTOMATION_CATALOGUE = [
  {
    id: "antigravity",
    label: "Antigravity",
    source: "add-account-ag-9router.py",
    accountKind: "oauth",
    kinds: { quota: true, test: true, prompt: true, import: "token", calls: "browser" },
    /** Grup kuota dari skrip, dipakai untuk menamai baris di tabel. */
    note: "Kuota per grup model (Gemini / Claude & GPT). Reset time tersedia.",
  },
  {
    id: "bai",
    label: "B.AI",
    providerId: CUSTOM_PROVIDER_IDS.bai,
    source: "add-account-bai-9router.py",
    accountKind: "apikey",
    keyPrefix: "sk-",
    kinds: { quota: false, test: true, prompt: true, import: "key", calls: "browser" },
    note: "Kuota diperiksa lewat inferensi nyata (tidak ada endpoint saldo).",
  },
  {
    id: "cline",
    label: "Cline",
    source: "add-account-cline-oauth-9router.py",
    accountKind: "oauth",
    kinds: { quota: false, test: true, prompt: true, import: "token", calls: "browser" },
    refreshable: true,
    note: "Token berumur 1 jam; refresh proaktif ambang 300 detik.",
  },
  {
    id: "grok-cli",
    label: "Grok CLI",
    source: "add-account-grok-9router.py",
    accountKind: "oauth",
    kinds: { quota: true, test: true, prompt: true, import: "token", calls: "browser" },
    note: "Kuota billing + deteksi team_blocked langsung ke xAI.",
  },
  {
    id: "tokenharbour",
    label: "TokenHarbor",
    providerId: CUSTOM_PROVIDER_IDS.tokenharbour,
    source: "add-account-tokenharbor-9router.py",
    accountKind: "apikey",
    keyPrefix: "thk_",
    kinds: { quota: false, test: true, prompt: true, import: "key", calls: "browser" },
    /** Akun bisa diberi masa berlaku saat diimpor. */
    expiry: true,
    note: "Mendukung masa berlaku akun (expire hours) dan pembersihan otomatis.",
  },
  {
    id: "freebuff",
    label: "Freebuff",
    source: "add-freebuff-deviceflow-9router.py",
    accountKind: "oauth",
    kinds: { quota: true, test: true, prompt: true, import: "token", calls: "device" },
    /** Satu akun = satu model, kalau tidak upstream menjawab 409 model_locked. */
    modelAssign: true,
    note: "Satu akun hanya boleh memakai satu model; login lewat device flow.",
  },
];

export function getCatalogueEntry(id) {
  return AUTOMATION_CATALOGUE.find((p) => p.id === id) || null;
}

/**
 * Provider id sesungguhnya di database untuk sebuah entri katalog.
 *
 * `b.ai` dan `tokenharbour` disimpan sebagai provider kustom ber-id UUID, dan
 * id itu ditentukan saat provider dibuat — di mesin lain id-nya bisa berbeda.
 * Karena itu entri katalog menyimpan id yang diketahui, dan pemanggil harus
 * memakai fungsi ini alih-alih menulis `entry.id` langsung.
 */
export function resolveProviderId(entry) {
  return entry?.providerId || entry?.id || null;
}

/** Semua provider id yang mungkin, untuk menyaring daftar koneksi. */
export function catalogueProviderIds() {
  return AUTOMATION_CATALOGUE.map((p) => resolveProviderId(p)).filter(Boolean);
}

/**
 * Cocokkan sebuah koneksi ke entri katalog.
 *
 * Pencocokan memakai provider id ATAU `prefix` di `providerSpecificData`.
 * Alasannya: pada instalasi nyata, `b.ai` dan `tokenharbour` dibuat skrip
 * Python di waktu berbeda, dan id-nya tidak selalu sama dengan yang tertulis di
 * skrip — sedangkan `prefix` (`bai`, `tokenharbor`) stabil karena itu yang
 * dipakai model alias di 9Router.
 */
export function matchCatalogueEntry(connection) {
  if (!connection) return null;
  const direct = AUTOMATION_CATALOGUE.find((p) => resolveProviderId(p) === connection.provider);
  if (direct) return direct;

  const prefix = connection.providerSpecificData?.prefix;
  if (!prefix) return null;
  return (
    AUTOMATION_CATALOGUE.find((p) => p.keyPrefix === prefix || p.id === prefix) ||
    AUTOMATION_CATALOGUE.find(
      (p) => p.id.startsWith(prefix) || prefix.startsWith(p.id.replace(/-/g, "")),
    ) ||
    null
  );
}
