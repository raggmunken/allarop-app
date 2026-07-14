/**
 * Junora-klient. junora.se = Shopify-storefront MEN med en egen .NET-auktionsmotor
 * (`auctioneer-api.junora.se`). RENT öppet JSON-API, ingen auth, ingen browser:
 *   Lista:  GET auctioneer-api.junora.se/api/auctions/?page=N&pageSize=50
 *           &statusFilter=Active|Closed&sortBy=lastpublished&sortOrder=Descending
 *           → { total, auctions:[{remoteId,slug,name,city,imageUrl,numBids,
 *               currentPrice,startTimeUtc,endTimeUtc,status,...}] }
 *   Detalj: GET auctioneer-api.junora.se/api/auction/{slug}
 *           → { startingPrice, minimumBidAmount, reservationPrice, description(tunn),... }
 *   Galleri+rik beskrivning: GET junora.se/products/{slug}.json (Shopify) →
 *           product.images[] (~20) + product.body_html (spec-tabell).
 *
 * Sluttid = endTimeUtc (UTC, utan Z → lägg på). Budgivare anonymiserade (löpnummer)
 * → inga bud-rader. Slagavgift = fast avgift PER OBJEKT, visas bara inloggad ("framgår
 * på varje objekt i inloggat läge") → external-läge (som Retrade), ingen fejkad total.
 */

const API = "https://auctioneer-api.junora.se";
const SHOP = "https://junora.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface JunoraListItem {
  remoteId: string;
  slug: string;
  name: string;
  city: string | null;
  imageUrl: string | null;
  numBids: number;
  currentPrice: number | null;
  endTimeUtc: string | null; // "2026-07-02T09:50:00" (UTC, utan Z)
  status: number; // 2 = aktiv, 4 = avslutad
  reserveMet: boolean; // reservationPriceMet
  withoutReserve: boolean; // withoutReservationPrice = inget reservpris
}

export interface JunoraDetail {
  description: string | null; // ur Shopify body_html (spec-tabell → läsbar text)
  images: string[]; // fullt galleri (Shopify CDN)
  startBid: number | null; // startingPrice (utrop/golv)
  minBidAmount: number | null; // minimumBidAmount = minsta giltiga bud (även när currentPrice=0)
  reservePrice: number | null; // reservationPrice - sajten döljer det, API:t läcker det
  /** Bud-moms i procent ur säljartyp: 25 (företag) / 0 (privatperson/momsfri). null = okänt. */
  sellerVatRate: number | null;
}

/**
 * Bud-moms ur produktsidans säljartyp. Junora: "På samtliga objekt tillkommer moms om
 * inget annat anges" → default 25 (företag); "Säljs utav privatperson"/momsfri → 0.
 * null om sidan inte gick att läsa (behåll tidigare känt värde via COALESCE).
 */
export function parseSellerVat(pageHtml: string): number | null {
  if (!pageHtml || pageHtml.length < 200) return null;
  const plain = pageHtml.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");
  // Ankra på OBJEKTETS säljarrad ("Säljs utav privatperson/företag"), inte FAQ-texten
  // som nämner båda ("registrera konto som företag eller privatperson").
  if (/Säljs\s+(?:ut)?av\s+privatperson/i.test(plain)) return 0;
  if (/Säljs\s+(?:ut)?av\s+företag/i.test(plain)) return 25;
  if (/\bmomsfri|momsbefria/i.test(plain)) return 0;
  return 25; // "På samtliga objekt tillkommer moms om inget annat anges"
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** "2026-07-02T09:50:00" (UTC, utan zon) → ISO med Z. */
export function toIsoUtc(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(String(s));
  return m ? `${m[1]}Z` : null;
}

/** Ren parser: auctions-list-svaret → list-objekt + totalt antal. */
export function parseList(json: string): { items: JunoraListItem[]; total: number } {
  let o: { total?: number; auctions?: unknown[] };
  try {
    o = JSON.parse(json);
  } catch {
    return { items: [], total: 0 };
  }
  const items = (o.auctions ?? []).map((a) => {
    const it = a as Record<string, unknown>;
    return {
      remoteId: String(it.remoteId ?? it.id ?? ""),
      slug: String(it.slug ?? ""),
      name: String(it.name ?? ""),
      city: it.city != null ? String(it.city) : null,
      imageUrl: it.imageUrl != null ? String(it.imageUrl) : null,
      numBids: Number(it.numBids ?? 0),
      currentPrice: num(it.currentPrice),
      endTimeUtc: it.endTimeUtc != null ? String(it.endTimeUtc) : null,
      status: Number(it.status ?? 0),
      reserveMet: it.reservationPriceMet === true,
      withoutReserve: it.withoutReservationPrice === true,
    };
  });
  return { items, total: Number(o.total ?? items.length) };
}

/** Shopify body_html (spec-tabell + ev. fritext) → läsbar flerradig text. */
export function bodyHtmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  let s = html.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<script[\s\S]*?<\/script>/gi, " ");
  // Spec-tabellrader <tr><td>nyckel</td><td>värde</td></tr> → "nyckel: värde".
  s = s.replace(/<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi,
    (_m, k, v) => `\n${stripTags(k)}: ${stripTags(v)}`);
  s = s.replace(/<\/(?:p|div|li|h\d|br)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  const text = decodeEntities(stripTags(s))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.slice(0, 3000) || null;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&aring;/gi, "å").replace(/&auml;/gi, "ä").replace(/&ouml;/gi, "ö")
    .replace(/&nbsp;/g, " ");
}

