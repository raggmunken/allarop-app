/**
 * Sikö Auktioner (sikoauktioner.se) - traditionellt konst-/kvalitetsauktionshus, timade
 * online-auktioner där lotter stänger STAGGRAT (en/minut). INGET list-/sök-API: sajten
 * renderar bara de 24 närmast stängande (SSR). Full täckning via ID-ENUMERERING - obj-id
 * är sekventiella (~884xxx) och live-endpointen batch-probar godtyckliga id:
 *   GET backup.sikoauktioner.se/auktion_refresh_multi.php?obj_id_arr[]=ID&... → [{obj_id,
 *   seconds_remaining(>0=aktiv), winner_bid(=aktuellt bud)}]. Tomt svar = bortom id-rymden.
 * Statisk data (titel/utrop/bild/beskrivning) ur SSR-detaljsidan /auktion/{id}. Ren HTTP.
 * Avgift = 18 % provision + 28 kr slagavgift (ur detalj-JS: provisionKop/slagavgiftKop).
 */

const WWW = "https://www.sikoauktioner.se";
const LIVE = "https://backup.sikoauktioner.se/auktion_refresh_multi.php";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/** Bild: siko-im{size}.fra1.cdn.digitaloceanspaces.com/00{paddedId}_{n}.jpg (size 920=full). */
export function imageUrl(id: number, n = 1, size = 920): string {
  return `https://siko-im${size}.fra1.cdn.digitaloceanspaces.com/${String(id).padStart(8, "0")}_${n}.jpg`;
}

export interface SikoLive {
  id: number;
  bid: number | null; // winner_bid = aktuellt bud
  secondsRemaining: number; // >0 aktiv, <=0 avslutad
}

export interface SikoDetail {
  title: string | null;
  endsAt: string | null; // ISO ur data-stopsec (unix)
  valuation: number | null; // Värdering (uppskattning)
  images: string[];
  description: string | null;
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Siko HTTP ${res.status} ${url}`);
  return res.text();
}

/** Batch-proba en lista id mot live-endpointen → live-läge per id (tomt = bortom rymden). */
export async function probe(ids: number[]): Promise<SikoLive[]> {
  if (ids.length === 0) return [];
  const qs = ids.map((i) => `obj_id_arr[]=${i}`).join("&");
  const res = await fetch(`${LIVE}?${qs}`, { headers: { "User-Agent": UA } });
  if (!res.ok) return [];
  try {
    const arr = JSON.parse(await res.text()) as Record<string, unknown>[];
    return arr.map((o) => ({
      id: Number(o.obj_id),
      bid: o.winner_bid != null ? Number(o.winner_bid) : null,
      secondsRemaining: Number(o.seconds_remaining ?? 0),
    }));
  } catch {
    return [];
  }
}

/** Avkoda HTML-entiteter + strip taggar i en textsnutt. */
function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#?\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "2026-07-03 19:14:00" (svensk lokaltid) → UTC-ISO (apr-okt CEST +2, annars CET +1). */
export function swedishToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const month = Number(mo) - 1;
  const offset = month >= 3 && month <= 9 ? 2 : 1;
  const ms = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mi), Number(ss ?? 0)) - offset * 3600_000;
  return new Date(ms).toISOString();
}

/** Ren parser: SSR-detaljsidans HTML → titel/sluttid/utrop/bilder/beskrivning. */
export function parseDetail(html: string, id: number): SikoDetail {
  const titleRaw = (/<title>([^<]*?)(?:\s*-\s*Sik[öo] Auktioner)?<\/title>/i.exec(html) ?? [])[1];
  const stop = (/class="[^"]*countdown[^"]*"[^>]*title="([^"]*)"/i.exec(html) ?? [])[1];
  const valM = /(?:Värdering|Utrop)[^0-9]{0,12}([\d\s]+)\s*kr/i.exec(html);
  const valuation = valM?.[1] ? Number(valM[1].replace(/\s/g, "")) : null;
  // Bilder: alla siko-im{N}/00{id}_{k}.jpg → distinkta _k, fullstorlek (im920).
  const ns = new Set<number>();
  for (const m of html.matchAll(new RegExp(`/0*${id}_(\\d+)\\.jpg`, "gi"))) ns.add(Number(m[1]));
  const images = [...ns].sort((a, b) => a - b).map((n) => imageUrl(id, n));
  // Beskrivning: första rimliga <p> som inte är juridik/avgift/cookie.
  let description: string | null = null;
  for (const m of html.matchAll(/<p[^>]*>([\s\S]{15,400}?)<\/p>/gi)) {
    const t = clean(m[1] ?? "");
    if (t.length >= 15 && !/cookie|villkor|provision|slagavgift|inloggad|samtycke/i.test(t)) {
      description = t;
      break;
    }
  }
  return {
    title: titleRaw ? clean(titleRaw) : null,
    endsAt: swedishToIso(stop),
    valuation: valuation != null && Number.isFinite(valuation) ? valuation : null,
    images: images.length ? images : [imageUrl(id, 1)],
    description,
  };
}

export class SikoClient {
  /** Seed: de närmast stängande objektens id ur /alla-auktioner (lägsta aktiva id). */
  async seedIds(): Promise<number[]> {
    const html = await getText(`${WWW}/alla-auktioner`);
    return [...new Set([...html.matchAll(/data-objid="(\d+)"/g)].map((m) => Number(m[1])))];
  }

  /**
   * Upptäck ALLA aktiva objekt: proba id uppåt från seed-min i satser tills ett helt
   * batch ger tomt (bortom id-rymden). Returnerar aktiva (seconds_remaining>0) med bud.
   */
  async discoverActive(opts: { batch?: number; maxSpan?: number } = {}): Promise<SikoLive[]> {
    const batch = opts.batch ?? 50; // större batch → URL för lång (414) → tomt svar
    const maxSpan = opts.maxSpan ?? 6000; // skydd (~veckors horisont)
    const seeds = await this.seedIds();
    if (seeds.length === 0) return [];
    const start = Math.min(...seeds) - 50; // lite nedanför för precis-stängande
    const active: SikoLive[] = [];
    let emptyStreak = 0;
    for (let from = start; from < start + maxSpan; from += batch) {
      const ids = Array.from({ length: batch }, (_, k) => from + k);
      const res = await probe(ids);
      if (res.length === 0) {
        if (++emptyStreak >= 2) break; // två tomma satser i rad → slut på id-rymden
        continue;
      }
      emptyStreak = 0;
      for (const r of res) if (r.secondsRemaining > 0 && r.id > 0) active.push(r);
    }
    return active;
  }

  /** Statisk detalj för ETT objekt (titel/utrop/bilder/beskrivning) ur SSR-sidan. */
  async fetchDetail(id: number): Promise<SikoDetail | null> {
    try {
      return parseDetail(await getText(`${WWW}/auktion/${id}`), id);
    } catch {
      return null;
    }
  }
}
