/**
 * Budi Auktioner (budi.se) - konkurs-/B2B-nätauktioner (maskiner, fordon, restaurang,
 * verktyg m.m.). Tre datakällor, alla utan browser/login:
 *  1. SSR-katalogen `/objekt?p=N&s=sho` (kumulativ, kortast tid kvar) → id, titel, kategori,
 *     stad, bild, sluttid. `?p=1` ger tomt (sida1-quirk) → paginering börjar på p=2.
 *  2. Batch-API:t `POST /api/wwwapi/auctionobject/batch/bidinfo` → per objekt: aktuellt bud
 *     (exkl+INKL moms + moms%), nästa bud, antal bud, isReservationPriceMet, isEnded, exakt
 *     sluttid. Detta är den auktoritativa live-datan (korten fylls delvis av JS).
 *  3. Objektsidans `<meta name="description">` → objektbeskrivning + AVGIFTSPARAMETRAR
 *     (data-budi-servicefee-*: fast belopp exkl moms ELLER dynamisk %=baspunkter+min,
 *     alltid +25 % moms på avgiften) - statiska per objekt, berikas en gång.
 * Rate-limitar aggressivt → retry m. backoff.
 */

const BASE = "https://www.budi.se";
const MEDIA = "https://media.budi.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export const PER_PAGE = 60;
const BIDINFO_CHUNK = 100; // objekt per batch-bidinfo-anrop

export interface BudiItem {
  id: string;
  title: string;
  image: string | null;
  category: string | null;
  location: string | null;
  currentBid: number | null; // vinnande bud EXKL moms (null om 0 bud)
  minBid: number | null; // startbud (visat belopp när 0 bud)
  bidCount: number;
  vatPercentage: number | null; // moms på budet (25)
  reserveMet: boolean | null; // isReservationPriceMet
  endsAt: string | null; // ISO UTC
  ended: boolean;
  description: string | null; // ur objektsidans meta (berikas)
  images: string[]; // hela galleriet ur objektsidan (berikas); tom → använd kortets thumbnail
  feeParams: BudiFeeParams | null; // serviceavgiftens parametrar (berikas/seedas)
  sourceUrl: string;
}

/**
 * Serviceavgiftens parametrar ur objektsidans data-attribut. Två modeller (Budis FAQ):
 * dynamisk procent (baspunkter, dynBps > 0) med minimibelopp, ELLER fast belopp
 * (fixedExVat). Båda exkl moms; +25 % moms läggs alltid på avgiften.
 */
export interface BudiFeeParams {
  fixedExVat: number | null;
  dynBps: number; // baspunkter (1600 = 16 %); 0 = ej dynamisk
  dynMinExVat: number; // minsta avgift vid dynamisk modell
  vatPct: number; // moms på avgiften (25)
}

/** Avgift (exkl moms) för ett bud enligt parametrarna. Null när något saknas. */
export function feeFor(p: BudiFeeParams | null, bid: number | null): number | null {
  if (p == null || bid == null || bid <= 0) return null;
  if (p.dynBps > 0) return Math.max(Math.round((bid * p.dynBps) / 10000), p.dynMinExVat);
  return p.fixedExVat;
}

/** Objektsidans berikning: beskrivning + bildgalleri + avgiftsparametrar (samma fetch). */
export interface BudiDetail {
  description: string | null;
  images: string[];
  feeParams: BudiFeeParams | null;
}

/** Live budinfo per objekt ur batch-API:t. */
export interface BudiBidInfo {
  currentBidExVat: number | null;
  nextBidExVat: number | null; // lägsta giltiga bud (bidNextAmount) - minsta bud man kan lägga
  vatPercentage: number | null;
  bidCount: number;
  reserveMet: boolean;
  isEnded: boolean;
  isBiddingOpen: boolean;
  endsAt: string | null;
}

