/**
 * Fabeo-klient. Fabeo (industri-/maskinauktioner) kör WooCommerce med
 * auktionspluginet "Auctions for WooCommerce". Två datakällor kombineras:
 *
 *   1. WooCommerce Store API (öppet JSON, ingen auth):
 *        GET https://fabeo.se/wp-json/wc/store/products?type=auction&per_page=100&page=N
 *      → katalog: id, namn, slug, permalink, bilder, beskrivning, kategori, valuta.
 *      Listar de AKTIVA auktionerna (out-of-stock/avslutade faller bort).
 *      Antal sidor i headern X-WP-TotalPages.
 *
 *   2. Objektsidan (SSR-HTML, /auktioner/{slug}/):
 *      → realtidsdata pluginet renderar och Store-API:t inte exponerar:
 *        aktuellt bud (data-bid), sluttid (data-time, unix), status (data-status),
 *        utropspris (Startbud), höjning per bud, slagavgift (per objekt!), objekts-
 *        moms, reservationsstatus och budhistorik (#auction-history-table).
 *
 * Avgiften (slagavgift) sätts per objekt och finns BARA på objektsidan → vi hämtar
 * objektsidan per objekt (Fabeo är litet, ~75 aktiva). `parseDetail` är ren och
 * enhetstestas mot sparade fixturer.
 */

const ORIGIN = "https://fabeo.se";
const STORE_PRODUCTS = `${ORIGIN}/wp-json/wc/store/products`;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Katalogprodukt från Store-API:t (de fält vi normaliserar). */
export interface FabeoProduct {
  id: number;
  name?: string;
  slug?: string;
  permalink?: string;
  short_description?: string;
  description?: string;
  images?: { id?: number; src?: string; thumbnail?: string }[];
  categories?: { id?: number; name?: string; slug?: string }[];
  prices?: { currency_code?: string };
}

/** En budrad ur objektsidans #auction-history-table. */
export interface FabeoBidRow {
  /** Pluginets logid (stabilt bud-id), ur <tr id="logid-NNN">. */
  logId: string;
  value: number;
  /** Visad tid, t.ex. "24 jun 22:22" (årslös → år härleds vid normalisering). */
  dateText: string;
  /** Anonymiserat budgivaralias (löpnummer per auktion), t.ex. "2". */
  bidder: string | null;
}

/** Realtidsdata utläst ur en objektsida. */
export interface FabeoDetail {
  auctionId: number;
  /** Aktuellt/ledande bud (data-bid). null om inga bud lagts (data-bid=0). */
  currentBid: number | null;
  /** Utropspris/startbud (Startbud:) — minsta "från"-pris. */
  startBid: number | null;
  /** Sluttid som unix-sekunder (data-time). */
  endUnix: number | null;
  /** data-status, t.ex. "running" eller "ended". */
  status: string | null;
  /** Höjning per bud (budsteg) i kronor. */
  bidIncrement: number | null;
  /** Slagavgift i kronor (per objekt, exkl. moms). */
  feeValue: number | null;
  /** Objektsmoms i procent på budet (25 normalt, 0 för momsbefriade). */
  vatRate: number;
  /** true = reservationspris uppnått, false = ej uppnått, null = inget reservpris. */
  reserveMet: boolean | null;
  bidCount: number;
  bids: FabeoBidRow[];
}

/** Tolka ett kronbelopp ur text/markup ("25 000", "10 500", "25 000&nbsp;kr"). */
export function parseKr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const digits = s.replace(/&nbsp;| /g, " ").replace(/[^\d]/g, "");
  if (!digits) return null;
  return Number(digits);
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;| /g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Ren parser av en objektsida → FabeoDetail. `productId` ankrar matchningen på
 * RÄTT auktion (sidan kan innehålla relaterade objekt med egna auktionselement).
 */
