/**
 * Netauktion-klient (netauktion.se = Netauctions). Generella nätauktioner. Ren
 * server-renderad HTML + ett LÄTTVIKTIGT batch-API för live-data:
 *   Lista:   GET  /kategori/alla?pagenumber=N    (~20 object-card/sida, paginerat)
 *   Status:  POST /ajaxfunctions.php  action=update_auction_status&products=[ids]
 *            → per objekt: top_bid, top_bid_with_fee_and_tax (EXAKT totalpris),
 *              top_bidder(+id), next_ok_bid, expiration_datetime, is_active,
 *              reserve_met, bid_box (HEL budhistorik med namn). BATCHAT → en handfull
 *              anrop räcker för ALLA bud/totaler/ledare. Inga tunga objektsidor för bud.
 *   Detalj:  GET  /auktion/{slug}?product={id}    (BARA beskrivning + galleri, en gång)
 *
 * Budgivarnamn exponeras → ledare + budhistorik lagras. Plain HTTP, ingen browser.
 */

const ORIGIN = "https://www.netauktion.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface NetauktionItem {
  productId: string;
  slug: string;
  title: string;
  location: string | null;
  endText: string | null; // "2026-06-28 19:35:00" (kort, reserv)
  image: string | null;
}

export interface NetauktionBid {
  value: number;
  bidderName: string | null;
  bidderId: string | null;
  date: string | null; // "2026-06-22 21:34"
  autobid: boolean;
}

/** Live-status per objekt ur batch-API:t (update_auction_status). */
export interface NetauktionStatus {
  productId: string;
  currentBid: number | null;
  total: number | null; // top_bid_with_fee_and_tax = EXAKT "att betala"
  nextBid: number | null; // next_ok_bid = lägsta giltiga bud (startbud om inga bud)
  leaderName: string | null;
  leaderId: string | null;
  endText: string | null; // expiration_datetime (auktoritativ sluttid)
  active: boolean;
  reserveMet: boolean;
  bids: NetauktionBid[]; // hel budhistorik ur bid_box
}

