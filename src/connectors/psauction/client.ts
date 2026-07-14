/**
 * PS Auction-klient. PS Auction (psauction.se) är en stor svensk nät-/konkurs-
 * auktionssajt (maskiner, fordon, lösöre). Angular Universal: sidorna SSR-renderas
 * vid NAVIGERING (men en ren XHR-GET ger bara app-skalet) → listan hämtas via
 * `browserFetch` (riktig sidladdning), per-objekt live-data via in-page XHR mot
 * det öppna JSON-API:t. KRÄVER CloakBrowser (curl/headless redirectas 302→/).
 *
 *   - Lista (alla aktiva): GET /search/sida=N  (SSR, 20 kort/sida, ~197 sidor)
 *   - Live per objekt:      GET /item/json/{liveId}  (bud, sluttid, budhistorik)
 *   - Detalj (statisk):     GET /item/view/{itemId}/{slug}  (beskrivning, galleri)
 *
 * Kortet bär TVÅ id:n: itemId (detaljsidans /item/view/{itemId}) och liveId
 * (`psappbundleitemlistupdater`, för /item/json/{liveId}).
 */

import { browserApi, browserFetch } from "../../browser/cloak.ts";

const ORIGIN = "https://psauction.se";

export interface PSItem {
  itemId: string; // /item/view/{itemId} - stabilt lott-id (externalId)
  liveId: string; // /item/json/{liveId} - psappbundleitemlistupdater
  href: string; // /item/view/{itemId}/{slug}
  title: string;
  endText: string | null; // "2026-06-28 14:00" (svensk lokaltid)
  location: string | null;
  currentBid: number | null; // ur kortet ("100 SEK" / null vid "Inga bud")
  image: string | null;
  ended: boolean; // kortet markerat avslutat/sålt
  reservationReached: boolean;
}

export interface PSBid {
  value: number;
  date: string; // "2026-06-27 15:54" (svensk lokaltid)
  bidderName: string | null;
  bidderId: string | null;
  vat: number; // momssats på budet (25/0)
}

export interface PSLive {
  liveId: string;
  currentBid: number | null;
  nextMinBid: number | null;
  endText: string | null; // endingDate "2026-06-28 14:00"
  active: boolean;
  sold: boolean;
  cancelled: boolean;
  reservationReached: boolean;
  vatRate: number; // objektsmoms ur bud/label (25/0)
  currency: string;
  bids: PSBid[];
}

export interface PSDetail {
  description: string | null;
  images: string[];
}

function parseKr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const digits = s.replace(/&nbsp;|\s/g, "").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&aring;/gi, "å").replace(/&auml;/gi, "ä").replace(/&ouml;/gi, "ö")
    .replace(/&Aring;/g, "Å").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * Normalisera till en jämn full storlek: alla varianter (`_fixed_480x340`,
 * `_fixed_120`, `_thumb`, ...) av `..._item_image_{variant}.ext` → `_normal`,
 * strippa cache-param. Gör att samma bild dedupar oavsett vilken storlek vi såg.
 */
function normalizeImage(url: string): string {
  return url
    .replace(/\?t=\d+/, "")
    .replace(/(_item_image)_[a-z0-9_x]+(\.(?:jpg|jpeg|png|webp))/i, "$1_normal$2");
}

export function fullImage(url: string | null): string | null {
  return url ? normalizeImage(url) : null;
}

const CARD = /<div class="auctions-list--item">([\s\S]*?)(?=<div class="auctions-list--item">|<div class="load-more"|<\/main|<footer)/gi;

