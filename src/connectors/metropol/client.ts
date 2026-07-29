/**
 * Metropol Auktioner (metropol.se) - klassiskt konst-/kvalitetshus, ASP-sajt. RENT SSR,
 * ingen browser: katalogen browsas per KATEGORI och varje kategoris `product-cards.html`
 * returnerar ALLA objekt i kategorin (ingen paginering). Hela aktiva katalogen = unionen
 * av toppkategoriernas product-cards (dedupe på objekt-id). Korten bär ALLT (titel, rik
 * beskrivning, "Bjud mer än", Utrop, EXAKT sluttid `<time datetime>`, bild) → ingen detalj.
 * Köparprovisionen ej publik → external-läge. Budgivare anonyma → inga bud-rader.
 */

const BASE = "https://www.metropol.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Toppkategorier (JS-renderade i navet → fasta här; "ovrigt" fångar resten). */
const CATEGORIES = [
  "belysning", "glas-och-keramik", "konst", "mobler",
  "silver-och-metall", "ur-och-klockor", "ovrigt",
];

export interface MetropolItem {
  id: string;
  goPath: string; // /go/{a}/{id} (redirect → detail.asp)
  title: string;
  description: string | null;
  minBid: number | null; // "Bjud mer än" = lägsta giltiga bud
  estimate: number | null; // Utrop
  endsAt: string | null;
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
  const n = Number(s.replace(/[^\d]/g, "")); // "1.000 kr" → 1000
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "2026-07-13T19:30" (svensk lokaltid, ur <time datetime>) → UTC-ISO. */
export function datetimeToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh, mi] = m;
  const month = Number(mo) - 1;
  const offset = month >= 3 && month <= 9 ? 2 : 1; // DST-approx CEST/CET
  const ms = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mi)) - offset * 3600_000;
  return new Date(ms).toISOString();
}

/** Ren parser: en kategoris product-cards.html → objekt. */
export function parseCards(html: string): MetropolItem[] {
  const out: MetropolItem[] = [];
  const parts = html.split(/block-product-cards__card/).slice(1);
  for (const p of parts) {
    const go = (/href="(\/go\/\d+\/(\d+))"/.exec(p) ?? []) as RegExpExecArray | [];
    const goPath = go[1];
    const id = go[2];
    if (!id || !goPath) continue;
    const title = decode((/__name[^>]*>\s*([^<]+)/i.exec(p) ?? [])[1] ?? "");
    const description = decode((/__description[^>]*>([\s\S]*?)<\/p>/i.exec(p) ?? [])[1] ?? "") || null;
    const minBid = kr((/Bjud mer än:\s*<span>([^<]+)<\/span>/i.exec(p) ?? [])[1]);
    const estimate = kr((/Utrop:\s*<span>([^<]+)<\/span>/i.exec(p) ?? [])[1]);
    const endsAt = datetimeToIso((/<time datetime="([^"]+)"/i.exec(p) ?? [])[1]);
    const imgM = /<img\s+src="([^"]+\.(?:jpe?g|png|webp))"/i.exec(p);
    out.push({
      id,
      goPath,
      title: title || `Metropol ${id}`,
      description,
      minBid,
      estimate,
      endsAt,
      image: imgM ? imgM[1]! : null,
    });
  }
  return out;
}

async function get(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Metropol HTTP ${res.status} ${path}`);
  return res.text();
}

/** Hela galleriet ur objektsidan (detail.asp): imagebank-thumbs → medium-storlek.
 * URL:erna är antingen /imagebank/thumbs/{a}/{GUID}.jpg eller /imagebank/medium/{a}/%7BGUID%7D.jpg
 * — normalisera till medium med URL-kodad GUID, dedup på GUID, ordning bevarad. */
export function parseGallery(html: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of html.matchAll(/imagebank\/(?:thumbs|medium|large)\/\d+\/([^"'\s]+?\.(?:jpe?g|png|webp))/gi)) {
    const guid = m[1]!
      .replace(/\.(jpe?g|png|webp)$/i, "")
      .replace(/%7B|{|%7D|}/gi, "")
      .toUpperCase();
    if (!guid || seen.has(guid)) continue;
    seen.add(guid);
    const sub = /imagebank\/(?:thumbs|medium|large)\/(\d+)\//i.exec(m[0])?.[1] ?? "1001";
    out.push(`${BASE}/imagebank/medium/${sub}/%7B${guid}%7D.jpg`);
  }
  return out;
}

export class MetropolClient {
  /** Hela aktiva katalogen: unionen av toppkategoriernas product-cards (dedupe på id). */
  async fetchAll(): Promise<MetropolItem[]> {
    const byId = new Map<string, MetropolItem>();
    for (const cat of CATEGORIES) {
      try {
        const items = parseCards(await get(`/sv-SE/auktioner/categories/${cat}/product-cards.html`));
        for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
      } catch {
        /* hoppa trasig kategori */
      }
    }
    return [...byId.values()];
  }

  /** Objektsidan (/go/{a}/{id} → detail.asp) EN gång per objekt → galleriet. */
  async fetchDetail(goPath: string): Promise<{ images: string[] } | null> {
    try {
      return { images: parseGallery(await get(goPath)) };
    } catch {
      return null;
    }
  }
}
