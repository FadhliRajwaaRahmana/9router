import { deleteProviderConnection } from "@/lib/localDb";
import { createJob, runJob } from "./jobs.js";

/**
 * Operasi massal untuk menu Automation.
 *
 * ── Prinsip yang mengikat seluruh berkas ini ────────────────────────────────
 *
 * **MEMBACA KUOTA MEMAKAI MESIN 9ROUTER, BUKAN MENYALINNYA.**
 *
 * Skrip terminal menghitung kuota sendiri: panggil upstream, parse
 * `remainingFraction`, kelompokkan per model. 9Router sudah mengerjakan itu
 * untuk 25 provider lewat `open-sse/services/usage/`, dan hasilnya LEBIH BAIK:
 * ia menyimpan `resetAt` (skrip membuangnya), memakai daftar model yang lebih
 * lengkap, dan menangani refresh token sendiri. Menyalin logika skrip berarti
 * membangun sumber kebenaran kedua yang akan menyimpang — persis kesalahan yang
 * sudah terjadi di repo ini pada daftar provider.
 *
 * Karena itu setiap pemeriksaan kuota di sini memanggil
 * `GET /api/usage/{connectionId}` lewat mesin yang sama.
 *
 * ── Tiga bug skrip yang SENGAJA TIDAK ditiru ────────────────────────────────
 *
 * 1. `ag`: ambang hapus `pct < 1` tidak mengecualikan sentinel `-1` ("kuota
 *    tidak terbaca"), dan `-1 < 1` bernilai benar — akun yang kuotanya gagal
 *    dibaca ikut terhapus. Di sini "tidak terbaca" adalah keadaan tersendiri
 *    dan TIDAK PERNAH memicu penghapusan.
 * 2. `bai`: penghapusan otomatis memakai `not ok` mentah, sehingga akun sehat
 *    yang sekadar gagal jaringan saat pemindaian ikut terhapus. Di sini hanya
 *    keadaan yang benar-benar final (kredensial mati / kuota habis) yang masuk
 *    daftar usulan hapus; kesalahan jaringan tidak.
 * 3. `tokenharbor`: dedup membaca kolom yang salah (`row[2]` adalah `name`,
 *    bukan `data`), sehingga selalu menyisipkan baris baru dan duplikat
 *    menumpuk. Dedup di sini dikerjakan di satu tempat, oleh pemanggil, dengan
 *    kunci yang benar.
 *
 * Yang juga tidak ditiru: skrip mencetak 25 karakter pertama API key ke layar.
 * Di sini hanya awalan pendek yang ditampilkan, dan hanya kalau perlu.
 */

/**
 * Provider yang punya handler kuota di 9Router.
 *
 * Disalin dari `open-sse/services/usage.js` — dan itu disengaja: berkas ini
 * harus bisa memberi tahu operator "provider ini belum punya cek kuota" tanpa
 * memanggil handler yang tidak ada. Yang penting, daftarnya di sini hanya untuk
 * MEMUTUSKAN apakah menawarkan tombol; angka kuotanya tetap datang dari mesin
 * 9Router.
 */
export const PROVIDERS_WITH_USAGE = new Set([
  "github", "gemini-cli", "antigravity", "claude", "codex", "kiro", "qoder",
  "iflow", "ollama", "glm", "glm-cn", "minimax", "minimax-cn",
  "vercel-ai-gateway", "codebuddy-cn", "codebuddy-intl", "grok-cli", "kimi",
  "opencode-go", "deepseek", "freebuff", "zed", "meta-code",
]);

/**
 * Ubah payload `GET /api/usage/{id}` menjadi keadaan yang bisa dipakai UI.
 *
 * Bentuk payloadnya berbeda antar provider — ada yang mengembalikan `quotas[]`,
 * ada yang mengembalikan `message`, ada yang mengembalikan `plan` saja. Yang
 * TIDAK boleh terjadi: menyimpulkan "habis" dari ketiadaan data.
 *
 * `remaining` adalah persentase sisa TERENDAH di antara kuota yang terbaca —
 * model yang paling habis menentukan kesehatan akun, karena satu model yang
 * habis sudah cukup membuat request ke model itu gagal.
 */