export function parseDetail(html: string, productId: number): FabeoDetail {
  const id = String(productId);
  const plain = stripTags(html);

  // --- Pris-spann för detta objekt: <span class="auction-price ..." data-auction-id
  //     data-bid data-status> … <span class="...Price-amount amount">BELOPP …
  const priceRe = new RegExp(
    `data-auction-id="${id}"\\s+data-bid="(\\d+)"\\s+data-status="([^"]+)"` +
      `[\\s\\S]*?Price-amount amount">([\\d\\s &nbsp;]+?)<`,
  );
  const priceM = priceRe.exec(html);
  const dataBid = priceM ? Number(priceM[1]) : null;
  const status = priceM ? (priceM[2] ?? null) : null;
  const shownPrice = priceM ? parseKr(priceM[3]) : null;
  // data-bid>0 → ledande bud; data-bid=0 → inga bud, då är shownPrice = startbud.
  const currentBid = dataBid != null && dataBid > 0 ? dataBid : null;
  const startBid =
    currentBid == null ? shownPrice : parseKrAfter(plain, "Startbud:");

  // --- Sluttid: <div class="… auction-time-countdown" data-time data-auctionid=id>
  const endRe = new RegExp(
    `auction-time-countdown"\\s+data-time="(\\d+)"\\s+data-auctionid="${id}"`,
  );
  const endM = endRe.exec(html);
  const endUnix = endM ? Number(endM[1]) : parseFirstCountdown(html);

  // --- Höjning per bud (budsteg). "Höjning per bud: 5 000 kr" (ASCII-säkert anker).
  const bidIncrement = parseKrAfter(plain, "jning per bud:");

  // --- Slagavgift per objekt: "En slagavgift på 10 500 kr (exkl. moms) tillkommer."
  const feeM = /slagavgift\s+p[^\d]*([\d\s ]+)\s*kr/i.exec(plain);
  const feeValue = feeM ? parseKr(feeM[1]) : null;

  // --- Objektsmoms på budet: "25% moms tillkommer på lagt bud" (0 om momsbefriad).
  const vatRate = parseVatRate(plain);

  // --- Reservationsstatus (raw): reservation_no/yes, eller inget reservpris.
  const reserveMet = parseReserve(html, plain);

  // --- Budhistorik (#auction-history-table): rader <tr class="bid" id="logid-NNN">.
  const bids = parseBidRows(html);
  const countM = /Bud\s*\((\d+)\)/.exec(plain);
  const bidCount = countM ? Number(countM[1]) : bids.length;

  return {
    auctionId: productId,
    currentBid,
    startBid,
    endUnix,
    status,
    bidIncrement,
    feeValue,
    vatRate,
    reserveMet,
    bidCount,
    bids,
  };
}

/** Tolka kronbeloppet som följer direkt efter en etikett i tag-strippad text. */
function parseKrAfter(plain: string, label: string): number | null {
  const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*([\\d\\s ]+)");
  const m = re.exec(plain);
  return m ? parseKr(m[1]) : null;
}

function parseFirstCountdown(html: string): number | null {
  const m = /auction-time-countdown"\s+data-time="(\d+)"/.exec(html);
  return m ? Number(m[1]) : null;
}

function parseVatRate(plain: string): number {
  if (/momsfri|momsbefria|ingen moms/i.test(plain)) return 0;
  const m = /(\d+)\s*%\s*moms\s+tillkommer/i.exec(plain);
  if (m) return Number(m[1]);
  return 25; // Fabeo-objekt är normalt momspliktiga (25 %).
}

function parseReserve(html: string, plain: string): boolean | null {
  if (/Inget reservationspris/i.test(plain)) return null;
  if (/reservation_yes/.test(html)) return true;
  if (/reservation_no/.test(html)) return false;
  if (/Reservationspris\s+ej\s+uppn/i.test(plain)) return false;
  if (/Reservationspris\s+uppn/i.test(plain)) return true;
  return null;
}

function parseBidRows(html: string): FabeoBidRow[] {
  const out: FabeoBidRow[] = [];
  const rowRe =
    /<tr class="bid" id="logid-(\d+)">([\s\S]*?)<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) != null) {
    const logId = m[1] ?? "";
    const cells = m[2] ?? "";
    const dateM = /class=['"]date['"]>([^<]*)</.exec(cells);
    const valM = /class=['"]bid['"]>[\s\S]*?Price-amount amount">([\d\s &nbsp;]+?)</.exec(cells);
    const userM = /class=['"]username['"]>([^<]*)</.exec(cells);
    const value = parseKr(valM?.[1]);
    if (value == null) continue;
    out.push({
      logId,
      value,
      dateText: (dateM?.[1] ?? "").trim(),
      bidder: userM?.[1]?.trim() || null,
    });
  }
  return out;
}

export class FabeoClient {
  /** Hämta alla AKTIVA auktionsprodukter ur Store-API:t (paginerar via headern). */
  async fetchActiveProducts(perPage = 100): Promise<FabeoProduct[]> {
    const out: FabeoProduct[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const url =
        `${STORE_PRODUCTS}?type=auction&per_page=${perPage}&page=${page}` +
        `&orderby=date&order=desc`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Fabeo Store API HTTP ${res.status}`);
      const arr = (await res.json()) as FabeoProduct[];
      out.push(...arr);
      const tp = Number(res.headers.get("x-wp-totalpages") ?? "1");
      totalPages = Number.isFinite(tp) && tp > 0 ? tp : 1;
      page++;
    } while (page <= totalPages);
    return out;
  }

  /** Hämta en enskild produkt ur Store-API:t (permalink + katalog). Null om borta. */
  async fetchProduct(id: string | number): Promise<FabeoProduct | null> {
    const res = await fetch(`${STORE_PRODUCTS}/${id}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Fabeo Store API HTTP ${res.status}`);
    return (await res.json()) as FabeoProduct;
  }

  /** Hämta + tolka en objektsida (realtidsdata + slagavgift + budhistorik). */
  async fetchDetail(
    permalink: string,
    productId: number,
  ): Promise<FabeoDetail | null> {
    const res = await fetch(permalink, {
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Fabeo objektsida HTTP ${res.status}`);
    const html = await res.text();
    return parseDetail(html, productId);
  }
}
