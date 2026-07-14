/**
 * Bukowskis-klient. Bukowskis (konst/design/smycken/ur) kör online-auktioner på
 * en server-renderad sajt (Ruby/HTMX). Ingen ren JSON-API, men LISTSIDAN bär all
 * data vi behöver server-renderat (Pusher används bara för live-push EFTER load):
 *
 *   GET https://www.bukowskis.com/sv/lots?page=N   (100 lotter/sida, ~16 sidor)
 *     Sorterad "slutar snart först" (data-end-date stigande).
 *
 * Varje lot-kort innehåller: data-lot-id, detalj-URL `/sv/auctions/{kod}/lots/
 * {objektId}-{slug}`, titel (img alt), data-end-date (unix), aktuellt bud
 * ("Aktuellt bud X CUR") eller "Inga bud", utropspris ("Utropspris X CUR"),
 * bilder (cloudfront) och valuta per lot (SEK/EUR — internationellt hus).
 *
 * `parseList` är ren och enhetstestas mot sparad fixtur.
 */

const ORIGIN = "https://www.bukowskis.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const PER_PAGE = 100; // serverstyrt

/** En lot utläst ur listsidan. */
export interface BukowskisLot {
  /** Internt lot-id (data-lot-id) — stabilt → vår externalId. */
  lotId: string;
  /** Objekt-id ur detalj-URL:en (skiljer sig från lotId). */
  objectId: string;
  /** Auktionskod ur detalj-URL:en, t.ex. "E1345" → auktions-gruppering. */
  auctionCode: string;
  /** Relativ detalj-URL. */
  href: string;
  title: string;
  /** Aktuellt/ledande bud, null om "Inga bud". */
  currentBid: number | null;
  /** Utropspris (lågt estimat) som "från"-referens. */
  estimate: number | null;
  currency: string;
  endUnix: number | null;
  hasBids: boolean;
  images: string[];
}

export interface BukowskisPage {
  lots: BukowskisLot[];
  currentPage: number;
  totalPages: number;
  totalEntries: number;
}

function parseKr(s: string | null | undefined): number | null {
  if (s == null) return null;
  const digits = s.replace(/&nbsp;| | /g, " ").replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;| /g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&aring;/g, "å");
}

const LOTID_RE = /data-lot-id="(\d+)"/g;
// Två detalj-URL-former: themed-auktion `/sv/auctions/{kod}/lots/{objId}-slug`
// och fristående online-lot `/sv/lots/{objId}-slug` (utan auktionskod). Kräver
// siffra direkt efter `lots/` → skiljer från nav-länkar (category/page/sort).
const LOT_ANCHOR =
  /href="(\/(?:sv|en)\/(?:auctions\/([^/"]+)\/)?lots\/(\d+)-[^"]*)"/;

/**
 * Ren parser: listsidans HTML → lotter. Varje kort inleds av en wrapper med
 * `data-end-date` + `data-lot-id` (i den ordningen), följt av två ankare (bild +
 * titel) och en caption (bud/utrop). Vi ankrar på data-lot-id (ett per kort,
 * unikt), läser sluttiden i ett litet bakåtfönster och resten framåt till nästa kort.
 */
export function parseList(html: string): BukowskisLot[] {
  const starts: { lotId: string; pos: number }[] = [];
  let m: RegExpExecArray | null;
  LOTID_RE.lastIndex = 0;
  while ((m = LOTID_RE.exec(html)) != null) {
    starts.push({ lotId: m[1] ?? "", pos: m.index });
  }

  const lots: BukowskisLot[] = [];
  for (let i = 0; i < starts.length; i++) {
    const cur = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.pos : html.length;
    const block = html.slice(cur.pos, end);
    const lookback = html.slice(Math.max(0, cur.pos - 80), cur.pos);
    const plain = stripTags(block);

    const anchorM = LOT_ANCHOR.exec(block);
    if (!anchorM) continue; // inget detalj-ankare → inte en länkbar lot
    const href = anchorM[1] ?? "";
    const auctionCode = anchorM[2] ?? "";
    const objectId = anchorM[3] ?? "";
    // Sluttiden ligger i wrappern strax FÖRE data-lot-id (bakåtfönster).
    const endUnix = num(/data-end-date="(\d+)"/.exec(lookback)?.[1]);
    const title = decodeEntities(/alt="([^"]*)"/.exec(block)?.[1] ?? "").trim();

    const bidM = /Aktuellt bud\s+([\d\s ]+?)\s+([A-Z]{3})/.exec(plain);
    const estM = /Utropspris\s+([\d\s ]+?)\s+([A-Z]{3})/.exec(plain);
    const hasBids = !/Inga bud/.test(plain) && bidM != null;
    const currentBid = hasBids ? parseKr(bidM?.[1]) : null;
    const estimate = parseKr(estM?.[1]);
    const currency = bidM?.[2] ?? estM?.[2] ?? "SEK";

    lots.push({
      lotId: cur.lotId,
      objectId,
      auctionCode,
      href,
      title,
      currentBid,
      estimate,
      currency,
      endUnix,
      hasBids,
      images: uniqueImages(block),
    });
  }
  return lots;
}

