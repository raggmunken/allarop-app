/**
 * Kronofogden-klient. auktion.kronofogden.se kör auktionsplattformen **Auction2000**
 * (white-label; samma motor driver flera svenska aktörer). Sidorna är server-
 * renderade (jQuery) MEN live-datan (startpris, bud, nedräkning) fylls i av ett
 * statefullt `.ajax`-flöde EFTER laddning → den syns bara i en RIKTIG webbläsare.
 * Därför hämtas listan via CloakBrowser (renderad DOM), medan objektsidan (statisk
 * beskrivning + galleri) går via ren HTTP.
 *
 *   - Lista (alla webauktioner): GET /auk/w.ObjectList?inC=KFM&inA=WEB  (browser-render)
 *   - Detalj (statisk):          GET /auk/w.object?inC=KFM&inA={inA}&inO={inO}  (HTTP)
 *
 * Sluttiden visas BARA som nedräkning ("10 tim 46 minuter") → endsAt = nu + offset
 * (minutprecision; sista minuten ger sekunder). Avgift: "Inga avgifter tillkommer"
 * → totalpris = bud. Siffror är HTML-entity-obfuskerade (`&#50;&#52;`=24) → avkodas.
 */

import { browserFetch } from "../../browser/cloak.ts";

const ORIGIN = "https://auktion.kronofogden.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface KronofogdenItem {
  objId: string; // intern Auction2000-id (id="114170") = externalId
  inA: string; // auktions-id (20260615_1158) - för detalj-URL + bild
  inO: string; // objektnummer i auktionen - för detalj-URL
  varunr: string | null; // "F106066"
  title: string;
  location: string | null; // adress/ort
  estimate: number | null; // Utrop (värdering)
  startBid: number | null; // Startpris (lägsta bud) - visas tills bud finns
  currentBid: number | null; // Högsta bud (null tills någon budar)
  endsAt: string | null; // beräknad ur nedräkningen
  image: string | null;
}

export interface KronofogdenDetail {
  description: string | null;
  images: string[];
}

function decode(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .replace(/&aring;/gi, "å").replace(/&auml;/gi, "ä").replace(/&ouml;/gi, "ö")
    .replace(/&Aring;/g, "Å").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}

/** "12 000 SEK" / "&#49;&#50; 000" → 12000 (avkoda först, strippa allt utom siffror). */
function parseKr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const d = decode(String(s)).replace(/[^\d]/g, "");
  return d ? Number(d) : null;
}

/** Full-storleksbild ur storleksvariant-URL: `..._1_thumb.jpg`/`..._1_mid.jpg` → `..._1.jpg`.
 * Auction2000 serverar SAMMA foto i flera storlekar (_thumb liten, _mid mellan, ingen
 * suffix = full) → normalisera till full så galleriets dedup (seen-Set) fäller dubblerna. */
function fullImage(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/_(?:thumb|mid|small)(\.(?:jpg|jpeg|png))/i, "$1");
}

/**
 * Nedräkning → absolut sluttid (ISO). Auction2000 visar bara relativ tid:
 * "3 dygn", "10 tim 46 minuter", "5 minuter 12 sekunder". endsAt = now + offset.
 * Returnerar null om texten inte är en nedräkning (tom/"Avslutad").
 */
export function parseCountdown(text: string | null | undefined, now = new Date()): string | null {
  if (!text) return null;
  const t = decode(text).toLowerCase();
  if (/avslut|slut\b|s.ld|stängd/.test(t)) return null;
  let ms = 0;
  let hit = false;
  const add = (re: RegExp, unit: number) => {
    const m = re.exec(t);
    if (m) {
      ms += Number(m[1]) * unit;
      hit = true;
    }
  };
  add(/(\d+)\s*dygn/, 86_400_000);
  add(/(\d+)\s*tim/, 3_600_000);
  add(/(\d+)\s*min/, 60_000);
  add(/(\d+)\s*sek/, 1_000);
  if (!hit) return null;
  return new Date(now.getTime() + ms).toISOString();
}

const CARD =
  /<div id="(\d+)" class="obj_thumbnail[\s\S]*?(?=<div id="\d+" class="obj_thumbnail|<\/div>\s*<\/div>\s*<\/div>\s*<div class="col_obj_list|$)/g;

