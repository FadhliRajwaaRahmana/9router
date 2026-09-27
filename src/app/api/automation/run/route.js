import { NextResponse } from "next/server";
import { requireGate } from "@/lib/automation/gate";
import { getProviderConnections } from "@/lib/localDb";
import {
  startQuotaCheck,
  startConnectionTest,
  startDelete,
} from "@/lib/automation/operations";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, must-revalidate" };

/**
 * Satu pintu untuk operasi massal.
 *
 * Digabung dalam satu route karena ketiganya butuh hal yang sama — origin dan
 * cookie dari permintaan yang masuk — dan karena pekerjaannya berjalan di
 * server yang sama dengan dashboard. Memanggil API 9Router dari dalam server
 * berarti meneruskan cookie sesi operator apa adanya; tidak ada kredensial baru
 * yang dibuat, tidak ada jalur autentikasi kedua yang harus dijaga.
 *
 * Origin diambil dari URL permintaan, bukan dari header `Host` yang bisa
 * dipalsukan klien — pekerjaan ini memanggil dashboard sendiri, jadi asalnya
 * harus yang benar-benar menerima permintaan.
 */
export const POST = requireGate(async (request) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: NO_STORE });
  }

  const { op, provider = null, ids = null, reason = "manual" } = body || {};
  const origin = new URL(request.url).origin;
  const cookie = request.headers.get("cookie") || "";

  const connections = await getProviderConnections(provider ? { provider } : {});

  if (op === "quota") {
    const job = await startQuotaCheck({ origin, cookie, connections, provider });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  if (op === "test") {
    const job = await startConnectionTest({ origin, cookie, connections, provider });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  if (op === "delete") {
    if (!Array.isArray(ids) || ids.length === 0) {
      return NextResponse.json(
        { error: "Isi `ids` dengan koneksi yang mau dihapus" },
        { status: 400, headers: NO_STORE },
      );
    }
    // Batas atas supaya satu permintaan tidak menghapus seluruh database karena
    // bug di klien. 500 lebih dari cukup untuk satu tindakan yang disengaja.
    if (ids.length > 500) {
      return NextResponse.json(
        { error: "Terlalu banyak sekaligus (maks 500)" },
        { status: 400, headers: NO_STORE },
      );
    }
    const job = await startDelete({ connections, ids, reason });
    return NextResponse.json({ jobId: job.id, total: job.total }, { headers: NO_STORE });
  }

  return NextResponse.json({ error: "Operasi tidak dikenal" }, { status: 400, headers: NO_STORE });
});
