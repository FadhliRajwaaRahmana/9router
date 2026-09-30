"use client";

import { usePathname } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useRef } from "react";
import { useSmoothScroll } from "./usePageTransition";
import { ScrollProgress, StaggerInheritContext, pageVariants } from "./primitives";

/**
 * Transisi antar-halaman + smooth scroll, dipasang SEKALI di layout.
 *
 * ── Mengapa di layout, bukan di 24 halaman ──────────────────────────────────
 *
 * Menambahkan entrance animation ke tiap halaman berarti menyentuh 24 berkas,
 * dan setiap berkas menambah risikonya sendiri. Yang dibutuhkan operator saat
 * berpindah menu cuma "halaman baru muncul dengan halus, bukan berkedip" — dan
 * itu satu tempat: pembungkus di sekitar `{children}`.
 *
 * Efeknya berlaku untuk SEMUA halaman di bawahnya, termasuk halaman yang
 * ditambahkan nanti tanpa perlu diubah.
 *
 * ── Durasi yang sengaja pendek ──────────────────────────────────────────────
 *
 * 220ms masuk, 140ms keluar. Animasi halaman yang terasa "mewah" (500ms+)
 * menjadi siksaan saat operator berpindah menu puluhan kali sehari — dan
 * dashboard ini memang dipakai begitu. Yang diinginkan di sini bukan kesan
 * mewah, melainkan tidak adanya kedipan.
 *
 * ── Yang TIDAK dianimasikan ────────────────────────────────────────────────
 *
 * Hanya opasitas dan geser 8px. Tidak ada skala, tidak ada blur: keduanya
 * memaksa repaint seluruh area dan pada tabel besar terasa tersendat.
 *
 * ── Stagger: halaman muncul, lalu ISINYA menyusul ──────────────────────────
 *
 * Pembungkus ini juga sumber `staggerChildren` untuk seluruh halaman. `Card`
 * yang berada di bawahnya mewarisi varians ini (lewat `StaggerInheritContext`),
 * sehingga kartu pertama masuk ~20ms setelah halaman, kartu berikutnya 45ms
 * kemudian, dan seterusnya. Sebelumnya tiap kartu menyalakan animasinya sendiri
 * dengan `delay: 0`, jadi seisi halaman muncul serentak — terasa sebagai satu
 * kedipan, bukan sebagai halaman yang tersusun.
 *
 * `prefers-reduced-motion` dihormati lewat `useReducedMotion` — durasinya jadi
 * nol dan stagger dimatikan, bukan animasinya dihapus, sehingga tidak ada yang
 * bergantung pada selesainya sebuah transisi.
 */
export function PageTransition({ children }) {
  const pathname = usePathname();
  const reduce = useReducedMotion();
  const scrollRef = useRef(null);

  useSmoothScroll(scrollRef);

  const dur = reduce ? 0 : 0.22;
  const durOut = reduce ? 0 : 0.14;

  // Identitas objek variants harus STABIL antar-render: objek baru tiap render
  // membuat Motion menganggapnya definisi baru dan bisa memicu ulang animasi.
  const variants = useMemo(() => pageVariants(reduce, dur, durOut), [reduce, dur, durOut]);

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {/* Garis kemajuan gulir — GSAP ScrollTrigger.
          Ditaruh di LUAR wadah yang menggulir, bukan di dalamnya: elemen di
          dalam wadah yang menggulir akan ikut tergulir naik dan menghilang
          justru saat paling dibutuhkan. */}
      <ScrollProgress scrollerRef={scrollRef} />
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto custom-scrollbar"
        data-smooth-scroll=""
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={pathname}
            initial="hidden"
            animate="show"
            exit="exit"
            variants={variants}
            className="min-h-full"
          >
            {/* Seluruh isi halaman mewarisi izin ber-stagger. `Card` membaca
                konteks ini dan, kalau boleh, masuk lewat varians alih-alih
                menyalakan animasinya sendiri — itulah yang membuat kartu-kartu
                menyusul berurutan alih-alih muncul serentak sebagai satu blok. */}
            <StaggerInheritContext.Provider value={!reduce}>
              {children}
            </StaggerInheritContext.Provider>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