/** Sista sidan i pagineringen (GTo(N) i pagineringskontrollen; default 1). */
export function parseTotalPages(html: string): number {
  const nums = [...html.matchAll(/GTo\((\d+)\)/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums, 1) : 1;
}

/** Ren parser: renderade listsidan → objekt (live bud/startpris/nedräkning ingår). */
export function parseList(html: string, now = new Date()): KronofogdenItem[] {
  const out: KronofogdenItem[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CARD.lastIndex = 0;
  while ((m = CARD.exec(html)) != null) {
    const block = m[0];
    const objId = m[1] ?? "";
    if (seen.has(objId)) continue;

    const link = /href="w\.object\?inC=KFM&(?:amp;)?inA=([0-9_]+)&(?:amp;)?inO=(\d+)"/i.exec(block);
    if (!link) continue;
    seen.add(objId);
    const inA = link[1] ?? "";
    const inO = link[2] ?? "";

    // Textcontainer obj_txt: varunr (text-muted) + titel (textnod) + ort (map-marker).
    const txt = new RegExp(`obj_txt c_obj_${objId}[\\s\\S]*?</div>`, "i").exec(block)?.[0] ?? block;
    const varunr = /class="text-muted">([^<]+)</i.exec(txt)?.[1]?.replace(/\.$/, "").trim() ?? null;
    // Titel = textnoden efter varunr-spanen, fram till <br>.
    const titleM = /class="text-muted">[^<]*<\/span>([^<]*)<br/i.exec(txt);
    const title = decode((titleM?.[1] ?? "").trim()) || `Kronofogden ${objId}`;
    const locM = /glyphicon-map-marker"><\/span>\s*([^<]+?)\s*<\/small>/i.exec(txt);
    const location = locM ? decode(locM[1]!.trim()) : null;

    // Utrop = det nico28-värde som har SEK (label-spanen "Utrop" saknar SEK); de
    // mellanliggande rs_skip-spanen (nico15..) är budstegs-alternativ → hoppa.
    const estimate =
      [...txt.matchAll(/class="nico\d+(?!\s+rs_skip)[^"]*">([\d\s&#;]+?)\s*SEK</gi)]
        .map((x) => parseKr(x[1]))
        .filter((n): n is number => n != null)
        .pop() ?? null;

    // Live bud-text bid_txt_{objId}: "Startpris 12 000 SEK" (inga bud) eller
    // "Högsta bud 37 000 SEK" (bud finns; texten ligger i en nästlad responsiv span
    // → strippa taggar). Ta FÖRSTA beloppet (responsiva dubbletter förekommer).
    const bidRaw = new RegExp(`bid_txt_${objId}[\\s\\S]{0,160}`, "i").exec(block)?.[0] ?? "";
    const bidText = decode(stripTags(bidRaw)).replace(/\s+/g, " ");
    const amt = parseKr(/([\d][\d\s]*)\s*SEK/i.exec(bidText)?.[1]);
    const isStart = /startpris/i.test(bidText);
    const startBid = isStart ? amt : null;
    const currentBid = isStart ? null : amt;

    const cd = new RegExp(`time_txt_${objId}[^>]*>([^<]*)<`, "i").exec(block)?.[1] ?? null;
    // Bild-URL ligger i obj_morepic onmouseover-handlern: https://picNN.auction2000
    // .online/aukpic/kfm/{inA}/{objId}_1_thumb.jpg?... → ta första, full storlek.
    const imgM = new RegExp(
      `https://[a-z0-9.]*auction2000\\.online/aukpic/[^'"\\s]*${objId}_1_thumb\\.(?:jpg|jpeg|png)`,
      "i",
    ).exec(block);

    out.push({
      objId,
      inA,
      inO,
      varunr,
      title,
      location,
      estimate,
      startBid,
      currentBid,
      endsAt: parseCountdown(cd, now),
      image: fullImage(imgM ? imgM[0] : null),
    });
  }
  return out;
}

/** Block-HTML → läsbar flerradig text (<br> → radbrytning, avkoda entities). */
function htmlToText(s: string): string {
  // Konsumera omgivande whitespace runt <br> så källans `<br>\n` blir EN radbrytning
  // (ej dubbel); enkel <br> = radbrytning, `<br><br>` = stycke.
  return decode(s.replace(/\s*<\s*br\s*\/?>\s*/gi, "\n").replace(/<[^>]+>/g, ""))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Ren parser: objektsidan (statisk SSR) → beskrivning + galleri. */
export function parseDetail(html: string, objId: string, inA: string): KronofogdenDetail {
  // Beskrivning: <div style="margin-top:20px;"><p>...</p> (fri text med <br>, slutar
  // med "Varunr ..."). INGEN "Beskrivning"-rubrik → ankra på blocket. Klipp FÖRE
  // Kronofogdens standardtext (frakt-/skick-/momsdisclaimer) som ligger sist i samma <p>.
  let description: string | null = null;
  const block = /margin-top:20px[^>]*>\s*<p>([\s\S]*?)<\/p>/i.exec(html);
  if (block) {
    let text = htmlToText(block[1] ?? "");
    const cut = text.search(
      /Vi (?:kan inte erbjuda frakt|erbjuder frakt|säljer all egendom)|Objektet har ing[åa]tt i momspliktig/i,
    );
    if (cut > 0) text = text.slice(0, cut).trim();
    description = text.slice(0, 2500) || null;
  }

  // Galleri: objektets egna bilder (aukpic/kfm/{inA}/{objId}_N...), full storlek.
  const images: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(`https://[a-z0-9.]*auction2000[^"'\\s]*${objId}_\\d+[^"'\\s]*\\.(?:jpg|jpeg|png)`, "gi");
  let im: RegExpExecArray | null;
  while ((im = re.exec(html)) != null) {
    const url = fullImage(im[0].replace(/\?\d+$/, ""))!;
    if (!seen.has(url)) {
      seen.add(url);
      images.push(url);
    }
    if (images.length >= 30) break;
  }
  return { description, images };
}

async function fetchRetry(url: string, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "sv" } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class KronofogdenClient {
  /**
   * Renderar EN listsida (inPageNo, 48 objekt/sida) i CloakBrowser. Live-data
   * (bud/startpris/nedräkning) fylls av .ajax efter laddning → networkidle + dwell.
   */
  async fetchListPage(page = 1, now = new Date()): Promise<{ items: KronofogdenItem[]; totalPages: number }> {
    const html = await browserFetch(
      `${ORIGIN}/auk/w.ObjectList?inC=KFM&inA=WEB&inPageNo=${page}`,
      { waitUntil: "networkidle", dwellMs: 6000 },
    );
    return { items: parseList(html, now), totalPages: parseTotalPages(html) };
  }

  /**
   * Hela aktiva webkatalogen: rendera sida 1 → läs antal sidor (GTo) → rendera
   * resten. ~7 sidor à 48 = ~334 objekt. Sidorna är sorterade slutar-snart-först.
   */
  async fetchList(maxPages = 20): Promise<KronofogdenItem[]> {
    // Nedräkningen är relativ → varje sida tidsstämplas vid SIN render (fetchListPage
    // defaultar now=nu) så sluttiden inte snedvrids av att sida 7 renderas senare.
    const first = await this.fetchListPage(1);
    const all = [...first.items];
    const seen = new Set(all.map((i) => i.objId));
    const pages = Math.min(first.totalPages, maxPages);
    for (let p = 2; p <= pages; p++) {
      try {
        const { items } = await this.fetchListPage(p);
        for (const it of items) if (!seen.has(it.objId)) {
          seen.add(it.objId);
          all.push(it);
        }
      } catch {
        /* tappar en sida → fortsätt; nästa svep fyller på */
      }
    }
    return all;
  }

  /** Objektsidan (statisk) via ren HTTP → beskrivning + galleri. */
  async fetchDetail(inA: string, inO: string, objId: string): Promise<KronofogdenDetail | null> {
    try {
      const res = await fetchRetry(`${ORIGIN}/auk/w.object?inC=KFM&inA=${inA}&inO=${inO}`);
      if (!res.ok) return null;
      return parseDetail(await res.text(), objId, inA);
    } catch {
      return null;
    }
  }
}