/** Ren parser: /search-sidans SSR → auktionskort (dedup på itemId). */
export function parseList(html: string): PSItem[] {
  const out: PSItem[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CARD.lastIndex = 0;
  while ((m = CARD.exec(html)) != null) {
    const block = m[1] ?? "";
    const live = /psappbundleitemlistupdater="(\d+)"/.exec(block);
    const view = /\/item\/view\/(\d+)\/([a-z0-9-]+)/i.exec(block);
    if (!live || !view) continue;
    const itemId = view[1] ?? "";
    if (seen.has(itemId)) continue;
    seen.add(itemId);

    const title = decode(stripTags(/<h3>\s*<a[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? ""))
      .replace(/\s+/g, " ").trim();
    const endText = /psauctionendtime="">\s*([\d-]+\s[\d:]+)/i.exec(block)?.[1]?.trim() ?? null;
    const loc = decode(stripTags(/fa-map-marker-alt">([\s\S]*?)<\/li>/i.exec(block)?.[1] ?? ""))
      .replace(/\s+/g, " ").trim() || null;
    const priceText = /psappbidbidtarget="\d+"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? "";
    const currentBid = /inga bud/i.test(priceText) ? null : parseKr(priceText);
    const imgM = /<img[^>]*src="(https:\/\/[^"]*item_image[^"]*)"/i.exec(block);

    out.push({
      itemId,
      liveId: live[1] ?? "",
      href: view[0],
      title,
      endText,
      location: loc,
      currentBid,
      image: fullImage(imgM?.[1] ?? null),
      ended: /offer-ended/i.test(block),
      reservationReached: /reserveprice-reached/i.test(block),
    });
  }
  return out;
}

/** Senaste sidan i pagineringen (max `sida=N`) → totalt antal sidor. */
export function parseTotalPages(html: string): number {
  const nums = [...html.matchAll(/sida=(\d+)/g)].map((x) => Number(x[1]));
  return nums.length ? Math.max(...nums, 1) : 1;
}

/** Ren parser: /item/json-svaret → live-data + budhistorik. */
export function parseLive(json: string): PSLive | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  if (o.id == null) return null;
  const bids: PSBid[] = Array.isArray(o.bids)
    ? (o.bids as Record<string, unknown>[]).map((b) => ({
        value: Number(b.bid) || 0,
        date: String(b.date ?? ""),
        bidderName: b.bidder != null ? String(b.bidder) : null,
        bidderId: b.bidderId != null ? String(b.bidderId) : null,
        vat: Number(b.vat ?? 0),
      }))
    : [];
  // Objektsmoms: ur senaste budets `vat`, annars ur bidVatLabel ("exkl 25% moms"
  // = 25, "inkl ej avlyftbar moms" = marginalbeskattat 0).
  const label = String(o.bidVatLabel ?? "");
  const vatRate = bids[0]?.vat ?? (/\d+\s*%/.test(label) && !/inkl ej avlyftbar/i.test(label) ? 25 : 0);
  const highest = o.highest != null ? Number(o.highest) : null;
  return {
    liveId: String(o.id),
    currentBid: highest != null && highest > 0 ? highest : null,
    nextMinBid: o.nextBid != null ? parseKr(String(o.nextBid)) : null,
    endText: o.endingDate ? String(o.endingDate) : null,
    active: Number(o.active) === 1,
    sold: o.sold === true,
    cancelled: Number(o.cancelled) === 1,
    reservationReached: o.reservationPriceReached === true,
    vatRate,
    currency: String(o.currency ?? "SEK"),
    bids,
  };
}

/** Ren parser: objektsidan → beskrivning (specar + brödtext) + galleri. */
export function parseDetail(html: string, itemId: string | number): PSDetail {
  // Specifikationstabell: <th>Label</th><td>Värde</td>.
  const specRows = [...html.matchAll(/<th>([\s\S]*?)<\/th>\s*<td>([\s\S]*?)<\/td>/gi)]
    .map(([, k, v]) => `${decode(stripTags(k!)).trim()}: ${decode(stripTags(v!)).trim()}`)
    .filter((r) => r.length > 2 && !/^:/.test(r));
  // Objektets egen brödtext = första <div class="text"> (säljarens text), INTE
  // den juridiska standardtexten ("Buden är bindande" / "Objektet är EJ TESTAT").
  let body = "";
  for (const m of html.matchAll(/<div class="text">([\s\S]*?)<\/div>/gi)) {
    const t = decode(stripTags(m[1] ?? "")).replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (/Buden är bindande|EJ TESTAT|Objektsbeskrivningen är framtagen|SERVICEAVGIFT/i.test(t)) break;
    body = t;
    break;
  }
  const description = [specRows.join("\n"), body].filter(Boolean).join("\n\n").trim() || null;

  // Galleri: cloudfront item_image, full storlek (_normal), jpg/png (ej webp-dubbletter).
  // OBS: Angular hydratiserar in "liknande objekt"-KORT längre ner på sidan (upptäckt
  // 2026-07-05: gallerier fick spridda främmande bild-id) → grep:a BARA fram till första
  // list-/rekommendationskortet. Egna galleriet (swipebox/flexslider) ligger före.
  const cut = html.search(/auctions-list--item|related-items|class="recommend/i);
  const scope = cut > 0 ? html.slice(0, cut) : html;
  const images: string[] = [];
  const seen = new Set<string>();
  for (const m of scope.matchAll(/https:\/\/[a-z0-9.-]*cloudfront[^"\s]*item_image[^"\s]*\.(?:jpg|jpeg|png)/gi)) {
    const url = normalizeImage(m[0]);
    if (!seen.has(url)) {
      seen.add(url);
      images.push(url);
    }
    if (images.length >= 60) break;
  }
  return { description, images };
}

export class PSAuctionClient {
  /** Hämta en SSR-sida via stealth-browsern (navigering → cards finns i HTML). */
  private async get(path: string, tries = 3): Promise<string> {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const html = await browserFetch(url, { waitUntil: "domcontentloaded", dwellMs: 300 });
        if (/Just a moment|Access denied/i.test(html.slice(0, 1500))) {
          throw new Error("PS Auction bot-utmaning");
        }
        return html;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async fetchListPage(
    page: number,
  ): Promise<{ items: PSItem[]; totalPages: number }> {
    const html = await this.get(page <= 1 ? "/search" : `/search/sida=${page}`);
    return { items: parseList(html), totalPages: parseTotalPages(html) };
  }

  /** Live-data (bud + exakt sluttid + budhistorik) för en lista liveId via in-page XHR. */
  async fetchLive(liveIds: string[]): Promise<Map<string, PSLive>> {
    if (liveIds.length === 0) return new Map();
    const reqs = liveIds.map((id) => ({ path: `/item/json/${id}` }));
    const texts = await browserApi(ORIGIN, reqs, { sessionPath: "/search", concurrency: 6 });
    const out = new Map<string, PSLive>();
    for (const t of texts) {
      const live = t != null ? parseLive(t) : null;
      if (live) out.set(live.liveId, live);
    }
    return out;
  }

  async fetchDetail(href: string, itemId: string | number): Promise<PSDetail | null> {
    try {
      return parseDetail(await this.get(href), itemId);
    } catch {
      return null;
    }
  }
}
