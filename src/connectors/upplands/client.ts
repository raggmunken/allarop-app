/**
 * Upplands Auktionsverk (upplandsauktionsverk.se) - traditionellt konst-/antikhus på
 * plattformen "bbys.io/skeleton" (Next.js). Periodiskt event-hus. RENT SSR, ingen browser:
 * `GET /api/auctions` → auktionslista; objekten ligger i auktionssidans `__NEXT_DATA__`
 * (`props.pageProps.inventoryItems`) - hämtas med plain HTTP. AVGIFTER: /api/auctions bär
 * köparvillkoren PER AUKTION (upptäckt 2026-07-03): `buyersPremium` (% EXKL moms) +
 * `hammerFees.buyer` ({amount exkl, tax, total inkl}) - verifierat mot auktionssidans
 * villkorstext ("provision på 25% inkl moms samt slagavgift på 30kr inkl moms" = API:ts
 * 20% + 24 kr exkl). Budgivare anonyma → inga bud-rader.
 */

const BASE = "https://www.upplandsauktionsverk.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface UpplandsAuction {
  id: number;
  name: string;
  startDate: string | null;
  endDate: string | null;
  ended: boolean; // avslutad (winnersGenerated + sluttid passerad)
  /** Köparprovision i procent EXKL moms (API:ts buyersPremium; +25 % moms tillkommer). */
  buyersPremiumPct: number | null;
  /** Slagavgift i kronor INKL moms (hammerFees.buyer.total). */
  hammerFeeTotalKr: number | null;
}

export interface UpplandsLot {
  id: number;
  auctionId: number;
  lotNumber: string | null;
  name: string;
  description: string | null;
  minBid: number | null; // startbud
  highBid: number | null; // aktuellt/slutbud
  endDate: string | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  hasReserve: boolean;
  reserveMet: boolean;
  images: string[];
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function htmlToText(s: unknown): string | null {
  if (s == null) return null;
  const t = String(s).replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim();
  return t || null;
}

/** Bästa bild-URL:erna ur defaultImage (storlekarna pekar på samma bild → ta unika). */
function imagesFrom(defaultImage: unknown): string[] {
  const imgs = (defaultImage as { images?: { url?: string }[] } | null)?.images ?? [];
  return [...new Set(imgs.map((i) => i.url).filter((u): u is string => !!u))];
}

/** Ren parser: /api/auctions-svaret → auktioner (test-auktioner bort). */
export function parseAuctions(json: string, now = new Date()): UpplandsAuction[] {
  let arr: unknown[];
  try {
    const j = JSON.parse(json);
    arr = Array.isArray(j) ? j : ((j.auctions ?? []) as unknown[]);
  } catch {
    return [];
  }
  return arr
    .map((a) => {
      const o = a as Record<string, unknown>;
      const id = Number(o.auctionId ?? o.id);
      const name = String(o.name ?? `Upplands ${id}`);
      const endDate = o.endDate != null ? String(o.endDate) : null;
      const ended = o.winnersGenerated === true && endDate != null && new Date(endDate) < now;
      // Köparvillkor per auktion: provision (% exkl moms) + slagavgift (total inkl moms).
      const premium = Number(o.buyersPremium);
      const hammerTotal = Number(
        (o.hammerFees as { buyer?: { total?: unknown } } | null)?.buyer?.total ?? NaN,
      );
      return {
        id, name,
        startDate: o.startDate != null ? String(o.startDate) : null,
        endDate, ended,
        buyersPremiumPct: Number.isFinite(premium) && premium > 0 ? premium : null,
        hammerFeeTotalKr: Number.isFinite(hammerTotal) && hammerTotal >= 0 ? hammerTotal : null,
      };
    })
    .filter((a) => Number.isFinite(a.id) && !/test/i.test(a.name));
}

/** Ren parser: auktionssidans HTML → inventoryItems (__NEXT_DATA__). */
export function parseLots(html: string): UpplandsLot[] {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return [];
  let items: unknown[];
  try {
    items = (JSON.parse(m[1]!).props?.pageProps?.inventoryItems ?? []) as unknown[];
  } catch {
    return [];
  }
  return items.map((l) => {
    const o = l as Record<string, unknown>;
    return {
      id: Number(o.id),
      auctionId: Number(o.auctionId),
      lotNumber: o.lotNumber != null ? String(o.lotNumber) : null,
      name: String(o.name ?? `Objekt ${o.id}`),
      description: htmlToText(o.description),
      minBid: num(o.minBid),
      highBid: num(o.highBid),
      endDate: o.endDate != null ? String(o.endDate) : null,
      estimateLow: num(o.estimateLow),
      estimateHigh: num(o.estimateHigh),
      hasReserve: o.hasReserve === true,
      reserveMet: o.reserveMet === true,
      images: imagesFrom(o.defaultImage),
    };
  });
}

async function get(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`Upplands HTTP ${res.status} ${path}`);
  return res.text();
}

export class UpplandsClient {
  async listAuctions(): Promise<UpplandsAuction[]> {
    return parseAuctions(await get("/api/auctions"));
  }

  /** Objekten i en auktion ur sidans __NEXT_DATA__ (plain HTTP). [] om sidan saknas (404). */
  async fetchLots(auctionId: number): Promise<UpplandsLot[]> {
    try {
      return parseLots(await get(`/sv-SE/auctions/${auctionId}`));
    } catch {
      return []; // gamla/draft-auktioner saknar publik sida → hoppa
    }
  }
}
