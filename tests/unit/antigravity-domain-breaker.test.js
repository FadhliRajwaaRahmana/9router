/**
 * Domain breaker — regresi untuk false-positive yang mematikan 60 akun sehat.
 *
 * Kejadian nyata (2026-09-18): satu penjual mengirim DUA batch di domain yang
 * sama — 60 akun `hww*` yang sudah dihapus Google, dan 60 akun `zvc*` yang
 * baru dan berfungsi. Ambang rasio 30% terlewati oleh batch yang mati, lalu
 * breaker menyapu seluruh domain termasuk batch yang hidup.
 *
 * Diverifikasi sesudahnya dengan menukar refresh token SETIAP akun langsung
 * ke Google: 60/60 akun yang "dinonaktifkan" mengembalikan access_token sah.
 *
 * Inti perbaikan: ambang rasio hanya memicu PEMERIKSAAN. Yang menentukan siapa
 * yang mati adalah Google, lewat penukaran refresh token per akun.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = { connections: [] };

// `rowToConn` di connectionsRepo me-flatten kolom `data` ke level atas, jadi
// refreshToken ada di `c.refreshToken` — bukan `c.data.refreshToken`. Mock ini
// meniru bentuk itu supaya test menguji jalur yang sama dengan produksi.
vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async ({ provider, isActive } = {}) => {
    if (provider && provider !== "antigravity") return [];
    let list = store.connections.filter((c) => c.provider === "antigravity");
    if (isActive === true) list = list.filter((c) => c.isActive !== false);
    return list.map((c) => ({ ...c, ...c.data }));
  },
  updateProviderConnection: async (id, patch) => {
    const c = store.connections.find((x) => x.id === id);
    if (c) {
      Object.assign(c, patch);
      // Produksi menulis isActive ke KOLOM, bukan ke dalam blob data —
      // jaga mock tetap setia supaya assertion isActive bermakna.
      if (patch.data) c.data = { ...c.data, ...patch.data };
    }
    return c;
  },
  getSettings: async () => ({}),
}));

const { maybeBreakAntigravityDomain, verifyAccountsAlive, _resetBreakerForTest } =
  await import("../../src/sse/services/antigravityDomainBreaker.js");

/**
 * Bentuk kondisi nyata: batch mati sudah ter-disable lebih dulu (itulah yang
 * menaikkan hitungan di atas ambang), lalu batch hidup masih aktif.
 *
 * `alreadyDisabled` penting — breaker menghitung `alreadyDisabled + 1`, jadi
 * tanpa batch yang sudah ter-disable ambang rasio tidak akan pernah terlewati
 * dan test tidak menguji jalur yang dimaksud.
 */
function seed(domain, aliveCount, alreadyDisabledCount) {
  store.connections = [];
  const mk = (prefix, n, opts = {}) => {
    for (let i = 1; i <= n; i++) {
      store.connections.push({
        id: `${prefix}${i}`,
        provider: "antigravity",
        email: `${prefix}${i}@${domain}`,
        isActive: opts.active !== false,
        data: { refreshToken: `rt-${prefix}${i}` },
      });
    }
  };
  // Batch mati: sudah dinonaktifkan oleh kegagalan sebelumnya.
  mk("hww", alreadyDisabledCount, { active: false });
  // Batch hidup: masih aktif, inilah yang harus dilindungi.
  mk("zvc", aliveCount, { active: true });
}

// refreshFn tiruan: akun dengan _dead=true ditolak seperti Google, sisanya
// mengembalikan access_token. Ini meniru perilaku nyata tanpa jaringan.
function fakeRefresh(creds) {
  if (String(creds.refreshToken).startsWith("rt-hww")) {
    return Promise.reject(new Error("invalid_grant: Account has been deleted"));
  }
  return Promise.resolve({ accessToken: "ya29.fresh", expiresIn: 3600 });
}

describe("verifyAccountsAlive", () => {
  it("menandai akun mati dan membiarkan akun hidup", async () => {
    seed("contoh.com", 3, 2);
    const accounts = store.connections.map((c) => ({
      id: c.id, email: c.email, refreshToken: c.data.refreshToken,
    }));
    const verdicts = await verifyAccountsAlive(accounts, fakeRefresh);

    expect(verdicts.get("hww1")).toBe(true);
    expect(verdicts.get("hww2")).toBe(true);
    expect(verdicts.get("zvc1")).toBe(false);
    expect(verdicts.get("zvc3")).toBe(false);
  });

  it("akun tanpa refreshToken tidak dihakimi (absent, bukan mati)", async () => {
    const verdicts = await verifyAccountsAlive(
      [{ id: "x1", email: "x@y.com" }],
      fakeRefresh
    );
    expect(verdicts.has("x1")).toBe(false);
  });

  it("error jaringan tidak dianggap mati", async () => {
    const flaky = () => Promise.reject(new Error("ECONNRESET"));
    const verdicts = await verifyAccountsAlive(
      [{ id: "n1", email: "n@y.com", refreshToken: "rt-zvc1" }],
      flaky
    );
    // Absent = tidak dihakimi; caller memperlakukannya sebagai tetap aktif.
    expect(verdicts.has("n1")).toBe(false);
  });
});

