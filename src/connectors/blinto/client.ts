/**
 * Blinto-klient. Blinto (maskiner/fordon/verktyg) renderar HELA den aktiva
 * katalogen server-side på startsidan (Vue SSR, EJ Cloudflare-blockerad trots
 * challenge-script) → ren HTTP räcker, ingen browser:
 *   GET https://www.blinto.se/   → ~950 auktionskort
 *
 * Varje kort: detalj-URL `/auction/{slug}-{objId}-{aucId}/`, typ (`brand-type`),
 * märke/modell, ort (`card-location`), sluttid ("Mån 29 jun 09:59"), antal bud
 * (`bids-amount`), aktuellt bud (`bid-price`), bild (cdn.blinto.se/object/{objId}/).
 *
 * Objektsidan ger slagavgiften (per objekt, "exkl. moms"), objektsmoms
 * (25 %/momsfri) och hela bildgalleriet. Alla parsers rena + enhetstestade.
 */

import { browserApi, browserFetch } from "../../browser/cloak.ts";

const ORIGIN = "https://www.blinto.se";

export interface BlintoItem {
  objId: string;
  aucId: string;
  href: string; // relativ /auction/...
  type: string | null; // "Hjullastare"
  title: string; // "Volvo L90F"
  location: string | null;
  endText: string | null; // "Mån 29 jun 09:59" (SSR, opålitlig — JS-fylld)
  bidCount: number | null;
  currentBid: number | null;
  image: string | null;
  // Live-overlay från 4MaxBid (sätts i fetchPage; SSR-fälten ovan är opålitliga).
  endsAtRaw?: string | null; // "2026-06-30 10:10:00" (svensk lokaltid)
  nextMinBid?: number | null;
}

export interface BlintoDetail {
  feeValue: number | null; // slagavgift i kr
  vatRate: number; // 25 momspliktigt, 0 momsfritt
  images: string[];
  description: string | null; // brödtext (specifikation + säljartext)
}

/** Live-data per auktion (4MaxBid + getAuctionData). aucId = auktions-id. */
export interface BlintoLive {
  aucId: string;
  currentBid: number | null;
  endsAtRaw: string | null; // "2026-06-30 10:10:00" (svensk lokaltid)
  nextMinBid: number | null;
  bidCount: number | null;
}

function parseKr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const digits = s.replace(/&nbsp;| | /g, " ").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ");
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))) // &#229; → å
    .replace(/&amp;/g, "&")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

/** Plocka direkt-texten efter ett element med en viss klass (text-barn). */
function fieldByClass(block: string, cls: string): string | null {
  const m = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)<`).exec(block);
  return m ? decode(stripTags(m[1] ?? "")).replace(/\s+/g, " ").trim() || null : null;
}

/** Plocka all text i ett element med en viss klass (tål nästlade taggar, t.ex. ikon). */
function textInClass(block: string, cls: string): string | null {
  const m = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]{0,160}?)</`).exec(block);
  return m ? decode(stripTags(m[1] ?? "")).replace(/\s+/g, " ").trim() || null : null;
}

const CARD_ANCHOR = /<a[^>]*href="(\/auction\/[A-Za-z0-9-]+-(\d+)-(\d+)\/)"[\s\S]*?<\/a>/g;

/**
 * Bild-URL i jämn storlek (/1200x900f). Korttbilder kommer som
 * `.../X.jpg/600x450f` (resize-suffix), objektsidans galleri-URL:er som
 * `.../X.jpg` (utan suffix) → strippa ev. suffix och lägg på /1200x900f så
 * BÅDA formerna normaliseras till samma URL (annars dubbletter i galleriet).
 */
export function fullImage(url: string | null): string | null {
  if (!url) return null;
  const base = url.replace(/\/\d+x\d+\w*$/, "");
  return `${base}/1200x900f`;
}

