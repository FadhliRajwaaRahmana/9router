"use client";

import { useMemo, useState } from "react";
import {
  fmtCost,
  fmtFull,
  fmtCount,
  fmtPercent,
  fmtTokenDetail,
  share,
  VALUE_MODES,
  PERIOD_LABELS,
} from "./format";

/**
 * Kepala tumpukan — lapis teratas halaman.
 *
 * Ini BUKAN "hero metric" (angka besar + label kecil + statistik pendukung):
 * bentuk itu kartu generik yang bisa ditempel di produk apa pun. Yang ini
 * membaca data yang khas 9Router:
 *
 *   1. Nilai utama hanya SATU, dan bisa diganti oleh operator (biaya ↔ token).
 *   2. Di sebelahnya, proporsi antar-provider digambar sebagai satu batang
 *      bertumpuk — jadi "ke mana pemakaian pergi" terjawab sebelum menggulir,
 *      bukan sebagai tiga angka terpisah yang harus dijumlahkan sendiri.
 *   3. Barisnya menyambung ke garis aliran di bawah (jalur request masuk→provider),
 *      sehingga kepala ini terasa sebagai AWAL tumpukan, bukan kartu yang
 *      mengambang di atasnya.
 *
 * Angka utama memakai lebar kolom tetap dan `tabular-nums`; nilai yang berubah
 * dari SSE tidak menggeser tata letak.
 */

/**
 * Label provider untuk legenda & tooltip: pakai nama node kalau ada, kalau
 * tidak potong id-nya.
 *
 * Didefinisikan di tingkat modul — bukan di dalam komponen — supaya identitas
 * fungsinya stabil. Sebagai closure di dalam komponen, ia berubah setiap render
 * dan memaksa `useMemo` yang memakainya ikut dihitung ulang, atau memicu
 * peringatan dependensi yang tidak bisa dipenuhi dengan benar.
 *
 * Strip dan legenda harus menyebut hal yang SAMA dengan yang diklik operator di
 * lapis provider di bawahnya.
 */
function providerLabel(id, nodeNames) {
  if (nodeNames?.[id]) return nodeNames[id];
  return id.length <= 22 ? id : `${id.slice(0, 14)}…`;
}