describe("maybeBreakAntigravityDomain — regresi batch sehat", () => {
  beforeEach(() => _resetBreakerForTest());

  it("TIDAK mematikan batch hidup di domain yang sama", async () => {
    // Kejadian nyata, direproduksi pada titik breaker terpicu:
    //   domain punya 120 akun — 60 hww* (dihapus Google) + 60 zvc* (baru, hidup)
    //   hww* gagal satu per satu; 35 sudah ter-disable saat hitungan menyentuh
    //   ambang (36/120 = 30%), jadi 25 hww* masih aktif bersama 60 zvc*.
    //
    // Breaker lama menyapu KETIGA-nya (85 akun). Yang benar: 25 hww* mati,
    // 60 zvc* tetap hidup.
    store.connections = [];
    for (let i = 1; i <= 60; i++) {
      store.connections.push({
        id: `hww${i}`, provider: "antigravity", email: `hww${i}@gmotie.com`,
        isActive: i > 35,                       // 35 sudah ter-disable
        data: { refreshToken: `rt-hww${i}` },
      });
    }
    for (let i = 1; i <= 60; i++) {
      store.connections.push({
        id: `zvc${i}`, provider: "antigravity", email: `zvc${i}@gmotie.com`,
        isActive: true,                          // batch baru, semua hidup
        data: { refreshToken: `rt-zvc${i}` },
      });
    }

    const verdict = await maybeBreakAntigravityDomain(
      "hww36@gmotie.com", "antigravity", { refreshFn: fakeRefresh }
    );

    const zvcAktif = store.connections.filter(
      (c) => c.email.startsWith("zvc") && c.isActive !== false
    );
    const hwwAktif = store.connections.filter(
      (c) => c.email.startsWith("hww") && c.isActive !== false
    );

    // Batch hidup harus utuh — inilah regresi yang dijaga test ini.
    expect(zvcAktif.length).toBe(60);
    // Sisa batch mati yang masih aktif harus dinonaktifkan.
    expect(hwwAktif.length).toBe(0);
    expect(verdict.deadCount).toBe(25);
    expect(verdict.aliveCount).toBe(60);
  });

  it("tidak menonaktifkan apa pun kalau verifikasi menemukan semua hidup", async () => {
    // Ambang rasio terlewati (30 sudah ter-disable, 40 aktif), tapi verifikasi
    // membuktikan SEMUA masih hidup — termasuk yang dianggap mati. Karena itu
    // 30 yang nonaktif harus DIBIARKAN seperti adanya (bukan diaktifkan —
    // breaker tidak punya wewenang reaktivasi), dan 40 yang aktif tetap aktif.
    seed("sehat.com", 40, 30);
    const allAlive = () => Promise.resolve({ accessToken: "ya29.ok" });
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@sehat.com", "antigravity", { refreshFn: allAlive }
    );

    const aktif = store.connections.filter((c) => c.isActive !== false);
    expect(aktif.length).toBe(40);
    expect(verdict.broken).toBe(false);
    expect(verdict.disabledCount).toBe(0);
  });

  it("mematikan akun mati dan MENGABAIKAN yang sudah nonaktif", async () => {
    // 30 hww mati yang SUDAH nonaktif + 30 zvc hidup yang masih aktif.
    // Semua yang AKTIF lolos verifikasi, jadi breaker tidak mematikan apa pun
    // dan keluar lebih awal — tidak ada akun hidup yang boleh tersentuh.
    seed("campur.com", 30, 30);
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@campur.com", "antigravity", { refreshFn: fakeRefresh }
    );

    const aktif = store.connections.filter((c) => c.isActive !== false);
    expect(aktif.length).toBe(30);
    expect(aktif.every((c) => c.email.startsWith("zvc"))).toBe(true);
    // Tidak ada yang mati di antara yang aktif -> early return, tanpa disabledCount.
    expect(verdict.broken).toBe(false);
    expect(verdict.disabledCount).toBe(0);
  });

  it("domain whitelist (gmail.com) tidak pernah di-break", async () => {
    seed("gmail.com", 5, 5);
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@gmail.com", "antigravity", { refreshFn: fakeRefresh }
    );
    expect(verdict.broken).toBe(false);
    // Breaker tidak menyentuh apa pun; 5 yang aktif tetap aktif.
    const aktif = store.connections.filter((c) => c.isActive !== false);
    expect(aktif.length).toBe(5);
  });

  it("provider selain antigravity diabaikan", async () => {
    seed("lain.com", 5, 5);
    const verdict = await maybeBreakAntigravityDomain(
      "hww1@lain.com", "gemini", { refreshFn: fakeRefresh }
    );
    expect(verdict.broken).toBe(false);
  });
});
