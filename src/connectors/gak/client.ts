/**
 * Göteborgs Auktionskammare (goteborgsauktionskammare.se) - traditionellt konst-/kvalitets-
 * auktionshus, timade online-auktioner (lotter stänger staggrat). RENT SSR-PHP, ingen browser:
 * `/auktion/objekt-översikt?sorting=byTime&direction=asc&showEnded=no&page=N` (44 objekt/sida).
 * Kort: `<div class="item" data-item-id="{id}">` med titel, sluttid (timeWrapper "23 augusti
 * 15:01"), bud (itemCurrentBid), bild (tn/small-tumnagel → full utan tn/small). Detalj
 * `/auktion/objekt/{slug}/{id}`: beskrivning + AVGIFTER (upptäckt 2026-07-03) - priceInfo-
 * divens data-attribut: data-purchase-fee (%), data-auction-fee (kr), data-item-vat (rate).
 * Verifierat 8/8: total = bud × (1 + fee% + itemVat) + slagavgift (avgifterna inkl moms).
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const MONTHS: Record<string, number> = {
  januari: 0, februari: 1, mars: 2, april: 3, maj: 4, juni: 5,
  juli: 6, augusti: 7, september: 8, oktober: 9, november: 10, december: 11,
};

/** "23 augusti 15:01" (svensk lokaltid, utan år) → UTC-ISO. Antar närmaste framtida år. */
export function parseSwedishMonthDate(raw: string | null | undefined, now = new Date()): string | null {
  if (!raw) return null;
  const m = /(\d{1,2})\s+([a-zåäö]+)\.?\s+(\d{1,2}):(\d{2})/i.exec(raw);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS[m[2]!.toLowerCase()];
  if (month == null) return null;
  const hh = Number(m[3]), mi = Number(m[4]);
  let year = now.getUTCFullYear();
  const offset = month >= 3 && month <= 9 ? 2 : 1; // DST-approx CEST/CET
  let ms = Date.UTC(year, month, day, hh, mi) - offset * 3600_000;
  if (ms < now.getTime() - 86_400_000) ms = Date.UTC(++year, month, day, hh, mi) - offset * 3600_000;
  return new Date(ms).toISOString();
}

/** Tumnagel → full bild som RELATIV sökväg (husets baseUrl sätts i mappen). Strippar tn/small. */
export function fullImage(src: string): string {
  const path = src.replace(/^https?:\/\/[^/]+/, "");
  return path.replace(/\/tn\/small(?=\d)/, "/").replace(/\/tn\/(?=\w)/, "/");
}

export interface GakItem {
  id: string;
  slug: string;
  title: string;
  endText: string | null;
  endsAt: string | null;
  currentBid: number | null;
  image: string | null;
}

function decode(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

function kr(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Ren parser: objektöversiktens HTML → kort (per `data-item-id`). */
export function parseList(html: string, now = new Date()): GakItem[] {
  const out: GakItem[] = [];
  const parts = html.split(/<div class="item" data-item-id="/).slice(1);
  for (const p of parts) {
    const id = (/^(\d+)"/.exec(p) ?? [])[1];
    if (!id) continue;
    // Slug kan innehålla å/ä/ö (oencodade i SSR-URL:en).
    const linkM = new RegExp(`/auktion/objekt/([a-z0-9åäö-]+)/${id}`, "i").exec(p);
    const slug = linkM?.[1] ?? "";
    // Titel: <meta name="title" content="1. Liggfåtölj, ..."> (lot-prefix strippas).
    const titleM = /<meta\s+name="title"\s+content="([^"]*)"/i.exec(p);
    const title = decode(titleM?.[1] ?? slug.replace(/-/g, " ")).replace(/^\d+\.\s*/, "");
    // Sluttid ligger i en NÄSTLAD span inuti timeWrapper.
    const endText =
      (/class="timeWrapper[^"]*"[^>]*>(?:\s*<span[^>]*>)?\s*([^<]+)/i.exec(p) ?? [])[1]?.trim() ?? null;
    const bidM = /class="itemCurrentBid[^"]*"[^>]*>\s*([\d\s]+kr)/i.exec(p);
    const imgM = /data-src="([^"]+\.(?:jpg|jpeg|png|webp))"/i.exec(p);
    out.push({
      id,
      slug,
      title,
      endText,
      endsAt: parseSwedishMonthDate(endText, now),
      currentBid: kr(bidM?.[1]),
      image: imgM ? fullImage(imgM[1]!) : null,
    });
  }
  return out;
}

/** Köparavgifter ur detaljsidans priceInfo-div (per objekt; procent/kr INKL moms). */
export interface GakFee {
  purchaseFeePct: number; // data-purchase-fee, t.ex. 20
  auctionFeeKr: number; // data-auction-fee (slagavgift), t.ex. 50
  itemVatRate: number; // data-item-vat, t.ex. 0.00/0.25 (moms på budet)
}

export interface GakDetail {
  description: string | null;
  fee: GakFee | null;
}

/** Ren parser: detaljsidans HTML → beskrivning + avgiftsattribut. */
export function parseDetail(html: string): GakDetail {
  const m = /class="[^"]*itemDescription[^"]*"[^>]*>([\s\S]{10,1500}?)<\/div>/i.exec(html);
  const div = /<div class="priceInfo[^"]*"[^>]*>/i.exec(html)?.[0] ?? "";
  const attr = (name: string): number | null => {
    const a = new RegExp(`data-${name}="([\\d.]+)"`, "i").exec(div);
    return a ? Number(a[1]) : null;
  };
  const pf = attr("purchase-fee");
  const af = attr("auction-fee");
  const iv = attr("item-vat");
  const fee =
    pf != null && Number.isFinite(pf)
      ? { purchaseFeePct: pf, auctionFeeKr: af ?? 0, itemVatRate: iv ?? 0 }
      : null;
  return { description: m ? decode(m[1]!) || null : null, fee };
}

export class GakClient {
  constructor(private readonly baseUrl: string) {}

  private async get(path: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`GAK HTTP ${res.status} ${path}`);
    return res.text();
  }

  /** En sida ur objektöversikten (44/sida). ended → showEnded=yes (för historik). */
  async fetchPage(page: number, ended = false): Promise<GakItem[]> {
    const showEnded = ended ? "yes" : "no";
    return parseList(
      await this.get(`/auktion/objekt-översikt?sorting=byTime&direction=asc&showEnded=${showEnded}&page=${page}`),
    );
  }

  async fetchDetail(slug: string, id: string): Promise<GakDetail | null> {
    try {
      return parseDetail(await this.get(`/auktion/objekt/${slug}/${id}`));
    } catch {
      return null;
    }
  }
}