export default function StackHead({
  stats,
  mode,               // "costs" | "tokens"
  period,
  onModeChange,
  onSelectProvider,   // klik segmen batang → saring seluruh halaman
  selectedProvider,
  nodeNames = {},     // id node kustom → nama yang bisa dibaca manusia
}) {
  // Semua hook di atas: tidak boleh ada early return atau hook bersyarat di
  // atas sini, karena urutan hook harus sama di setiap render.
  const [restOpen, setRestOpen] = useState(false);

  // Basis peringkat untuk mode ini. Di mode "both" ini berarti biaya; lihat
  // catatan di format.js soal kenapa bukan gabungan keduanya.
  const ranksByTokens = mode === "tokens";

  const {
    providers, total, headCost, headTokens, headIn, headOut, headCached,
    requests, activeCount, errorProvider,
  } = useMemo(() => {
    const byProvider = stats?.byProvider || {};
    const rows = Object.entries(byProvider)
      .map(([id, d]) => ({
        id,
        requests: d?.requests || 0,
        promptTokens: d?.promptTokens || 0,
        completionTokens: d?.completionTokens || 0,
        cachedTokens: d?.cachedTokens || 0,
        tokens: (d?.promptTokens || 0) + (d?.completionTokens || 0),
        cost: d?.cost || 0,
      }))
      .sort((a, b) => (ranksByTokens ? b.tokens - a.tokens : b.cost - a.cost));

    const sum = (fn) => rows.reduce((acc, r) => acc + fn(r), 0);

    return {
      providers: rows,
      total: sum((r) => (ranksByTokens ? r.tokens : r.cost)),
      // Semua total dihitung SEKALI di sini, dari daftar yang sama. Mode
      // memutuskan mana yang besar dan mana yang kecil, bukan mana yang ada —
      // sehingga "Cost + Tokens" tidak perlu menghitung ulang apa pun.
      headCost: sum((r) => r.cost),
      headTokens: sum((r) => r.tokens),
      // Pecahan token. `headCached` adalah BAGIAN DARI `headIn`, bukan
      // tambahan — lihat catatan fmtTokenDetail di format.js. Karena itu
      // ketiganya dilaporkan apa adanya dari data, tanpa penjumlahan silang.
      headIn: sum((r) => r.promptTokens),
      headOut: sum((r) => r.completionTokens),
      headCached: sum((r) => r.cachedTokens),
      requests: stats?.totalRequests || 0,
      activeCount: (stats?.activeRequests || []).reduce((s, a) => s + (a.count || 0), 0),
      errorProvider: stats?.errorProvider || null,
    };
  }, [stats, ranksByTokens]);

  // Tiga provider teratas dapat warna; sisanya satu warna netral. Dipisah
  // supaya batang tetap terbaca saat providernya banyak — 12 warna berbeda
  // pada batang setipis ini tidak bisa dibedakan siapa pun.
  //
  // Pembedanya adalah OPASITAS dari satu hue, bukan campuran dengan warna teks.
  // Mencampur oranye dengan `text-main` menghasilkan cokelat keruh yang terbaca
  // sebagai "oranye kotor", bukan sebagai kategori berbeda — dan di mode gelap
  // campuran itu justru makin gelap sehingga dua segmen nyaris sama.
  const segments = useMemo(() => {
    // Dasar proporsi sama dengan dasar peringkat: satu besaran per mode,
    // dipilih di satu tempat (`ranksByTokens`). Strip yang dihitung dari biaya
    // sementara baris di bawahnya diurutkan dari token akan terbaca sebagai
    // dua pernyataan yang saling bertentangan.
    const basis = (r) => (ranksByTokens ? r.tokens : r.cost);

    // Provider dengan porsi NOL tapi punya request tetap ikut ditampilkan:
    // provider gratis (biaya $0) bisa melayani ratusan request, dan
    // menyembunyikannya membuat strip berbohong tentang ke mana trafik pergi.
    // Yang dibuang hanya provider yang memang tidak punya aktivitas sama sekali.
    const active = providers.filter((r) => basis(r) > 0 || r.requests > 0);
    const top = active.slice(0, 3);
    const rest = active.slice(3);

    const segs = top.map((r) => ({
      id: r.id,
      label: providerLabel(r.id, nodeNames),
      value: basis(r),
      pct: share(basis(r), total),
      requests: r.requests,
      rank: top.indexOf(r),
      // Nilai PENUH untuk atribut `title`/`aria-label`: segmen setipis ini
      // tidak mungkin memuat angka panjang, tapi angka itu harus tetap
      // terjangkau — singkatan yang hanya ada di tooltip masih menyembunyikan.
      full: ranksByTokens ? `${fmtFull(r.tokens)} tokens` : fmtCost(r.cost),
    }));

    if (rest.length > 0) {
      const restValue = rest.reduce((s, r) => s + basis(r), 0);
      segs.push({
        id: "__rest",
        label: `${rest.length} others`,
        value: restValue,
        pct: share(restValue, total),
        requests: rest.reduce((s, r) => s + r.requests, 0),
        full: ranksByTokens ? `${fmtFull(restValue)} tokens` : fmtCost(restValue),
        // Daftar nama yang tersembunyi di balik "others" — dipakai legenda
        // supaya operator bisa membukanya, bukan hanya tahu ada yang disembunyikan.
        members: rest.map((r) => ({
          id: r.id,
          label: providerLabel(r.id, nodeNames),
          requests: r.requests,
          pct: share(basis(r), total),
        })),
        rank: 3,
      });
    }

    // Saat totalnya nol (semua trafik lewat provider gratis), tidak ada dasar
    // perhitungan proporsi. Strip diganti keterangan jujur — bukan batang kosong
    // yang bisa dibaca sebagai "tidak ada aktivitas".
    return segs;
  }, [providers, ranksByTokens, total, nodeNames]);

  // Ada trafik, tapi tidak ada satu pun nilai biaya/token untuk dibandingkan.
  const noBasis = total <= 0 && providers.some((r) => r.requests > 0);

  // Satu hue, empat tingkat kehadiran. `color-mix` dengan putih/transparan
  // mempertahankan keluarga warna; mencampurnya dengan warna teks akan
  // memindahkannya ke keluarga lain (oranye → cokelat).
  const segColors = [
    "var(--color-primary)",
    "color-mix(in oklab, var(--color-primary) 62%, var(--color-surface))",
    "color-mix(in oklab, var(--color-primary) 34%, var(--color-surface))",
    "var(--color-border)",
  ];

  // Daftar provider yang tersembunyi di balik "N others" — bisa dibuka supaya
  // "others" bukan jalan buntu.
  const restMembers = segments.find((s) => s.id === "__rest")?.members || [];

  const hasData = total > 0 || requests > 0;
  const providerCounter = providers.filter((r) => r.requests > 0).length;

  // Angka besar mengikuti mode. Sebelumnya mode "tokens" tetap menampilkan
  // biaya di angka besar — label berbicara tentang token sementara angkanya
  // dollar, dan itu persis jenis salah-baca yang halaman ini ada untuk
  // mencegah.
  const isTokenMode = mode === "tokens";
  const primaryValue = isTokenMode ? fmtFull(headTokens) : fmtCost(headCost);
  const secondaryValue = isTokenMode ? fmtCost(headCost) : fmtFull(headTokens);

  // Rincian token kepala. `cached` dinyatakan sebagai bagian dari input, dan
  // totalnya tetap input + output — tidak pernah ketiganya dijumlahkan. Lihat
  // catatan fmtTokenDetail di format.js.
  const tokenDetail = fmtTokenDetail({
    input: headIn,
    output: headOut,
    cached: headCached,
    total: headTokens,
  });

  // Komposisi token: input dan output sebagai satu batang bertumpuk, dengan
  // bagian cached ditandai DI DALAM porsi input. Ini satu-satunya cara jujur
  // menampilkan tiga angka ini sekaligus: cached yang digambar sebagai segmen
  // tersendiri akan terbaca sebagai tambahan, padahal ia irisan.
  const cachedShare = share(headCached, headIn);
  const outShare = share(headOut, headTokens);

  return (
    <header className="min-w-0">
      {/* Baris kendali: periode + satuan. Duduk di atas nilai, bukan di bawah,
          supaya operator tahu ANGKA INI UNTUK APA sebelum membacanya. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-xs font-medium text-text-muted">
          Usage · {PERIOD_LABELS[period] || period}
        </span>

        <div
          className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-bg-subtle p-0.5"
          role="group"
          aria-label="What to show"
        >
          {VALUE_MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onModeChange(m.id)}
              aria-pressed={mode === m.id}
              className={[
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
                mode === m.id
                  // `primary-strong`, bukan `primary`: teks putih di atas
                  // #E56A4A hanya 3,23:1 dan gagal WCAG AA untuk teks 12px.
                  // #a64027 mencapai 6,21:1 dan tetap oranye yang sama.
                  ? "bg-primary-strong text-white shadow-sm"
                  : "text-text-muted hover:bg-bg-hover hover:text-text-main",
              ].join(" ")}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Perbandingan periode TIDAK ditampilkan, dan itu dinyatakan di sini.
          API chart hanya mengembalikan satu seri agregat — tidak ada data
          periode sebelumnya untuk dibandingkan. Menampilkan panah naik/turun
          tanpa pembandingnya, atau sekadar diam-diam menghilangkannya, sama-sama
          membuat operator mengira angka ini punya konteks yang tidak ia punya. */}
      <p className="mt-1.5 text-[0.6875rem] text-text-subtle">
        No period-over-period comparison — the usage API returns a single
        aggregate series, so there is no prior period to diff against.
      </p>

      {/* Nilai utama — angka PENUH, tanpa singkatan.
          "16.0B" tidak bisa dicocokkan dengan catatan mana pun; "16,042,831,295"
          bisa. Di sini angkanya besar dan sendiri, jadi tidak ada alasan
          memendekkannya.

          Satu nilai saat mode menunjuk satu besaran; DUA nilai saat mode
          "Cost + Tokens", dengan yang pertama adalah basis peringkat. Dua-duanya
          angka penuh — pasangan "7.1K / 16B" akan mengembalikan masalah yang
          sama di separuh baris. */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-2">
        {/* Angka besar mengikuti mode, dan labelnya ditulis HANYA saat mode
            gabungan. Di mode tunggal labelnya sudah ada di kalimat kecil di
            sebelah kanan ("spent…" / "tokens…"), jadi menaruhnya dua kali hanya
            menambah keriuhan. */}
        <span className="flex items-baseline gap-2">
          <span
            className="text-[2.75rem] font-semibold leading-none tracking-[-0.03em] tabular-nums text-text-main sm:text-[3.25rem]"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            <span key={String(primaryValue)} className="value-fade">
              {hasData ? primaryValue : "—"}
            </span>
          </span>
          {mode === "both" ? (
            <span className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {isTokenMode ? "tokens" : "cost"}
            </span>
          ) : null}
        </span>

        {mode === "both" ? (
          <span className="flex items-baseline gap-2">
            <span
              className="text-[1.75rem] font-semibold leading-none tracking-[-0.02em] tabular-nums text-text-main sm:text-[2rem]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {hasData ? secondaryValue : "—"}
            </span>
            <span className="text-xs font-medium uppercase tracking-wide text-text-subtle">
              {isTokenMode ? "cost" : "tokens"}
            </span>
          </span>
        ) : null}

        <span className="text-sm text-text-muted">
          {mode === "costs" ? "spent" : mode === "tokens" ? "tokens" : null}
          {mode !== "both" ? <span className="mx-2 text-text-subtle">·</span> : null}
          <span className="tabular-nums">{fmtFull(requests)}</span> requests
          {activeCount > 0 ? (
            <>
              <span className="mx-2 text-text-subtle">·</span>
              <span className="inline-flex items-center gap-1 text-primary">
                <span className="size-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
                <span className="tabular-nums">{activeCount}</span> live
              </span>
            </>
          ) : null}
        </span>
      </div>

      {/* Komposisi token — hanya di mode yang memang membicarakannya.
          Di mode Cost, deretan angka token di bawah harga adalah keriuhan yang
          tidak menjawab pertanyaan siapa pun.

          Bentuknya batang bertumpuk yang JUJUR: dua segmen (input, output) yang
          jumlahnya persis total, dengan bagian cached ditandai DI DALAM segmen
          input sebagai garis lebih tua. Menggambar cached sebagai segmen ketiga
          akan terbaca sebagai tambahan dan membuat tiga segmen itu tampak
          berjumlah lebih dari totalnya. */}
      {hasData && mode !== "costs" && headTokens > 0 ? (
        <div className="mt-3 max-w-2xl">
          <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-border-subtle">
            <span
              className="h-full transition-[width] duration-500"
              style={{
                flexGrow: Math.max(headIn - headCached, 0),
                flexBasis: 0,
                backgroundColor: "color-mix(in oklab, var(--color-primary) 30%, var(--color-surface))",
              }}
            />
            <span
              className="h-full transition-[width] duration-500"
              style={{
                flexGrow: headCached,
                flexBasis: 0,
                minWidth: headCached > 0 ? "2px" : 0,
                backgroundColor: "var(--color-primary)",
              }}
            />
            <span
              className="h-full transition-[width] duration-500"
              style={{
                flexGrow: Math.max(headOut, 0),
                flexBasis: 0,
                minWidth: headOut > 0 ? "2px" : 0,
                backgroundColor: "var(--color-border)",
              }}
            />
          </div>

          <div
            className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem] text-text-muted"
            title={tokenDetail}
          >
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: "color-mix(in oklab, var(--color-primary) 30%, var(--color-surface))" }}
                aria-hidden="true"
              />
              <span className="tabular-nums text-text-main">{fmtFull(headIn - headCached)}</span>
              {/* "uncached", bukan "input". Segmen ini adalah bagian input yang
                  TIDAK kena cache — menyebutnya "input" membuatnya terbaca
                  sebagai seluruh input, padahal input totalnya justru
                  gabungannya dengan cached di sebelah kanan. */}
              uncached input
            </span>
            {/* Cached ditulis "of which" — dua kata itu yang membawa seluruh
                maknanya. Tanpa itu, angkanya berdiri sejajar dengan input dan
                output dan terbaca sebagai komponen ketiga. */}
            {headCached > 0 ? (
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ backgroundColor: "var(--color-primary)" }}
                  aria-hidden="true"
                />
                <span className="tabular-nums text-text-main">{fmtFull(headCached)}</span>
                cached
                <span className="text-text-subtle">
                  ({fmtPercent(cachedShare)} of input)
                </span>
              </span>
            ) : null}
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{ backgroundColor: "var(--color-border)" }}
                aria-hidden="true"
              />
              <span className="tabular-nums text-text-main">{fmtFull(headOut)}</span>
              output
              <span className="text-text-subtle">({fmtPercent(outShare)} of total)</span>
            </span>
          </div>
        </div>
      ) : null}

      {/* Ada trafik tapi tidak ada dasar proporsi: seluruh pemakaian lewat
          provider gratis, jadi biaya $0 dan token tidak terhitung. Strip
          proporsi diganti keterangan yang menyebut SEBABNYA — batang kosong di
          sini akan terbaca sebagai "tidak ada aktivitas", padahal justru
          sebaliknya. */}
      {noBasis ? (
        <p className="mt-4 text-xs text-text-muted">
          <span className="tabular-nums">{fmtFull(requests)}</span> requests served by{" "}
          {providerCounter} provider
          {providerCounter === 1 ? "" : "s"} at no recorded cost —
          switch to <span className="font-medium text-text-main">Tokens</span> to compare their share.
        </p>
      ) : null}

      {/* Batang proporsi antar-provider. Dua fungsi: menjawab "ke mana perginya"
          dalam sekali pandang, dan menjadi filter — klik segmen untuk menyaring
          seluruh halaman ke provider itu. */}
      {!noBasis && hasData && segments.length > 0 ? (
        <>
          <div
            className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-border-subtle"
            role="group"
            aria-label="Proporsi pemakaian per provider"
          >
            {segments.map((s) => {
              const isSelected = selectedProvider === s.id;
              const dimmed = selectedProvider && !isSelected && s.id !== "__rest";
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => s.id !== "__rest" && onSelectProvider?.(isSelected ? null : s.id)}
                  disabled={s.id === "__rest"}
                  // Angka PENUH di tooltip dan aria-label. Persentase saja tidak
                  // cukup: segmen setipis ini tidak mungkin memuat angka
                  // panjang, dan singkatan yang hanya hidup di tooltip masih
                  // menyembunyikan nilai sebenarnya.
                  title={`${s.label} — ${fmtPercent(s.pct)} · ${s.full}`}
                  aria-label={`${s.label}, ${fmtPercent(s.pct)} of total, ${s.full}`}
                  className={[
                    "h-full min-w-0 border-0 p-0 transition-opacity duration-200",
                    s.id === "__rest" ? "cursor-default" : "cursor-pointer hover:opacity-80",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white/70",
                    dimmed ? "opacity-25" : "opacity-100",
                  ].join(" ")}
                  style={{
                    // Proporsi dipetakan lewat flex-grow, bukan `width: %`.
                    // Dengan `width`, memberi `min-width` pada segmen kecil
                    // membuat totalnya melebihi 100% dan segmen terakhir
                    // terpotong — porsi yang justru paling besar bisa hilang.
                    // flex-grow membagi ruang sisa setelah min-width dipenuhi,
                    // jadi strip selalu pas dan segmen kecil tetap bisa diklik.
                    flexGrow: s.pct,
                    flexBasis: 0,
                    minWidth: s.id === "__rest" ? "0" : "4px",
                    backgroundColor: segColors[s.rank] || segColors[3],
                  }}
                />
              );
            })}
          </div>

          {/* Legenda: nama provider yang bisa diklik. Ini yang membuat batangnya
              bukan sekadar hiasan — tiap segmen punya asal yang bisa ditelusuri. */}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {segments.map((s) => {
              const isSelected = selectedProvider === s.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={s.id === "__rest"}
                  onClick={() => onSelectProvider?.(isSelected ? null : s.id)}
                  className={[
                    "flex items-center gap-1.5 text-xs transition-colors duration-150",
                    s.id === "__rest" ? "cursor-default" : "cursor-pointer",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45 rounded",
                    isSelected ? "text-text-main font-medium" : "text-text-muted hover:text-text-main",
                  ].join(" ")}
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: segColors[s.rank] || segColors[3] }}
                    aria-hidden="true"
                  />
                  <span className="max-w-[9rem] truncate">{s.label}</span>
                  <span className="tabular-nums text-text-subtle">
                    {/* Provider gratis ($0) menunjukkan "0%" di mode Costs
                        padahal bisa melayani ratusan request. Menampilkan
                        jumlah request-nya lebih jujur daripada angka nol yang
                        terbaca sebagai "tidak dipakai". */}
                    {s.pct === 0 && s.requests > 0 ? `${fmtCount(s.requests)} req` : fmtPercent(s.pct)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Provider di balik "N others". Daftar ini bisa dibuka: tanpa itu,
              "others" adalah jalan buntu — operator melihat jumlahnya tapi
              tidak bisa menyaring ke salah satunya, padahal provider gratis
              bisa melayani ratusan request dengan biaya $0 dan justru itu yang
              perlu dilihat. */}
          {restMembers.length > 0 ? (
            <div className="mt-1.5">
              <button
                type="button"
                onClick={() => setRestOpen((v) => !v)}
                aria-expanded={restOpen}
                className="flex items-center gap-1 rounded text-xs text-text-subtle transition-colors hover:text-text-main focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45"
              >
                <span
                  className="material-symbols-outlined text-[14px] transition-transform duration-200"
                  style={{ transform: restOpen ? "rotate(90deg)" : "none" }}
                  aria-hidden="true"
                >
                  chevron_right
                </span>
                {restOpen ? "Hide" : "Show"} {restMembers.length} smaller provider
                {restMembers.length === 1 ? "" : "s"}
              </button>

              {restOpen ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 pl-4">
                  {restMembers.map((m) => {
                    const isSelected = selectedProvider === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => onSelectProvider?.(isSelected ? null : m.id)}
                        className={[
                          "flex cursor-pointer items-center gap-1.5 rounded text-xs transition-colors duration-150",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/45",
                          isSelected
                            ? "font-medium text-text-main"
                            : "text-text-muted hover:text-text-main",
                        ].join(" ")}
                      >
                        <span
                          className="size-1.5 shrink-0 rounded-full"
                          style={{ backgroundColor: "var(--color-border)" }}
                          aria-hidden="true"
                        />
                        <span className="max-w-[9rem] truncate">{m.label}</span>
                        <span className="tabular-nums text-text-subtle">
                          {m.pct === 0 && m.requests > 0
                            ? `${fmtCount(m.requests)} req`
                            : fmtPercent(m.pct)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {/* Provider yang baru saja gagal. Ditempatkan di kepala karena ini satu-
          satunya hal di halaman yang butuh tindakan segera. */}
      {errorProvider ? (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-danger/25 bg-danger/8 px-3 py-2">
          <span className="material-symbols-outlined text-[16px] text-danger" aria-hidden="true">
            error
          </span>
          <span className="text-xs text-text-main">
            <span className="font-medium">{errorProvider}</span> failed a request just now
          </span>
        </div>
      ) : null}

      {/* Garis aliran: jalur request masuk → provider. Satu baris tipis, donasi
          dari struktur "Peta aliran". Sengaja tidak menampilkan angka — ia ada
          untuk menyatakan bahwa lapis-lapis di bawahnya adalah SATU aliran yang
          sama, bukan bagian terpisah. */}
      <FlowLine stats={stats} />
    </header>
  );
}

/**
 * Garis aliran — 10 ember per menit terakhir, dari `last10Minutes`.
 *
 * Setiap batang tingginya proporsional terhadap puncak di jendela itu. Kalau
 * seluruh jendela kosong, yang tampil adalah garis datar beserta alasannya —
 * bukan batang kosong yang bisa disalahartikan sebagai data nol.
 */
function FlowLine({ stats }) {
  const buckets = stats?.last10Minutes || [];
  const peak = Math.max(1, ...buckets.map((b) => b?.requests || 0));
  const total = buckets.reduce((s, b) => s + (b?.requests || 0), 0);

  return (
    <div className="mt-4 flex items-center gap-3">
      <span className="shrink-0 text-[0.6875rem] font-medium uppercase tracking-wide text-text-subtle">
        Live flow
      </span>

      <div className="flex h-5 min-w-0 flex-1 items-end gap-[3px]" aria-hidden="true">
        {buckets.length > 0 ? (
          buckets.map((b, i) => {
            const reqs = b?.requests || 0;
            const h = reqs > 0 ? Math.max(12, (reqs / peak) * 100) : 6;
            return (
              <span
                key={i}
                className="min-w-0 flex-1 rounded-[2px] transition-[height] duration-500"
                style={{
                  height: `${h}%`,
                  backgroundColor: reqs > 0 ? "var(--color-primary)" : "var(--color-border)",
                  opacity: reqs > 0 ? 0.35 + (reqs / peak) * 0.65 : 1,
                  transitionTimingFunction: "cubic-bezier(.2,.8,.2,1)",
                }}
              />
            );
          })
        ) : (
          <span className="h-full w-full rounded-[2px] bg-border-subtle" />
        )}
      </div>

      <span className="shrink-0 text-[0.6875rem] tabular-nums text-text-subtle">
        {total > 0 ? `${fmtCount(total)} req / 10m` : "idle"}
      </span>
    </div>
  );
}
