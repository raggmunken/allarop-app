/**
 * Vaxxa (app.vaxxa.se) - konkurs-/självservice-nätauktioner (Norrland-tungt: maskiner,
 * fordon, bygg, lösöre). Next.js-SPA men katalogen drivs av ett ÖPPET Typesense-sökindex
 * (publik search-only-nyckel i klienten). Vi replikerar sökningen: POST /multi_search,
 * collection "auctions", q=*, filter sale_state:=IN_PROGRESS, sort end_time:asc (slutar
 * snart först), paginering via page (per_page ≤ 250). Varje träff bär allt: id/old_id,
 * titel, price (aktuellt bud, exkl moms), bids_count, end_time (unix s), image_url,
 * is_reserve_met (reservstatus), plats, kategori, listing_type. Köparens serviceavgift
 * hämtas per (objekt, belopp) via Server Action `getProductFeeAction` (fee exkl moms,
 * ALLTID +25 % moms på avgiften); budets moms styrs av objektsidans `is_taxable`
 * (1 → +25 % på budet, 0 → momsfri försäljning).
 */

import { VaxxaSession } from "./session.ts";

const TS_URL = "https://pvexwh9j5lno08kmp-1.a1.typesense.net/multi_search";
const TS_KEY = "Nk6JAJLJ0Y0ESa5sOQw31zXG8oy0FHJ9"; // publik search-only-nyckel (kan roteras)
const SITE = "https://app.vaxxa.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export const PER_PAGE = 250; // Typesense-tak

export interface VaxxaItem {
  id: string; // uuid
  externalId: string; // old_id (matchar /auctions/{old_id} + bild-CDN)
  title: string;
  image: string | null; // Typesense-thumbnail (s=list); ersätts av galleriet vid berikning
  images: string[]; // hela galleriet ur objektsidan (s=full); berikas
  description: string | null; // objektsidans meta; berikas
  category: string | null;
  location: string | null;
  currentBid: number | null; // price när bud finns (exkl moms); null om 0 bud
  /** Köp nu-pris (listing_type BUY_NOW bär priset i price även utan bud). */
  buyNowPrice: number | null;
  bidCount: number;
  reserveMet: boolean;
  listingType: string | null; // AUCTION | BUY_NOW
  endsAt: string | null; // ISO UTC
  /** Objektsidans is_taxable: true → +25 % moms på budet, false → momsfri försäljning. */
  isTaxable: boolean | null;
  /** Serviceavgift (exkl moms) för AKTUELLT bud, ur getProductFeeAction; berikas. */
  feeExVat: number | null;
}

/** Objektsidans berikning: bildgalleri (s=full) + beskrivning + momsstatus. */
export interface VaxxaDetail {
  images: string[];
  description: string | null;
  taxable: boolean | null;
}

/** unix-sekunder → ISO-UTC. */
export function unixToIso(sec: number | null | undefined): string | null {
  if (sec == null || !Number.isFinite(Number(sec))) return null;
  return new Date(Number(sec) * 1000).toISOString();
}

interface VaxxaDoc {
  id?: string;
  old_id?: string;
  title?: string;
  image_url?: string;
  category?: string;
  location_city?: string;
  location_county?: string;
  price?: number;
  bids_count?: number;
  is_reserve_met?: boolean;
  listing_type?: string;
  end_time?: number;
}

/** Ren parser: Typesense multi_search-svar → objekt + totalt antal (found). */
export function parseSearch(json: string): { items: VaxxaItem[]; found: number } {
  let res: { found?: number; hits?: { document?: VaxxaDoc }[] };
  try {
    const j = JSON.parse(json);
    res = j.results?.[0] ?? {};
  } catch {
    return { items: [], found: 0 };
  }
  const items: VaxxaItem[] = [];
  for (const h of res.hits ?? []) {
    const d = h.document ?? {};
    const externalId = String(d.old_id ?? d.id ?? "");
    if (!externalId) continue;
    const bids = Number(d.bids_count ?? 0) || 0;
    const price = Number(d.price ?? 0) || 0;
    items.push({
      id: String(d.id ?? externalId),
      externalId,
      title: String(d.title ?? `Vaxxa ${externalId}`),
      image: d.image_url ?? null,
      images: [],
      description: null,
      category: d.category ?? null,
      location: d.location_city ?? d.location_county ?? null,
      currentBid: bids > 0 && price > 0 ? price : null,
      // BUY_NOW: price = köp nu-priset (även med 0 bud) → visas som pris + avgiftsbasis.
      buyNowPrice: d.listing_type === "BUY_NOW" && price > 0 ? price : null,
      bidCount: bids,
      reserveMet: d.is_reserve_met === true,
      listingType: d.listing_type ?? null,
      endsAt: unixToIso(d.end_time),
      isTaxable: null,
      feeExVat: null,
    });
  }
  return { items, found: Number(res.found ?? items.length) || items.length };
}

