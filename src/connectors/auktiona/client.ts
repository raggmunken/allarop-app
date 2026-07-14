/**
 * Auktiona (auktiona.se) - konkurs-/likvidationsauktioner, ny plattform "gobid" (Next.js +
 * Firebase Firestore, realtidsbud). Datan ligger i ett ÖPPET Firestore (ingen App Check på
 * REST): collection `auctionItems` (lotterna) + `auctions` (konkurs-eventen). Aktiva lotter
 * = status "published". Vi läser via Firestore REST: runQuery(auctionItems, status=published)
 * + batchGet av parent-auktionerna (lotter ärver endDate + ort därifrån). Köparavgiften
 * (slagavgift/förmedlarprovision/kortavgift) har ingen publik sats → external-läge.
 * (Äldre auktioner ligger på legacy-sajten www2.auktiona.se - ej här.)
 */

const FS = "https://firestore.googleapis.com/v1/projects/gobid-4db14/databases/(default)/documents";
const KEY = "AIzaSyA6OcpCd-w_GIcAJKPOjVdjz0_L2Z3vO4g"; // publik Firebase web-apiKey
const SITE = "https://auktiona.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface AuktionaItem {
  id: string; // Firestore doc-id
  title: string;
  description: string | null;
  currentBid: number | null; // currentPrice när det finns bud (currentLeader satt); annars null
  minBid: number | null; // startbud (currentPrice) när inga bud lagts
  valuation: number | null; // marknadsvärde
  endsAt: string | null; // ISO UTC (item ELLER ärvt från auktionen)
  location: string | null; // ort (ärvd från auktionen)
  images: string[]; // hela bildgalleriet (Firebase Storage-URL:er m. token)
  /** Serviceavgift i kr (settings.serviceFee): "none"→0, "fixed"→belopp, "percentage"→% av budet. */
  serviceFee: number;
  sourceUrl: string;
}

/** Avkoda ett Firestore REST-värde → JS. */
export function dv(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("stringValue" in o) return o.stringValue;
  if ("integerValue" in o) return Number(o.integerValue);
  if ("doubleValue" in o) return Number(o.doubleValue);
  if ("booleanValue" in o) return o.booleanValue;
  if ("timestampValue" in o) return o.timestampValue;
  if ("nullValue" in o) return null;
  if ("mapValue" in o) {
    const f = (o.mapValue as { fields?: Record<string, unknown> })?.fields ?? {};
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(f)) out[k] = dv(val);
    return out;
  }
  if ("arrayValue" in o) {
    const vals = (o.arrayValue as { values?: unknown[] })?.values ?? [];
    return vals.map(dv);
  }
  return null;
}

function tsIso(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

interface AuctionMeta {
  endDate: string | null;
  city: string | null;
}

/** Bygg lott ur en Firestore-doc + parent-auktionernas metadata (för arv). */
export function mapDoc(doc: { name: string; fields: Record<string, unknown> }, auctions: Map<string, AuctionMeta>): AuktionaItem {
  const f = doc.fields;
  const id = doc.name.split("/").pop() ?? "";
  const auctionId = String(dv(f.auctionId) ?? "");
  const parent = auctions.get(auctionId);
  const dateRange = (dv(f.dateRange) ?? {}) as Record<string, unknown>;
  const ownEnd = tsIso(dateRange.endDate);
  const price = f.currentPrice != null ? Number(dv(f.currentPrice)) : null;
  const hasBids = dv(f.currentLeader) != null && dv(f.currentLeader) !== "";
  const images = ((dv(f.images) ?? []) as unknown[]).filter((x): x is string => typeof x === "string");
  const url = String(dv(f.url) ?? `/${dv(f.slug) ?? id}`);
  const bid = hasBids && price != null && price > 0 ? price : null;
  const pricing = (dv(f.pricing) ?? {}) as Record<string, unknown>;
  const startPrice = Number(pricing.startPrice) || null;
  // Lägsta giltiga bud (inga bud): startbudet/utropspris - aldrig 0.
  const minBid = hasBids ? null : (price != null && price > 0 ? price : startPrice);
  return {
    id,
    title: String(dv(f.title) ?? `Auktiona ${id}`),
    description: (dv(f.description) as string) ?? null,
    currentBid: bid,
    minBid,
    valuation: f.valuation != null ? Number(dv(f.valuation)) : null,
    endsAt: ownEnd ?? parent?.endDate ?? null,
    location: parent?.city ?? null,
    images,
    serviceFee: serviceFeeKr(f, bid ?? price ?? 0),
    sourceUrl: `${SITE}/auktioner${url}`,
  };
}

/** Serviceavgift i kr ur settings.serviceFee ({type:none/fixed/percentage, value}). Oftast "none" → 0. */
function serviceFeeKr(f: Record<string, unknown>, bid: number): number {
  const settings = (dv(f.settings) ?? {}) as Record<string, unknown>;
  const sf = (settings.serviceFee ?? {}) as Record<string, unknown>;
  const v = (sf.value ?? {}) as Record<string, unknown>;
  const type = String(v.type ?? "none");
  const value = Number(v.value ?? 0) || 0;
  if (type === "fixed") return value;
  if (type === "percentage") return Math.round((bid * value) / 100);
  return 0; // "none"
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${FS}${path}?key=${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json", "User-Agent": UA },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Auktiona Firestore HTTP ${res.status} ${path}`);
  return res.json();
}

export class AuktionaClient {
  /** Alla aktiva (published) lotter, berikade med ärvd sluttid + ort. */
  async fetchActive(): Promise<AuktionaItem[]> {
    const rows = (await post(":runQuery", {
      structuredQuery: {
        from: [{ collectionId: "auctionItems" }],
        where: { fieldFilter: { field: { fieldPath: "status" }, op: "EQUAL", value: { stringValue: "published" } } },
        limit: 500,
      },
    })) as { document?: { name: string; fields: Record<string, unknown> } }[];
    const docs = rows.filter((r) => r.document).map((r) => r.document!);

    // Parent-auktioner (för arv av endDate + ort).
    const auctionIds = [...new Set(docs.map((d) => String(dv(d.fields.auctionId) ?? "")).filter(Boolean))];
    const auctions = await this.fetchAuctions(auctionIds);
    return docs.map((d) => mapDoc(d, auctions));
  }

  private async fetchAuctions(ids: string[]): Promise<Map<string, AuctionMeta>> {
    const map = new Map<string, AuctionMeta>();
    if (ids.length === 0) return map;
    const res = (await post(":batchGet", {
      documents: ids.map((id) => `projects/gobid-4db14/databases/(default)/documents/auctions/${id}`),
    })) as { found?: { name: string; fields: Record<string, unknown> } }[];
    for (const r of res) {
      if (!r.found) continue;
      const id = r.found.name.split("/").pop() ?? "";
      const f = r.found.fields;
      const dateRange = (dv(f.dateRange) ?? {}) as Record<string, unknown>;
      const loc = (dv(f.location) ?? {}) as Record<string, unknown>;
      map.set(id, { endDate: tsIso(dateRange.endDate), city: (loc.city as string) ?? null });
    }
    return map;
  }
}