/** Avkoda HTML-entiteter: &#xHH; (hex), &#DD; (dec) och vanliga namngivna. */
function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "950&nbsp;000&nbsp;kr" → 950000. Null om inget tal. */
function kr(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(decode(s).replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Bygg ren CDN-bild (rimlig storlek) ur kortets cdn-cgi/image-resize-URL. */
export function cleanImage(src: string | null | undefined): string | null {
  if (!src) return null;
  const m = /\/cdn-cgi\/image\/[^/]+\/(.+)$/.exec(src);
  if (m) return `${MEDIA}/cdn-cgi/image/format=auto,quality=high,width=800/${m[1]}`;
  return src;
}

/** "2026-07-01T09:03:00.000+02:00" (ISO m. tz, &#x2B; = +) → UTC-ISO. */
export function endIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = new Date(decode(raw));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function field(block: string, re: RegExp): string | null {
  const m = re.exec(block);
  return m ? (m[1] ?? null) : null;
}

/** Ren parser: en katalog-HTML → objekt (deduplicerade) + totalt antal träffar. */
export function parseCatalog(html: string): { items: BudiItem[]; total: number } {
  const totalM = />\s*([\d   ]+)\s*objekt/.exec(html);
  const total = totalM ? Number(totalM[1]!.replace(/[^\d]/g, "")) || 0 : 0;

  const byId = new Map<string, BudiItem>();
  const blocks = html.split(/(?=<a href="\/objekt\/)/).filter((b) => /data-budi-auctionobject-id=/.test(b));
  for (const b of blocks) {
    const id = field(b, /data-budi-auctionobject-id="(\d+)"/);
    if (!id || byId.has(id)) continue;
    const href = field(b, /^<a href="([^"]+)"/) ?? `/objekt/${id}`;
    const title = decode(
      field(b, /budi-auctionobject__desc[\s\S]*?title="([^"]+)"/) ??
        field(b, /<img[^>]+alt="([^"]+)"/) ??
        `Budi ${id}`,
    );
    const bidCount = Number(field(b, /bid-count notranslate"[^>]*>([^<]*)</)?.replace(/[^\d]/g, "") ?? "") || 0;
    const amount = kr(field(b, /bid-current-amount[^>]*>([^<]+)</));
    const hasBids = bidCount > 0;
    byId.set(id, {
      id,
      title,
      image: cleanImage(field(b, /<img\s+src="([^"]+)"/)),
      category: field(b, /categorykey="([^"]*)"/),
      location: decode(field(b, /citykey="([^"]*)"/) ?? "") || null,
      currentBid: hasBids ? amount : null,
      minBid: hasBids ? null : amount, // 0 bud → visat belopp = startbud
      bidCount,
      vatPercentage: null,
      reserveMet: null,
      endsAt: endIso(field(b, /endingdatetimeiso="([^"]+)"/)),
      ended: field(b, /isended="([^"]*)"/) === "true",
      description: null,
      images: [],
      feeParams: null,
      sourceUrl: `${BASE}${decode(href)}`,
    });
  }
  return { items: [...byId.values()], total };
}

/** Ren parser: en bidinfo-batchpost → id → live budinfo. */
export function parseBidInfo(json: string): Map<string, BudiBidInfo> {
  const out = new Map<string, BudiBidInfo>();
  let items: Record<string, unknown>[];
  try {
    items = (JSON.parse(json).items ?? []) as Record<string, unknown>[];
  } catch {
    return out;
  }
  for (const it of items) {
    const cur = (it.bidCurrentAmount ?? {}) as Record<string, unknown>;
    const next = (it.bidNextAmount ?? {}) as Record<string, unknown>;
    const exVat = Number(cur.exVat);
    const nextEx = Number(next.exVat);
    out.set(String(it.auctionObjectId), {
      currentBidExVat: Number.isFinite(exVat) && exVat > 0 ? exVat : null,
      nextBidExVat: Number.isFinite(nextEx) && nextEx > 0 ? nextEx : null,
      // OBS: 0 är ett giltigt värde (momsfri försäljning) - får inte kollapsa till null.
      vatPercentage: cur.vatPercentage != null && Number.isFinite(Number(cur.vatPercentage)) ? Number(cur.vatPercentage) : null,
      bidCount: Number(it.bidCount) || 0,
      reserveMet: it.isReservationPriceMet === true,
      isEnded: it.isEnded === true,
      isBiddingOpen: it.isBiddingOpen === true,
      endsAt: endIso(it.endingDateTimeIso as string),
    });
  }
  return out;
}

/** Ur objektsidans HTML: `<meta name="description">` → objektbeskrivning. */
export function parseDescription(html: string): string | null {
  const m = /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
  const d = m ? decode(m[1]!) : "";
  return d.length > 2 ? d : null;
}

/**
 * Ur objektsidans HTML: serviceavgiftens parametrar (data-budi-servicefee-*).
 * `dynpercentage-bps` > 0 → dynamisk (procent av budet, min `dynminexvat`);
 * annars fast `exvat`. Null om attributen saknas (t.ex. rate-limitat svar).
 */
export function parseFeeParams(html: string): BudiFeeParams | null {
  const attr = (name: string): number | null => {
    const m = new RegExp(`data-budi-servicefee-${name}="([\\d.]+)"`).exec(html);
    return m ? Number(m[1]) : null;
  };
  const fixed = attr("exvat");
  const bps = attr("dynpercentage-bps") ?? 0;
  if (fixed == null && bps <= 0) return null;
  return {
    fixedExVat: fixed,
    dynBps: bps,
    dynMinExVat: attr("dynminexvat") ?? 0,
    vatPct: attr("vatpercentage") ?? 25,
  };
}

/** Suffix-nummer i bildfilnamn: "102.jpg"→0 (huvudbild), "102-2.jpg"→2, "102-3.jpg"→3. */
function imgOrder(path: string): number {
  const m = /-(\d+)\.(?:jpe?g|png|webp)$/i.exec(path);
  return m ? Number(m[1]) : 0;
}

/**
 * Objektets bildBAS ur en bild-URL: "auctionobjects/images/{konto}/{n}(-x).jpg" →
 * "{konto}/{n}". Egna galleriet = n.jpg, n-2.jpg, n-3.jpg... under SAMMA bas.
 */
export function imageBase(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /auctionobjects\/images\/([^/]+)\/(\d+)(?:-\d+)?\.(?:jpe?g|png|webp)/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Ur objektsidans HTML: objektets EGET bildgalleri. OBS sidan bär ÄVEN ANDRA objekts
 * bilder ("fler objekt"-sektioner - upptäckt 2026-07-05: gallerier blandade fyra olika
 * kontobaser) → filtrera på objektets egen bas {konto}/{n} (ur kortets huvudbild).
 * Utan känd bas → tom lista (kortets thumbnail används då). Huvudbild först.
 */
export function parseGallery(html: string, mainImage?: string | null): string[] {
  const base = imageBase(mainImage);
  if (!base) return [];
  const paths = new Set<string>();
  const re = /media\.budi\.se\/(?:cdn-cgi\/image\/[^/]+\/)?(auctionobjects\/images\/[^"'\s?)]+\.(?:jpe?g|png|webp))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (imageBase(m[1]!) === base) paths.add(m[1]!);
  }
  return [...paths]
    .sort((a, b) => imgOrder(a) - imgOrder(b) || a.localeCompare(b))
    .map((p) => `${MEDIA}/cdn-cgi/image/format=auto,quality=high,width=800/${p}`);
}

async function get(url: string, tries = 4): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "X-Requested-With": "XMLHttpRequest", Referer: `${BASE}/objekt`, Accept: "text/html" },
      });
      if (res.ok) {
        const body = await res.text();
        if (body.length > 200) return body; // rate-limitat svar ~ 1 byte
      }
      lastErr = new Error(`Budi HTTP ${res.status} (${url})`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Budi fetch failed ${url}`);
}

async function postJson(path: string, body: unknown, tries = 3): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "User-Agent": UA, "content-type": "application/json", Origin: BASE, Referer: `${BASE}/objekt`, Accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.text();
      lastErr = new Error(`Budi HTTP ${res.status} (${path})`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Budi POST failed ${path}`);
}