export const sourceUrl = (externalId: string) => `${SITE}/auctions/${externalId}`;

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ur objektsidans HTML (app.vaxxa.se/auctions/{old_id}): hela bildgalleriet
 * (images.vaxxa.se/{old_id}/s=full/{n}.jpg - bara detta objekts bilder, ej liknande) +
 * beskrivning (meta). SSR:at → hämtas med ren HTTP.
 */
export function parseDetail(externalId: string, html: string): VaxxaDetail {
  const re = new RegExp(`https://images\\.vaxxa\\.se/${externalId}/s=full/[^"'\\s?)\\\\]+\\.(?:jpe?g|png|webp)`, "gi");
  const images = [...new Set(html.match(re) ?? [])].sort();
  const m = /<meta name="description" content="([^"]*)"/i.exec(html);
  const desc = m ? decode(m[1]!) : "";
  // Objektets momsstatus ur den inbäddade payloaden (escapad JSON i Next-flight).
  const tx = /\\?"is_taxable\\?":\s*(0|1|true|false)/.exec(html);
  const taxable = tx == null ? null : tx[1] === "1" || tx[1] === "true";
  return { images, description: desc.length > 2 ? desc : null, taxable };
}

export class VaxxaClient {
  private readonly session = new VaxxaSession();

  /**
   * Serviceavgift (exkl moms) för ett objekt vid ett givet budbelopp, via Server
   * Action `getProductFeeAction` (ren HTTP - bara next-action-headern behövs).
   * Vid trasigt svar (deploy bytte hash) körs discovery om en gång → nytt försök.
   * Null vid fel (avgiften berikas då nästa svep i stället).
   */
  async fetchFee(externalId: string, amount: number, retried = false): Promise<number | null> {
    try {
      const res = await fetch(sourceUrl(externalId), {
        method: "POST",
        headers: {
          "User-Agent": UA,
          Accept: "text/x-component",
          "content-type": "text/plain;charset=UTF-8",
          "next-action": await this.session.getHash(),
          Referer: sourceUrl(externalId),
        },
        body: JSON.stringify([Number(externalId), amount]),
      });
      const text = res.ok ? await res.text() : "";
      const m = /"actionData":\{"fee":([\d.]+)/.exec(text);
      if (m) return Math.round(Number(m[1]));
    } catch {
      /* nätfel → försök ev. igen nedan */
    }
    if (retried) return null;
    // Trasigt svar = sannolikt ny deploy → auto-discovery ur objektsidans chunkar.
    const changed = await this.session.discover(`/auctions/${externalId}`);
    return changed ? this.fetchFee(externalId, amount, true) : null;
  }

  /** En sida aktiva auktioner (slutar-snart-sorterade) + totalt antal. */
  async search(page: number, perPage = PER_PAGE): Promise<{ items: VaxxaItem[]; found: number }> {
    const body = JSON.stringify({
      searches: [
        {
          collection: "auctions",
          q: "*",
          filter_by: "sale_state:=IN_PROGRESS",
          sort_by: "end_time:asc,title:asc",
          per_page: Math.min(perPage, PER_PAGE),
          page: Math.max(page, 1),
        },
      ],
    });
    const res = await fetch(TS_URL, {
      method: "POST",
      headers: { "x-typesense-api-key": TS_KEY, "content-type": "text/plain", "User-Agent": UA, Accept: "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`Vaxxa Typesense HTTP ${res.status}`);
    return parseSearch(await res.text());
  }

  /** Objektsidan EN gång per objekt → bildgalleri (s=full) + beskrivning + momsstatus. */
  async fetchDetail(externalId: string): Promise<VaxxaDetail> {
    try {
      const res = await fetch(sourceUrl(externalId), { headers: { "User-Agent": UA, Accept: "text/html" } });
      if (!res.ok) return { images: [], description: null, taxable: null };
      return parseDetail(externalId, await res.text());
    } catch {
      return { images: [], description: null, taxable: null };
    }
  }
}
