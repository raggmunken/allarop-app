/**
 * Frivio (frivio.se) - auktioner på FRITIDSFORDON (husvagn/husbil/båt m.m.). Angular-SPA
 * men RENT öppet REST-API på backend.frivio.se, ingen browser (som Retrade/Riksauktioner).
 * Lista: GET /vehicles?auction=true&items=N (snake_case). Detalj: GET /vehicle/{id}
 * (camelCase, bär description + foretag(=säljare företag/privat → objektsmoms) + biddings).
 * Bild: /vehicle/{id}/{photo}. Slagavgift = hammer_fee % (5). Budgivare anonyma (userId).
 */

const BASE = "https://backend.frivio.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Bild-URL: backend.frivio.se/vehicle/{vehicleId}/{photoFilename}. */
export function imageUrl(vehicleId: number | string, photo: string): string {
  return `${BASE}/vehicle/${vehicleId}/${photo}`;
}

/** auction_end (unix MS) → ISO-UTC. */
export function msToIso(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(Number(ms))) return null;
  return new Date(Number(ms)).toISOString();
}

export interface FrivioVehicle {
  id: number;
  title: string;
  brand: string | null;
  category: string | null;
  region: string | null;
  city: string | null;
  condition: string | null;
  startingPrice: number | null;
  currentPrice: number | null;
  bidCount: number | null;
  auctionEnd: string | null; // ISO
  ended: boolean; // auction_end_state satt → avslutad
  hammerFeePct: number | null; // hammer_fee (procent, t.ex. 5)
  images: string[];
  active: boolean;
}

export interface FrivioDetail {
  description: string | null;
  /** Säljare företag? (foretag satt = företag → moms; null = privatperson → momsfri). */
  isCompany: boolean;
  bidCount: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return (o.description ?? o.name ?? null) as string | null;
  }
  return String(v).trim() || null;
}

/** Ren parser: /vehicles-listsvaret (snake_case) → fordon. */
export function parseVehicles(json: string): FrivioVehicle[] {
  let arr: unknown[];
  try {
    const j = JSON.parse(json);
    arr = Array.isArray(j) ? j : ((j.data ?? j.vehicles ?? []) as unknown[]);
  } catch {
    return [];
  }
  return arr.map((v) => {
    const o = v as Record<string, unknown>;
    const id = Number(o.id);
    const photos = Array.isArray(o.photos) ? (o.photos as string[]) : [];
    return {
      id,
      title: String(o.title ?? `Frivio ${id}`),
      brand: str(o.brand),
      category: str(o.vehicle_category),
      region: str(o.region),
      city: str(o.city),
      condition: str(o.condition),
      startingPrice: num(o.starting_price),
      currentPrice: num(o.current_price),
      bidCount: num(o.bid_count),
      auctionEnd: msToIso(num(o.auction_end)),
      ended: o.auction_end_state != null && o.auction_end_state !== "",
      hammerFeePct: num(o.hammer_fee),
      images: photos.map((p) => imageUrl(id, p)),
      active: o.active === true,
    };
  });
}

/** Ren parser: /vehicle/{id}-detaljsvaret (camelCase) → beskrivning + säljartyp. */
export function parseDetail(json: string): FrivioDetail {
  try {
    const j = JSON.parse(json);
    const o = (Array.isArray(j) ? j[0] : j.data ?? j) as Record<string, unknown>;
    const desc = o.description != null ? String(o.description).trim() || null : null;
    return {
      description: desc,
      isCompany: o.foretag != null,
      bidCount: Array.isArray(o.biddings) ? o.biddings.length : null,
    };
  } catch {
    return { description: null, isCompany: false, bidCount: null };
  }
}

async function get(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "User-Agent": UA, Accept: "application/json", Origin: "https://frivio.se", Referer: "https://frivio.se/" },
  });
  if (!res.ok) throw new Error(`Frivio ${path} HTTP ${res.status}`);
  return res.text();
}

export class FrivioClient {
  /**
   * Auktioner: aktiva (ended=false, ~tiotal) eller AVSLUTADE (ended=true, ~hundratals
   * för historik-backfill). Ett anrop vardera (items=500 räcker).
   */
  async listAuctions(ended = false): Promise<FrivioVehicle[]> {
    const active = ended ? "&active=false" : "";
    return parseVehicles(
      await get(`/vehicles?auction=true${active}&order-by=auction_end&direction=${ended ? "desc" : "asc"}&items=500`),
    );
  }

  /** Detalj för ETT fordon (beskrivning + säljartyp + antal bud). */
  async fetchDetail(id: number): Promise<FrivioDetail | null> {
    try {
      return parseDetail(await get(`/vehicle/${id}`));
    } catch {
      return null;
    }
  }
}