export function classifyUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { state: "unknown", reason: "Tidak ada data kuota", remaining: null };
  }

  // Pesan tanpa angka: provider belum terhubung, atau handler-nya tidak ada.
  if (usage.message && !usage.quotas) {
    const msg = String(usage.message);
    const missing = /not implemented|not available|credential not available/i.test(msg);
    return {
      state: missing ? "unsupported" : "unknown",
      reason: msg,
      remaining: null,
    };
  }

  const quotas = Array.isArray(usage.quotas) ? usage.quotas : [];

  // Kuota yang punya angka. `unlimited` sengaja tidak dihitung sebagai "sisa":
  // akun tanpa batas tidak sedang menipis.
  const measured = quotas.filter(
    (q) => typeof q?.remainingPercentage === "number" && !q.unlimited,
  );

  if (!measured.length) {
    // Akun tanpa kuota terukur bukan akun yang habis. Ini keadaan yang harus
    // ditampilkan apa adanya, bukan dipaksa jadi angka.
    return {
      state: quotas.length ? "unlimited" : "unknown",
      reason: quotas.length ? "Tanpa batas kuota terukur" : "Kuota tidak terbaca",
      remaining: null,
    };
  }

  const remaining = Math.min(...measured.map((q) => q.remainingPercentage));
  const worst = measured.reduce((a, b) =>
    a.remainingPercentage <= b.remainingPercentage ? a : b,
  );

  let state;
  if (remaining <= 0) state = "depleted";
  else if (remaining <= 5) state = "critical";
  else if (remaining <= 30) state = "low";
  else state = "healthy";

  return {
    state,
    // Nama kuota terburuk ikut dibawa: "Gemini 2.5 Pro: 0%" jauh lebih berguna
    // daripada "0%" tanpa konteks.
    reason: worst?.displayName || worst?.modelId || worst?.model || null,
    remaining: Math.round(remaining * 10) / 10,
    resetAt: worst?.resetAt || null,
    quotas: measured.map((q) => ({
      label: q.displayName || q.modelId || q.model || "?",
      remainingPercentage: Math.round((q.remainingPercentage || 0) * 10) / 10,
      resetAt: q.resetAt || null,
      unlimited: !!q.unlimited,
    })),
  };
}

/**
 * Nama provider yang bisa dibaca manusia.
 *
 * Provider kustom ber-id UUID ("openai-compatible-chat-7665141b-a127-…"), dan
 * UUID terpotong tidak berarti apa-apa bagi operator yang mengenalinya sebagai
 * "b.ai" atau "tokenharbour". `nodeName` di dalam `providerSpecificData` berisi
 * nama yang dipasang saat provider itu dibuat.
 *
 * Dua provider di mesin ini menyimpan `nodeName` yang BUKAN nama melainkan id
 * node ("b.ai" dibuat oleh skrip yang menulis nodeName = id); karena itu nilainya
 * dipakai hanya kalau memang bukan id provider itu sendiri.
 */
function providerLabel(connection) {
  const node = connection?.providerSpecificData?.nodeName;
  if (node && node !== connection.provider && !/^openai-compatible-chat-/.test(node)) {
    return node;
  }
  return connection.provider;
}

