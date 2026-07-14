/**
 * BNA-klient (bna.nu — konkurs-/dödsboauktioner). Server-renderad sajt (PHP).
 * Tre lager:
 *   1. GET /auktioner                       → aktiva auktionsevent (id, slug, titel)
 *   2. GET /auktion/{slug}/{id}             → objekt-kort (detalj-URL per objekt)
 *   3. GET /auktion/objekt/{slug}/{id}      → objektets fulla data: titel, högsta
 *      bud, exakt sluttid, objektsmoms (25 %/0 %), ort, bilder.
 *
 * Objektsmomsen VARIERAR per objekt (konkursvara 25 % vs fordon/momsfritt 0 %)
 * och finns bara på objektsidan → vi hämtar objektsidan per objekt (BNA är litet).
 * Budgivare visas inte med identitet → vi lagrar inga bud-rader. Alla parsers är
 * rena och enhetstestas mot sparade fixturer.
 */

const ORIGIN = "https://bna.nu";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface BnaEvent {
  id: string;
  href: string; // relativ /auktion/{slug}/{id}
  title: string;
}

export interface BnaDetail {
  itemId: string;
  title: string;
  currentBid: number | null;
  minBid: number | null;
  /** Exakt sluttid (ISO/UTC). */
  endsAt: string | null;
  /** Objektsmoms i procent (25 momspliktigt, 0 momsfritt). */
  vatRate: number;
  location: string | null;
  images: string[];
  href: string;
}

function parseKr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const digits = s.replace(/&nbsp;| | /g, " ").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/**
 * "2026-06-30 15:00:00" är svensk lokaltid → UTC-ISO. DST-approx: apr–okt = CEST
 * (UTC+2), annars CET (UTC+1). Tillräckligt för sluttider (finalisering har marginal).
 */
export function stockholmToIso(s: string): string | null {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => Number(x ?? 0));
  const offset = mo! >= 4 && mo! <= 10 ? 2 : 1; // grov DST
  const ms = Date.UTC(y!, mo! - 1, d!, h!, mi!, se!) - offset * 3600_000;
  return new Date(ms).toISOString();
}

// Slugs kan innehålla "/" och å/ä/ö (t.ex. "verktyg-/-maskiner-sunne",
// "batterimotorsåg-kärcher-cs400/36"). Matcha därför valfria icke-citattecken
// (greedy → backtrackar till det sista /<numeriskt-id>"). Event = datum-prefixad
// slug (skiljer från objekt-URL:er som börjar med "objekt/").
const EVENT_LINK = /href="(\/auktion\/(\d{4}-\d{2}-\d{2}[^"]*)\/(\d+))"/g;
const OBJECT_LINK = /href="(\/auktion\/objekt\/([^"]+)\/(\d+))"/g;

/** Ren parser: /auktioner → aktiva auktionsevent (dedup på id). */
export function parseAuctions(html: string): BnaEvent[] {
  const out: BnaEvent[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  EVENT_LINK.lastIndex = 0;
  while ((m = EVENT_LINK.exec(html)) != null) {
    const id = m[3] ?? "";
    if (seen.has(id)) continue;
    seen.add(id);
    // Titel = slug snyggt, eller text i kortet (slugen räcker som fallback).
    const slug = m[2] ?? "";
    const title = decodeEntities(slug.replace(/-/g, " ")).replace(/\s+/g, " ").trim();
    out.push({ id, href: m[1] ?? "", title });
  }
  return out;
}

/** Ren parser: en eventsida → objektens detalj-URL:er (dedup på objekt-id). */
export function parseEventObjects(html: string): { href: string; itemId: string }[] {
  const out: { href: string; itemId: string }[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  OBJECT_LINK.lastIndex = 0;
  while ((m = OBJECT_LINK.exec(html)) != null) {
    const itemId = m[3] ?? "";
    if (seen.has(itemId)) continue;
    seen.add(itemId);
    out.push({ href: m[1] ?? "", itemId });
  }
  return out;
}

/** Ren parser: en objektsida → fullständig objektdata. */
export function parseDetail(html: string, href: string): BnaDetail {
  const plain = stripTags(decodeEntities(html));
  const idM = /\/(\d+)(?:[?#]|$)/.exec(href);
  const itemId = idM?.[1] ?? "";

  const h1M = /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html);
  const rawTitle = h1M ? stripTags(decodeEntities(h1M[1] ?? "")).trim() : "";
  // "28769. BYGGSTAKET DEMEX" → "BYGGSTAKET DEMEX"
  const title = rawTitle.replace(/^\s*\d+\.\s*/, "").trim();

  const bidM = /H(?:ö|ö|&ouml;|.)gsta bud\D{0,8}([\d\s ]+?)\s*kr/i.exec(plain);
  const currentBid = parseKr(bidM?.[1]);
  const utropM = /Utrop(?:spris)?\D{0,8}([\d\s ]+?)\s*kr/i.exec(plain);
  const minBid = parseKr(utropM?.[1]);

  const endM = /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?)/.exec(html);
  const endsAt = endM ? stockholmToIso(endM[1] ?? "") : null;

  const vatRate = /Moms tillkommer med 25/i.test(plain) ? 25 : 0;

  const location = parseLocation(plain);
  const images = parseImages(html);

  return { itemId, title, currentBid, minBid, endsAt, vatRate, location, images, href };
}

function parseLocation(plain: string): string | null {
  const m = /(?:Ort|Plats|Avh(?:ä|.)mtning)\s*:?\s*([A-ZÅÄÖ][a-zåäöA-ZÅÄÖ -]{2,30})/.exec(plain);
  return m ? (m[1] ?? "").trim() : null;
}

function parseImages(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Sidan refererar bara thumbnails (/tn/{id}.jpg, lozad-lazy). Fullstora bilden
  // ligger på samma sökväg UTAN /tn/ → /images/custom/AuctionItem/{id}.jpg
  // (verifierat: tn ~8 kB, full ~123 kB). Dedup på bild-id.
  const re = /\/images\/custom\/AuctionItem\/(?:[a-z]+\/)?(\d+)\.jpg/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) != null) {
    const id = m[1] ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(`${ORIGIN}/images/custom/AuctionItem/${id}.jpg`);
    if (out.length >= 12) break;
  }
  return out;
}

export class BnaClient {
  private async get(path: string): Promise<string> {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "sv-SE,sv;q=0.9", Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`BNA HTTP ${res.status} (${path})`);
    return res.text();
  }

  async fetchAuctions(): Promise<BnaEvent[]> {
    return parseAuctions(await this.get("/auktioner"));
  }

  async fetchEventObjects(href: string): Promise<{ href: string; itemId: string }[]> {
    return parseEventObjects(await this.get(href));
  }

  async fetchDetail(href: string): Promise<BnaDetail | null> {
    try {
      return parseDetail(await this.get(href), href);
    } catch {
      return null;
    }
  }
}