export class BudiClient {
  /** En "sida": de KUMULATIVA första `page*60` objekten (s=sho), + totalt antal. */
  async fetchCumulative(page: number): Promise<{ items: BudiItem[]; total: number }> {
    const p = Math.max(page, 2); // p=1 ger tomt → börja på 2
    return parseCatalog(await get(`${BASE}/objekt?p=${p}&s=sho`));
  }

  /** Live budinfo (bud/moms/reserv/antal/sluttid) för många objekt via batch-API:t. */
  async fetchBidInfo(ids: string[]): Promise<Map<string, BudiBidInfo>> {
    const out = new Map<string, BudiBidInfo>();
    for (let i = 0; i < ids.length; i += BIDINFO_CHUNK) {
      const chunk = ids.slice(i, i + BIDINFO_CHUNK).map(Number).filter((n) => Number.isFinite(n));
      if (chunk.length === 0) continue;
      try {
        const json = await postJson("/api/wwwapi/auctionobject/batch/bidinfo?language=sv", { auctionObjectIds: chunk });
        for (const [id, info] of parseBidInfo(json)) out.set(id, info);
      } catch {
        /* hoppa trasig batch - list-kortens fält kvarstår */
      }
    }
    return out;
  }

  /** Objektsidan EN gång per objekt → beskrivning (meta) + EGET bildgalleri (filtrerat
   * på kortets huvudbilds bas) + avgiftsparametrar. */
  async fetchDetail(sourceUrl: string, mainImage?: string | null): Promise<BudiDetail> {
    try {
      const html = await get(sourceUrl);
      return {
        description: parseDescription(html),
        images: parseGallery(html, mainImage),
        feeParams: parseFeeParams(html),
      };
    } catch {
      return { description: null, images: [], feeParams: null };
    }
  }
}