/**
 * Apakah `lastError` sebuah koneksi menandakan AKUNNYA bermasalah.
 *
 * ── Mengapa ini tidak boleh sekadar memeriksa ada/tidaknya ──────────────────
 *
 * Terukur pada instalasi nyata: 146 dari 156 koneksi `grok-cli` punya
 * `lastError` berisi
 *
 *   [400] invalid-argument: Failed to start sampling: [input_too_large]
 *   The prompt is too long for this model's context window
 *
 * Semuanya sehat. Yang salah adalah REQUEST-nya (prompt melebihi jendela
 * konteks), bukan kredensialnya — dan error itu akan hilang sendiri pada
 * request berikutnya yang lebih pendek. Menandai akun "bermasalah" hanya karena
 * `lastError` ada isinya akan melaporkan 146 akun sehat sebagai rusak, dan
 * operator yang mempercayainya akan menghapus akun yang tidak pernah salah.
 *
 * Jadi yang diperiksa adalah MAKNA-nya, bukan keberadaannya:
 *   · 401/403            → kredensial ditolak; tidak akan pulih sendiri
 *   · 402 + kuota/kredit → habis; pulih saat diisi atau reset
 *   · 400 / prompt terlalu panjang / parameter salah → MASALAH REQUEST, abaikan
 *   · 429                → laju; sementara, jangan pernah dihapus
 *   · 5xx / jaringan     → bisa hilang sendiri, jangan pernah dihapus
 */
export function classifyConnectionError(connection) {
  const code = Number(connection?.errorCode);
  const raw = String(connection?.lastError || "");
  const lower = raw.toLowerCase();

  if (!raw && !code) return { state: "none", reason: null };

  // Kredensial mati. Satu-satunya kategori yang aman untuk diusulkan hapus.
  //
  // `invalid_grant` dan `revoked` ikut dikenali TANPA kode HTTP: refresh token
  // yang dicabut sering dilaporkan sebagai error OAuth di badan respons dengan
  // status 200, sehingga kodenya tidak pernah muncul. Kalau hanya bergantung
  // pada 401/403, akun yang jelas-jelas sudah dicabut akan terbaca "lainnya"
  // dan tidak pernah masuk daftar.
  const revoked = /invalid_grant|revoked|unauthenticated|re-authorize/i.test(raw);
  if (code === 401 || code === 403 || /\b(401|403)\b/.test(raw) || revoked) {
    return {
      state: "invalid",
      reason: revoked ? "Kredensial dicabut" : "Ditolak provider (401/403)",
    };
  }

  // Kuota habis. Soft-fail: kredensialnya baik, hanya tidak ada sisa.
  if (
    code === 402 ||
    /\b402\b/.test(raw) ||
    /insufficient|balance|credit|quota|spending.?limit|blocked/i.test(lower)
  ) {
    return { state: "depleted", reason: "Kuota / kredit habis" };
  }

  if (code === 429 || /\b429\b/.test(raw) || /rate.?limit|too many/i.test(lower)) {
    return { state: "rate_limited", reason: "Kena laju sementara" };
  }

  // MASALAH REQUEST — bukan masalah akun. Ini yang paling mudah salah.
  if (
    /input_too_large|prompt is too long|context window|invalid.?argument|invalid.?request/i.test(lower)
  ) {
    return { state: "request_too_large", reason: "Prompt melebihi konteks (bukan akun)" };
  }

  if (code >= 500 || /fetch|timeout|econn|network|socket/i.test(lower)) {
    return { state: "transient", reason: "Gangguan jaringan / server" };
  }

  return { state: "other", reason: raw.slice(0, 120) };
}

/**
 * Status efektif sebuah koneksi, mengikuti aturan yang sudah dipakai dashboard.
 *
 * `testStatus === "unavailable"` BUKAN berarti akunnya rusak: nilai itu ditulis
 * jalur fallback runtime saat satu request gagal, bersama `modelLock_<model>`.
 * Setelah cooldown-nya lewat, akun itu aktif kembali. Dashboard 9Router sendiri
 * memperlakukannya begitu (`ConnectionsCard.js`: `unavailable` + cooldown lewat
 * → tampilkan aktif). Menampilkan nilai mentahnya akan melabeli 146 dari 156
 * akun sebagai rusak di instalasi nyata.
 */