/** Ren parser: Shopify product.json + auction-detalj → galleri + beskrivning + startbud. */
export function parseDetail(productJson: string, auctionJson: string, pageHtml = ""): JunoraDetail {
  let images: string[] = [];
  let description: string | null = null;
  try {
    const p = JSON.parse(productJson).product as { images?: { src?: string }[]; body_html?: string };
    images = (p.images ?? []).map((im) => String(im.src ?? "")).filter(Boolean).slice(0, 40);
    description = bodyHtmlToText(p.body_html);
  } catch {
    /* ingen Shopify-produkt → galleri/desc saknas */
  }
  let startBid: number | null = null;
  let minBidAmount: number | null = null;
  let reservePrice: number | null = null;
  try {
    const d = JSON.parse(auctionJson) as Record<string, unknown>;
    startBid = num(d.startingPrice);
    minBidAmount = num(d.minimumBidAmount);
    // Reservpris: sajten döljer det, API:t läcker det. Junora har dock enstaka
    // overflow-/felinmatade värden (t.ex. 5,4 biljoner) → filtrera bort orimliga.
    const rp = num(d.reservationPrice);
    reservePrice = rp != null && rp > 0 && rp < 100_000_000 ? rp : null;
    if (!description) description = d.description != null ? String(d.description).trim() || null : null;
  } catch {
    /* ingen auktionsdetalj */
  }
  return { description, images, startBid, minBidAmount, reservePrice, sellerVatRate: parseSellerVat(pageHtml) };
}

async function fetchRetry(url: string, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*", "Accept-Language": "sv", Origin: SHOP, Referer: `${SHOP}/` },
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export class JunoraClient {
  /** En sida ur auktionslistan. page är 1-baserad (API:t är 0-baserat → -1). */
  async fetchListPage(page = 1, ended = false): Promise<{ items: JunoraListItem[]; total: number }> {
    const status = ended ? "Closed" : "Active";
    const res = await fetchRetry(
      `${API}/api/auctions/?page=${page - 1}&pageSize=50&sortBy=lastpublished&statusFilter=${status}&sortOrder=Descending`,
    );
    if (!res.ok) throw new Error(`Junora list HTTP ${res.status}`);
    return parseList(await res.text());
  }

  /** Färskt live-läge för ETT objekt (hett-poll): bud + sluttid + antal bud + startbud. */
  async fetchLive(
    slug: string,
  ): Promise<{ currentPrice: number | null; endTimeUtc: string | null; numBids: number; startBid: number | null } | null> {
    try {
      const res = await fetchRetry(`${API}/api/auction/${slug}`);
      if (!res.ok) return null;
      const d = JSON.parse(await res.text()) as Record<string, unknown>;
      return {
        currentPrice: num(d.currentPrice),
        endTimeUtc: d.endTimeUtc != null ? String(d.endTimeUtc) : null,
        numBids: Number(d.numberOfBids ?? 0),
        startBid: num(d.startingPrice),
      };
    } catch {
      return null;
    }
  }

  /** Galleri + rik beskrivning (Shopify) + startbud (auktions-API), berikas en gång. */
  async fetchDetail(slug: string): Promise<JunoraDetail | null> {
    try {
      const [prod, auc, page] = await Promise.all([
        fetchRetry(`${SHOP}/products/${slug}.json`).then((r) => (r.ok ? r.text() : "{}")),
        fetchRetry(`${API}/api/auction/${slug}`).then((r) => (r.ok ? r.text() : "{}")),
        // Produktsidans HTML bär säljartypen ("Säljs utav företag/privatperson") → bud-moms.
        fetchRetry(`${SHOP}/products/${slug}`).then((r) => (r.ok ? r.text() : "")),
      ]);
      return parseDetail(prod, auc, page);
    } catch {
      return null;
    }
  }
}
