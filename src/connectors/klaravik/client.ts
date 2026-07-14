/**
 * Klaravik-klient. Klaravik (maskiner, fordon, lantbruk, entreprenad) har ett
 * öppet JSON-API (ingen auth):
 *   GET https://www.klaravik.se/api/products/list/search?page=N
 *   → { data: { items: [...], pagination: { totalPages, totalCount, pageSize } } }
 *
 * Listan ger ALLT utom objektsmomsen: id, namn, märke/modell, aktuellt bud,
 * EXAKT förmedlingsavgift (`auctionFee`, kr), budsteg, antal bud, sluttid (ISO),
 * län/kommun, kategori, bild och detalj-URL. Objektsmomsen (0/25 %) finns bara på
 * objektsidan (inbäddad JSON `{"id":...,"vat":..}`) → hämtas för heta objekt via
 * fetchDetail; i bulk härleds den ur kategorin (Fordon=0, annars 25) i map.ts.
 */

const ORIGIN = "https://www.klaravik.se";
const LIST = `${ORIGIN}/api/products/list/search`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface KlaravikItem {
  id: number;
  name?: string;
  make?: string | null;
  model?: string | null;
  startDate?: string;
  endDate?: string;
  currentBid?: number;
  startingPrice?: number;
  auctionFee?: number;
  bidStep?: number;
  nextBidStep?: number; // lägsta giltiga bud när inga bud lagts (startingPrice ofta 0)
  amountOfBids?: number;
  ended?: boolean;
  bankruptcy?: boolean;
  reservePriceStatus?: string;
  categoryNameLevel1?: string | null;
  categoryNameLevel2?: string | null;
  countyName?: string | null;
  municipalityName?: string | null;
  mainImage?: { imageUrlThumb?: string } | null;
  url?: string;
}

export interface KlaravikPage {
  items: KlaravikItem[];
  currentPage: number;
  totalPages: number;
  totalEntries: number;
}

/** Färskt läge för ETT objekt ur objektsidans inbäddade JSON. */
export interface KlaravikDetail {
  currentBid: number | null;
  vat: number; // 0 eller 25
  endUnix: number | null;
  ended: boolean;
  auctionFee: number | null;
}

/** Berikning ur objektsidan (hämtas EN gång/objekt): galleri + brödtext. */
export interface KlaravikContent {
  images: string[];
  description: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Thumbnail → fullstor bild: byt "_thumblarge" mot "_large" (53 kB → 543 kB) och
 * strippa `?v=`-cachebustern så list-API:ts huvudbild matchar galleriets URL:er
 * (annars dubbleras omslagsbilden).
 */
export function fullImage(thumbUrl: string | undefined | null): string | null {
  if (!thumbUrl) return null;
  return thumbUrl.replace("_thumblarge", "_large").replace(/\?.*$/, "");
}

/**
 * Plocka objektets EGNA galleribilder ur objektsidan. Sidan blandar in relaterade
 * objekts thumbnails → filtrera på objektets egen produkt-id-sökväg
 * (`/productimages/xx/yy/{id}/extrabilderN_large.jpg`). Behåll ordning, dedup,
 * max 30. (Ett objekt kan ha 40+ foton.)
 */
export function parseGallery(html: string, productId: number | string): string[] {
  const re = new RegExp(
    `https://media\\.se\\.klaravik\\.com/public/productimages/[a-f0-9]{2}/[a-f0-9]{2}/` +
      `${productId}/extrabilder\\d+_large\\.jpg`,
    "g",
  );
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) != null) {
    if (!seen.has(m[0])) {
      seen.add(m[0]);
      out.push(m[0]);
    }
    if (out.length >= 30) break;
  }
  return out;
}

/**
 * Brödtext ur objektsidan: `div.product-grid__content` (titel + Översikt/specar +
 * Utrustning + Skick). Klipps FÖRE Klaravik-standardtexten (videovisning / "Viktig
 * information" / CO₂-kalkylatorn) som ligger sist i samma container på varje sida.
 */
export function parseDescription(html: string): string | null {
  const open = /class="product-grid__content"[^>]*>/.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const endIdx = html.indexOf("product-grid__content end", start);
  const inner = html.slice(start, endIdx > start ? endIdx : start + 16000);
  const text = decodeEntities(
    inner
      .replace(/<\s*\/(?:p|li|tr|h[1-6]|div|td|th|ul|ol)\s*>/gi, "\n")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
  const boilerplate = [
    /Digital Visning/i,
    /Viktig information/i,
    /Vår auktionsmäklare/i,
    /Hur har vi räknat/i,
    /\bCO.?e\b/i,
  ];
  let cut = text.length;
  for (const re of boilerplate) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).slice(0, 4000).trim() || null;
}

/** fetch med korta omförsök vid övergående nät-/rate-limit-fel (3 försök). */
async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1))); // 0.4s, 0.8s backoff
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class KlaravikClient {
  async fetchPage(page = 1): Promise<KlaravikPage> {
    const res = await fetchRetry(`${LIST}?page=${page}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Klaravik list HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { items?: KlaravikItem[]; pagination?: { totalPages?: number; totalCount?: number } };
    };
    const data = body.data ?? {};
    return {
      items: data.items ?? [],
      currentPage: page,
      totalPages: data.pagination?.totalPages ?? 1,
      totalEntries: data.pagination?.totalCount ?? (data.items?.length ?? 0),
    };
  }

  /**
   * Hämta objektsidan EN gång och plocka både galleri OCH brödtext (tom vid fel).
   * Båda kommer ur samma HTML → en enda hämtning per objekt.
   */
  async fetchContent(url: string, productId: number | string): Promise<KlaravikContent> {
    try {
      const res = await fetchRetry(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
      if (!res.ok) return { images: [], description: null };
      const html = await res.text();
      return { images: parseGallery(html, productId), description: parseDescription(html) };
    } catch {
      return { images: [], description: null };
    }
  }

  /** Hämta objektsidan och läs ut färskt bud/moms/sluttid ur inbäddad JSON. */
  async fetchDetail(url: string): Promise<KlaravikDetail | null> {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Klaravik objektsida HTTP ${res.status}`);
    return parseDetail(await res.text());
  }
}

/** Ren parser av objektsidans inbäddade produkt-JSON (riktade fält, robust). */
export function parseDetail(html: string): KlaravikDetail | null {
  const num = (re: RegExp): number | null => {
    const m = re.exec(html);
    return m && m[1] != null ? Number(m[1]) : null;
  };
  const bid = num(/"bidBox":\{"bid":(\d+)\}/);
  const vat = num(/"vat":(\d+),"vmb"/);
  const endUnix = num(/"auctionEndTimeUnix":(\d+)/);
  const fee = num(/"auctionFee":(\d+)/);
  const statusM = /"status":"(\w+)"/.exec(html);
  if (bid == null && endUnix == null) return null; // inte en objektsida vi känner igen
  return {
    currentBid: bid,
    vat: vat ?? 25,
    endUnix,
    ended: statusM ? statusM[1] !== "online" : false,
    auctionFee: fee,
  };
}