export function effectiveStatus(connection) {
  if (connection?.isActive === false) return "inactive";

  const raw = connection?.testStatus;
  if (raw === "active" || raw === "success") return "active";

  if (raw === "unavailable" || raw === "error" || raw === "expired") {
    // Kalau masih ada model-lock yang belum lewat, memang sedang tidak bisa
    // dipakai. Kalau sudah lewat, statusnya tinggal catatan sejarah.
    const now = Date.now();
    const locked = Object.entries(connection || {}).some(([k, v]) => {
      if (!k.startsWith("modelLock_")) return false;
      const t = typeof v === "number" ? v : Date.parse(v);
      return Number.isFinite(t) && t > now;
    });
    return locked ? "cooling" : "active";
  }

  return "active";
}

/**
 * Ambil kuota satu koneksi lewat API 9Router sendiri.
 *
 * `origin` diperlukan karena pekerjaan berjalan di server yang sama — memanggil
 * URL relatif tidak mungkin dari sini, dan memanggil `127.0.0.1` secara
 * hardcode akan salah di deployment yang port-nya bukan default.
 */
async function fetchUsageFor(origin, connectionId, cookie, { force = false } = {}) {
  const url = `${origin}/api/usage/${connectionId}${force ? "?force=1" : ""}`;
  const res = await fetch(url, {
    headers: { Cookie: cookie },
    cache: "no-store",
  });
  if (res.status === 404) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    return { message: data?.error || `HTTP ${res.status}` };
  }
  return data;
}

/**
 * Cek kuota sekumpulan koneksi. Mengembalikan job; kemajuannya dipantau klien.
 *
 * `concurrency` kecil (4) dan sengaja tidak lebih: setiap item melakukan
 * permintaan keluar ke provider yang sama, dan 4 sudah cukup untuk membuat
 * pemindaian ratusan akun terasa cepat tanpa terlihat seperti serangan.
 */
export async function startQuotaCheck({ origin, cookie, connections, provider = null }) {
  const targets = connections.filter((c) => {
    if (provider && c.provider !== provider) return false;
    return true;
  });

  const job = createJob({
    kind: "quota",
    label: provider ? `Cek kuota ${provider}` : "Cek kuota semua akun",
    total: targets.length,
    meta: { provider },
  });

  // Tidak ditunggu: klien memantau lewat /status. `runJob` menangkap errornya
  // sendiri dan menuliskannya ke job, jadi tidak ada penolakan yang lepas.
  void runJob(
    job,
    targets,
    async (conn) => {
      const label = providerLabel(conn);
      const supported = PROVIDERS_WITH_USAGE.has(conn.provider);

      if (!supported) {
        return {
          ok: true,
          id: conn.id,
          name: conn.name,
          email: conn.email,
          provider: label,
          state: "unsupported",
          reason: "Provider ini belum punya cek kuota di 9Router",
        };
      }

      const usage = await fetchUsageFor(origin, conn.id, cookie);
      if (!usage) {
        return {
          ok: false,
          id: conn.id,
          name: conn.name,
          email: conn.email,
          provider: label,
          error: "Koneksi tidak ditemukan",
        };
      }

      const info = classifyUsage(usage);
      return {
        ok: true,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: label,
        ...info,
      };
    },
    { concurrency: 4 },
  );

  return job;
}

/**
 * Uji kelayakan kredensial sekumpulan koneksi, memakai endpoint uji 9Router.
 *
 * Berbeda dari cek kuota: ini tidak memanggil provider satu per satu dengan
 * logika sendiri, melainkan memakai `POST /api/providers/{id}/test` yang sudah
 * tahu cara menguji 18 provider, termasuk refresh token dan proxy.
 */
export async function startConnectionTest({ origin, cookie, connections, provider = null }) {
  const targets = connections.filter((c) => !provider || c.provider === provider);

  const job = createJob({
    kind: "test",
    label: provider ? `Test koneksi ${provider}` : "Test koneksi semua akun",
    total: targets.length,
    meta: { provider },
  });

  void runJob(
    job,
    targets,
    async (conn) => {
      const res = await fetch(`${origin}/api/providers/${conn.id}/test`, {
        method: "POST",
        headers: { Cookie: cookie },
        cache: "no-store",
      });
      const data = await res.json().catch(() => ({}));
      return {
        ok: !!data?.valid,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: providerLabel(conn),
        latencyMs: data?.latencyMs ?? null,
        error: data?.valid ? null : data?.error || `HTTP ${res.status}`,
      };
    },
    { concurrency: 3 },
  );

  return job;
}