function num(s: string | undefined): number | null {
  return s != null ? Number(s) : null;
}

/** Plocka unika bild-URL:er (cloudfront) ur ett lot-block, i ordning. */
function uniqueImages(block: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Bilderna ligger i en HTML-kodad JSON-array (&quot;-separerad) → stoppa även
  // på & (cloudfront-URL:erna saknar query/&) så vi inte slukar hela arrayen.
  const re = /https:\/\/[a-z0-9]+\.cloudfront\.net\/[^"\\\s&]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) != null) {
    const url = m[0];
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
    if (out.length >= 8) break;
  }
  return out;
}

/** Totalt antal lotter ("1 588 föremål") → används för sidräkning. */
export function parseTotalEntries(html: string): number | null {
  const m = /([\d\s ]{1,9})\s*(?:föremål|f&ouml;rem|results|lots)/i.exec(html);
  return m ? parseKr(m[1]) : null;
}

/**
 * Ren parser: detaljsidans HTML → beskrivningstext ur lot-description-diven
 * (styckena innehåller teknik, signering, mått, skick m.m.). Klassnamnet varierar:
 * "lot-description" på auktionslotter, "c-lot-description" på fristående online-
 * lotter → substring-match. Null om diven saknas.
 */
export function parseLotDescription(html: string): string | null {
  const m = /<div class="[^"]*lot-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  if (!m) return null;
  const paragraphs = [...m[1]!.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((p) => decodeEntities(stripTags(p[1]!)).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const text = paragraphs.length
    ? paragraphs.join("\n")
    : decodeEntities(stripTags(m[1]!)).replace(/\s+/g, " ").trim();
  return text || null;
}

export class BukowskisClient {
  async fetchListPage(page = 1): Promise<BukowskisPage> {
    const res = await fetch(`${ORIGIN}/sv/lots?page=${page}`, {
      headers: { "User-Agent": UA, "Accept-Language": "sv-SE,sv;q=0.9", Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`Bukowskis lots HTTP ${res.status}`);
    const html = await res.text();
    const lots = parseList(html);
    const total = parseTotalEntries(html) ?? lots.length;
    const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
    return { lots, currentPage: page, totalPages, totalEntries: total };
  }

  /** Detaljsidan EN gång per objekt → lot-description-diven som beskrivning. */
  async fetchDetail(href: string): Promise<string | null> {
    try {
      const url = href.startsWith("http") ? href : `${ORIGIN}${href}`;
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "sv-SE,sv;q=0.9", Accept: "text/html" },
      });
      if (!res.ok) return null;
      return parseLotDescription(await res.text());
    } catch {
      return null;
    }
  }
}