/** Ren parser: startsidans HTML → auktionskort (dedup på objekt-id). */
export function parseList(html: string): BlintoItem[] {
  const out: BlintoItem[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CARD_ANCHOR.lastIndex = 0;
  while ((m = CARD_ANCHOR.exec(html)) != null) {
    const block = m[0];
    const href = m[1] ?? "";
    const objId = m[2] ?? "";
    const aucId = m[3] ?? "";
    if (seen.has(objId)) continue;
    seen.add(objId);

    const imgM = /https:\/\/cdn\.blinto\.se\/object\/\d+\/[^"\s]+/.exec(block);
    const cardText = decode(stripTags(block)).replace(/\s+/g, " ");
    // Aktuellt bud + antal bud finns som "X SEK" / "N bud" i korttexten (i nästlade
    // element → ta dem ur den tag-strippade texten i stället för per klass).
    const bidM = /([\d  ]{2,})\s*SEK/.exec(cardText);
    const bidsM = /(\d+)\s*bud/.exec(cardText);
    const bid = bidM ? (parseKr(bidM[1]) || null) : null;
    out.push({
      objId,
      aucId,
      href,
      type: fieldByClass(block, "brand-type"),
      title: fieldByClass(block, "h3-second-line") ?? fieldByClass(block, "brand-type") ?? "",
      location: textInClass(block, "card-location"),
      endText: parseEndText(block, objId),
      bidCount: bidsM ? Number(bidsM[1]) : null,
      currentBid: bid,
      image: fullImage(imgM ? imgM[0] : null),
    });
  }
  return out;
}

const SV_MONTH = "jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec";

/**
 * Sluttiden ur kortets `#time-left_{objId}`-element, t.ex. "Mån 29 jun 09:59".
 * Veckodagen ignoreras (kan vara entity-kodad å/ö) → vi plockar "29 jun 09:59".
 */
function parseEndText(block: string, objId: string): string | null {
  const el = new RegExp(`id="time-left_${objId}"[^>]*>([\\s\\S]*?)<`).exec(block);
  const text = el ? decode(stripTags(el[1] ?? "")).replace(/\s+/g, " ") : "";
  const m = new RegExp(`(\\d{1,2})\\s+(${SV_MONTH})\\s+(\\d{1,2}):(\\d{2})`, "i").exec(text);
  return m ? `${m[1]} ${m[2]} ${m[3]}:${m[4]}` : null;
}

/** Block-HTML → läsbar flerradig text (p/li/br → radbrytning, listpunkt "- "). */
function htmlToText(s: string): string {
  const withBreaks = s
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/(?:p|li|h\d|div|ul)\s*>/gi, "\n")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decode(withBreaks)
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Objektets brödtext ur `#description-content` (specifikation + säljartext).
 * Klipps före Blintos standard-juridik (visuell genomgång / momspliktig / "Har du
 * också något att sälja") som ligger sist i samma container på VARJE objektsida.
 */
export function parseDescription(html: string): string | null {
  const open = /id=['"]description-content['"][^>]*>/i.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  let body = html.slice(start, start + 12000);
  const boilerplate = [
    /Blintos\s+auktionsm\S*klare/i,
    /Objektet\s+s\S*ljs\s+p\S*\s+uppdrag/i,
    /Har\s+du\s+ocks\S*\s+n\S*got\s+att\s+s\S*lja/i,
  ];
  let cut = body.length;
  for (const re of boilerplate) {
    const m = re.exec(body);
    if (m && m.index < cut) cut = m.index;
  }
  const text = htmlToText(body.slice(0, cut)).slice(0, 4000).trim();
  return text || null;
}

/** Ren parser: objektsidan → slagavgift + objektsmoms + galleri + brödtext. */
export function parseDetail(html: string, objId: string | number): BlintoDetail {
  const plain = decode(stripTags(html));
  // Rendererad avgiftstext: "slagavgift på 8 400 SEK (exkl. moms)". Ankra på
  // "(exkl" så vi inte träffar i18n-ordlistans "slagavgift på":"slagavgift på".
  const feeM = /slagavgift\s+p\S*\s+([\d\s ]+?)\s*(?:SEK|kr)\s*\(exkl/i.exec(plain);
  const feeValue = feeM ? parseKr(feeM[1]) : null;
  // "Momsfri försäljning" rendereras bara för momsfria objekt (i18n-nyckeln följs
  // av ":") → 0 %, annars 25 % på budet.
  const momsfri = /Momsfri\s+f\S*ljning(?!\s*":)/.test(plain) && !/25\s*%\s*moms tillkommer p\S* lagt bud(?!\s*":)/.test(plain);
  const vatRate = momsfri ? 0 : 25;

  // Galleriet kan vara stort (ett objekt hade 96 bilder) → ta hela, inte bara 20.
  // Varje bild förekommer flera gånger (slider/thumb/lightbox) → dedup via fullImage.
  const images: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`https://cdn\\.blinto\\.se/object/${objId}/[^"\\s]+?\\.(?:jpg|jpeg|webp)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) != null) {
    const url = fullImage(m[0])!;
    if (!seen.has(url)) {
      seen.add(url);
      images.push(url);
    }
    if (images.length >= 150) break;
  }
  return { feeValue, vatRate, images, description: parseDescription(html) };
}

/**
 * Parsar 4MaxBid-svaret (pipe-separerat):
 *   "aucId|bid|x|YYYY-MM-DD HH:MM:SS|flag|veckodag|y|veckodag||flag|nextmin"
 * Fält 1 = aktuellt bud, 3 = exakt sluttid (svensk lokaltid), 10 = nästa minbud.
 */
export function parseMaxBid(text: string): Omit<BlintoLive, "bidCount"> | null {
  const t = text.trim();
  if (!t || t.includes("<")) return null; // tomt eller fel-HTML
  const f = t.split("|");
  const aucId = (f[0] ?? "").trim();
  if (!/^\d+$/.test(aucId)) return null;
  const intField = (s: string | undefined) =>
    s != null && /^\d+$/.test(s.trim()) ? Number(s.trim()) : null;
  const endsAtRaw = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test((f[3] ?? "").trim())
    ? (f[3] ?? "").trim()
    : null;
  return {
    aucId,
    currentBid: intField(f[1]),
    endsAtRaw,
    nextMinBid: intField(f[10]),
  };
}

/** Bud + antal bud per auktion ur det BATCHADE getAuctionData-anropet. */
export interface BlintoBidData {
  currentBid: number | null;
  bidCount: number | null;
}

/**
 * getAuctionData-svar `{ aucId: { maxbid:"249 000 SEK", numbid:"34 bud" } }`
 * → Map<aucId, {currentBid, bidCount}>. `maxbid` = aktuellt bud (verifierat lika
 * med 4MaxBid), `numbid` = antal bud. Detta är den BATCHADE källan (~100 id/anrop)
 * → ersätter ~950 enskilda 4MaxBid-XHR för budet på bulk-svepet. Siffrorna har
 * tusentalsmellanslag + enhet → strippa allt utom siffror.
 */
export function parseAuctionData(json: string): Map<string, BlintoBidData> {
  const out = new Map<string, BlintoBidData>();
  try {
    const obj = JSON.parse(json) as Record<string, { maxbid?: unknown; numbid?: unknown }>;
    for (const [aucId, v] of Object.entries(obj)) {
      const bid = String(v?.maxbid ?? "").replace(/[^\d]/g, "");
      const cnt = String(v?.numbid ?? "").replace(/[^\d]/g, "");
      out.set(aucId, {
        currentBid: bid ? Number(bid) : null,
        bidCount: cnt ? Number(cnt) : null,
      });
    }
  } catch {
    /* ej JSON → hoppa */
  }
  return out;
}

export class BlintoClient {
  /**
   * Hämta en sida via stealth-browsern (CloakBrowser). Blinto ligger bakom
   * Cloudflare bot-management som fingeravtryckar HTTP-klienter (Node-fetch OCH
   * curl kan få 403) → en riktig stealth-Chromium krävs. Omförsök med backoff.
   */
  private async get(path: string, tries = 3): Promise<string> {
    const url = path.startsWith("http") ? path : `${ORIGIN}${path}`;
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const html = await browserFetch(url, { waitUntil: "domcontentloaded", dwellMs: 600 });
        if (/Just a moment|Access denied|cf-error/i.test(html.slice(0, 1500))) {
          throw new Error("Blinto Cloudflare-utmaning");
        }
        return html;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async fetchList(): Promise<BlintoItem[]> {
    return parseList(await this.get("/"));
  }

  async fetchDetail(href: string, objId: string | number): Promise<BlintoDetail | null> {
    try {
      return parseDetail(await this.get(href), objId);
    } catch {
      return null;
    }
  }

  /**
   * Live-data (bud + EXAKT sluttid + antal bud) för en lista auktions-id via
   * in-page XHR (snabbt, ingen sidrendering). 4MaxBid ger bud+sluttid per objekt;
   * getAuctionData ger antal bud batchat. SSR-listans `#time-left`/bud fylls i av
   * JS efter laddning → opålitliga vid hämtning, därför hämtar vi dem härifrån.
   */
  async fetchLive(aucIds: string[]): Promise<Map<string, BlintoLive>> {
    if (aucIds.length === 0) return new Map();
    const ts = Date.now();
    const maxReqs = aucIds.map((id) => ({
      path: `/include/httprequest_4MaxBid?timesession=${ts}&id=${id}`,
    }));
    const countReqs: { path: string; method: string; headers: Record<string, string>; body: string }[] = [];
    for (let i = 0; i < aucIds.length; i += 100) {
      countReqs.push({
        path: "/include/httprequest_api?getAuctionData=true&axios=1",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: aucIds.slice(i, i + 100).map((a) => `auctions%5B%5D=${a}`).join("&"),
      });
    }
    const texts = await browserApi(ORIGIN, [...maxReqs, ...countReqs], {
      sessionPath: "/w/all",
      concurrency: 6,
    });

    const out = new Map<string, BlintoLive>();
    for (let i = 0; i < maxReqs.length; i++) {
      const live = texts[i] != null ? parseMaxBid(texts[i]!) : null;
      if (live) out.set(live.aucId, { ...live, bidCount: null });
    }
    for (let i = maxReqs.length; i < texts.length; i++) {
      const t = texts[i];
      if (!t) continue;
      for (const [aucId, v] of parseAuctionData(t)) {
        const live = out.get(aucId);
        if (live) {
          if (v.bidCount != null) live.bidCount = v.bidCount;
          if (live.currentBid == null) live.currentBid = v.currentBid;
        } else {
          out.set(aucId, { aucId, currentBid: v.currentBid, endsAtRaw: null, nextMinBid: null, bidCount: v.bidCount });
        }
      }
    }
    return out;
  }

  /**
   * BATCHAT bud + antal bud för MÅNGA auktioner via getAuctionData (~100/anrop, en
   * stealth-session). Lätt (ingen per-objekt-XHR) → används på bulk-svepet i stället
   * för ~950 enskilda 4MaxBid. Ger INTE exakt sluttid (det kräver 4MaxBid).
   */
  async fetchBidData(aucIds: string[]): Promise<Map<string, BlintoBidData>> {
    if (aucIds.length === 0) return new Map();
    const reqs: { path: string; method: string; headers: Record<string, string>; body: string }[] = [];
    for (let i = 0; i < aucIds.length; i += 100) {
      reqs.push({
        path: "/include/httprequest_api?getAuctionData=true&axios=1",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: aucIds.slice(i, i + 100).map((a) => `auctions%5B%5D=${a}`).join("&"),
      });
    }
    const texts = await browserApi(ORIGIN, reqs, { sessionPath: "/w/all", concurrency: 6 });
    const out = new Map<string, BlintoBidData>();
    for (const t of texts) {
      if (!t) continue;
      for (const [aucId, v] of parseAuctionData(t)) out.set(aucId, v);
    }
    return out;
  }

  /** Live-data för ETT objekt (hot-poll/fetchItem): bud + exakt sluttid via 4MaxBid. */
  async fetchLiveOne(aucId: string): Promise<BlintoLive | null> {
    const m = (await this.fetchLive([aucId])).get(aucId);
    return m ?? null;
  }
}