/**
 * Hapus sekumpulan koneksi berdasarkan id.
 *
 * Dipanggil HANYA setelah operator menekan tombol hapus di UI, dan UI wajib
 * menampilkan daftar sasaran lebih dulu. Tidak ada jalur "hapus otomatis saat
 * pemindaian" seperti di skrip: pemindaian dan penghapusan adalah dua tindakan
 * terpisah, sehingga kesalahan klasifikasi tidak langsung berakibat hilangnya
 * akun. Itu satu-satunya pertahanan yang benar-benar bekerja terhadap bug
 * seperti sentinel `-1` di `ag`.
 */
export async function startDelete({ connections, ids, reason = "manual" }) {
  const wanted = new Set(ids);
  const targets = connections.filter((c) => wanted.has(c.id));

  const job = createJob({
    kind: "delete",
    label: `Hapus ${targets.length} akun`,
    total: targets.length,
    meta: { reason },
  });

  void runJob(job, targets, async (conn) => {
    try {
      await deleteProviderConnection(conn.id);
      return {
        ok: true,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: providerLabel(conn),
      };
    } catch (err) {
      return {
        ok: false,
        id: conn.id,
        name: conn.name,
        email: conn.email,
        provider: providerLabel(conn),
        error: err?.message || "Gagal menghapus",
      };
    }
  });

  return job;
}

/**
 * Kandidat hapus, DENGAN alasan yang bisa diperiksa operator.
 *
 * Fungsi ini hanya MENYARING; ia tidak menghapus apa pun. Pemisahannya penting:
 * daftar yang salah masih bisa dibatalkan oleh operator, sedangkan penghapusan
 * otomatis tidak.
 *
 * Aturan penyaringan, dan alasan tiap pengecualian:
 *   · `depleted`  → kuota benar-benar habis (angka terbaca, bukan sentinel)
 *   · `invalid`   → kredensial ditolak provider (401/403), tidak akan pulih
 *   · `unsupported`/`unknown` → TIDAK PERNAH masuk daftar
 *   · kesalahan jaringan → TIDAK PERNAH masuk daftar
 */
export function selectDeleteCandidates(results, { includeDepleted = true, includeInvalid = true } = {}) {
  const picked = [];
  // Daftar kosong/null berarti "tidak ada yang dipindai", bukan "hapus semua".
  // Iterasi atas null akan melempar; yang lebih berbahaya, pemanggil yang
  // menangkapnya lalu jatuh ke cabang "hapus semua" akan menghapus seluruh akun.
  for (const r of Array.isArray(results) ? results : []) {
    if (!r) continue;
    if (includeDepleted && r.state === "depleted") {
      picked.push({ ...r, deleteReason: "Kuota habis" });
      continue;
    }
    if (includeInvalid && r.state === "invalid") {
      picked.push({ ...r, deleteReason: "Kredensial ditolak provider" });
    }
  }
  return picked;
}

/**
 * Usulan hapus dari DAFTAR KONEKSI (bukan dari hasil pemindaian kuota).
 *
 * Dipakai untuk akun yang gagal sebelum sempat dipindai — mis. kredensialnya
 * sudah ditolak sehingga permintaan kuota tidak pernah sampai. Sumber
 * kebenarannya adalah `lastError` yang sudah diklasifikasi, BUKAN keberadaan
 * `lastError` itu sendiri.
 */
export function candidatesFromConnections(connections) {
  const picked = [];
  for (const c of connections || []) {
    const cls = classifyConnectionError(c);
    if (cls.state === "invalid" || cls.state === "depleted") {
      picked.push({
        ...c,
        id: c.id,
        email: c.email,
        name: c.name,
        provider: providerLabel(c),
        state: cls.state,
        deleteReason: cls.reason,
      });
    }
  }
  return picked;
}