export interface NetauktionDetail {
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

function num(s: unknown): number | null {
  if (s == null) return null;
  const d = String(s).replace(/[^\d]/g, "");
  return d ? Number(d) : null;
}

function fullImage(src: string | null): string | null {
  if (!src) return null;
  const u = src.startsWith("http") ? src : `${ORIGIN}${src}`;
  return u.replace(/-m(\.(?:jpg|jpeg|png))$/i, "-l$1"); // miniatyr → större
}

const CARD =
  /<article id='(\d+)'[^>]*category-object-list[\s\S]*?(?=<article id='\d+'[^>]*category-object-list|<\/section)/gi;

/** Ren parser: listsidans object-card → katalogobjekt (dedup på productId). */
export function parseList(html: string): NetauktionItem[] {
  const out: NetauktionItem[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CARD.lastIndex = 0;
  while ((m = CARD.exec(html)) != null) {
    const block = m[0];
    const productId = m[1] ?? "";
    if (seen.has(productId)) continue;
    const hrefM = /\/auktion\/([a-z0-9-]+)\?product=\d+/i.exec(block);
    if (!hrefM) continue;
    seen.add(productId);

    const title = decode(stripTags(/object-card-title-text">([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? ""))
      .replace(/\s+/g, " ").trim();
    const items = [...block.matchAll(/object-card-item-text">([\s\S]*?)<\/div>/gi)].map((x) =>
      decode(stripTags(x[1] ?? "")).replace(/\s+/g, " ").trim(),
    );
    const loc = items.find((t) => /^Lagringsort:/i.test(t))?.replace(/^Lagringsort:\s*/i, "") || null;
    const endRaw = items.find((t) => /^Avslutas:/i.test(t))?.replace(/^Avslutas:\s*/i, "") || null;
    const imgM = /<img[^>]*src=['"]([^'"]*\/uploads\/[^'"]+)['"]/i.exec(block);

    out.push({
      productId,
      slug: hrefM[1] ?? "",
      title,
      location: loc,
      endText: endRaw && /\d{4}-\d{2}-\d{2}/.test(endRaw) ? endRaw : null,
      image: fullImage(imgM?.[1] ?? null),
    });
  }
  return out;
}

/** Sista sidan i pagineringen (max GoToPage(N)). */
export function parseTotalPages(html: string): number {
  const nums = [...html.matchAll(/GoToPage\((\d+)\)/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums, 1) : 1;
}

/** Budhistorik ur `bid_box`-HTML: <li> med datum, register_id, u-name, pris, autobud. */
export function parseBidBox(bidBox: string | null | undefined): NetauktionBid[] {
  if (!bidBox) return [];
  const out: NetauktionBid[] = [];
  for (const li of (bidBox.match(/<li class="row">[\s\S]*?<\/li>/gi) ?? [])) {
    const value = num(/<b>([\d\s]+)\s*SEK/i.exec(li)?.[1]);
    if (value == null) continue;
    const name = decode(/u-name"><span>([^<]*)<\/span>/i.exec(li)?.[1] ?? "").trim() || null;
    const id = /register_id="(\d+)"/i.exec(li)?.[1] ?? null;
    const dm = /<span>(\d{4}-\d{2}-\d{2})[^<]*<br>\s*([\d:]+)/i.exec(li);
    out.push({
      value,
      bidderName: name,
      bidderId: id,
      date: dm ? `${dm[1]} ${dm[2]}` : null,
      autobid: /autobud/i.test(li),
    });
  }
  return out;
}

/** Ren parser: update_auction_status-svaret (JSON-array) → status per productId. */
export function parseStatusArray(json: string): Map<string, NetauktionStatus> {
  const out = new Map<string, NetauktionStatus>();
  let arr: Record<string, unknown>[];
  try {
    arr = JSON.parse(json);
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const o of arr) {
    const id = String(o.product_id ?? "");
    if (!id) continue;
    const bid = num(o.top_bid);
    out.set(id, {
      productId: id,
      currentBid: bid != null && bid > 0 ? bid : null,
      total: num(o.top_bid_with_fee_and_tax),
      nextBid: num(o.next_ok_bid),
      leaderName: o.top_bidder ? decode(String(o.top_bidder)) : null,
      leaderId: o.top_bidder_id != null ? String(o.top_bidder_id) : null,
      endText: o.expiration_datetime ? String(o.expiration_datetime) : null,
      active: Number(o.is_active) === 1,
      reserveMet: o.reserve_met === true,
      bids: parseBidBox(o.bid_box as string),
    });
  }
  return out;
}

/** Ren parser: objektsidan → BARA beskrivning + objektets EGNA galleribilder. */
export function parseDetail(html: string, productId: string | number): NetauktionDetail {
  const plain = decode(stripTags(html)).replace(/\s+/g, " ");
  const descM =
    /<div[^>]*class="[^"]*(?:object-description|auction-description|product-description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
  let description = descM ? decode(stripTags(descM[1] ?? "")).replace(/[ \t]+/g, " ").trim() : null;
  if (!description) {
    const s = /Starttid:\s*[\d:]+([\s\S]{20,1200}?)(?:Liknande|Andra objekt|Slagavgift|Frakt|Dela|<\/)/i.exec(plain);
    description = s ? s[1]!.trim().slice(0, 2000) || null : null;
  }

  // Galleri: BARA detta objekts egna bilder ur containern
  // `class="product-images my-simple-gallery-{productId}"` (varje lott har en egen).
  const images: string[] = [];
  const seen = new Set<string>();
  const start = html.search(new RegExp(`class="product-images my-simple-gallery-${productId}"`));
  if (start >= 0) {
    const rest = html.slice(start + 30);
    const nextGallery = rest.search(/my-simple-gallery-\d/);
    const block = nextGallery > 0 ? rest.slice(0, nextGallery) : rest.slice(0, 8000);
    for (const m of block.matchAll(
      /href=['"](\/uploads\/[a-z0-9_-]+\.(?:jpg|jpeg|png))['"][^>]*itemprop=['"]contentUrl/gi,
    )) {
      const url = fullImage(m[1]!)!;
      if (!seen.has(url)) {
        seen.add(url);
        images.push(url);
      }
      if (images.length >= 40) break;
    }
  }
  return { description, images };
}

async function fetchRetry(url: string, init: RequestInit = {}, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "User-Agent": UA, "Accept-Language": "sv", ...(init.headers ?? {}) },
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

export class NetauktionClient {
  async fetchListPage(page = 1): Promise<{ items: NetauktionItem[]; totalPages: number }> {
    const res = await fetchRetry(`${ORIGIN}/kategori/alla?pagenumber=${page}`);
    if (!res.ok) throw new Error(`Netauktion list HTTP ${res.status}`);
    const html = await res.text();
    return { items: parseList(html), totalPages: parseTotalPages(html) };
  }

  /**
   * LÄTTVIKTIG batch-hämtning av live-status (bud/total/ledare/sluttid/budhistorik)
   * för många objekt via update_auction_status (chunkat ~80/anrop). Ersätter de tunga
   * objektsidorna för bud → snabbt nog att köra varje svep + hett-poll.
   */
  async fetchStatus(productIds: string[]): Promise<Map<string, NetauktionStatus>> {
    const out = new Map<string, NetauktionStatus>();
    for (let i = 0; i < productIds.length; i += 80) {
      const chunk = productIds.slice(i, i + 80);
      try {
        const res = await fetchRetry(`${ORIGIN}/ajaxfunctions.php`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
          },
          body: `action=update_auction_status&products=${encodeURIComponent(JSON.stringify(chunk))}`,
        });
        if (res.ok) for (const [id, s] of parseStatusArray(await res.text())) out.set(id, s);
      } catch {
        /* tappar en chunk → faller tillbaka på senast kända; logga ej */
      }
    }
    return out;
  }

  /** Objektsidan EN gång per objekt: beskrivning + galleri (tung ~500 kB → gradvis). */
  async fetchDetail(slug: string, productId: string | number): Promise<NetauktionDetail | null> {
    try {
      const res = await fetchRetry(`${ORIGIN}/auktion/${slug}?product=${productId}`);
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return parseDetail(await res.text(), productId);
    } catch {
      return null;
    }
  }
}
