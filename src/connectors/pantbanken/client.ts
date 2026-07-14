/**
 * Pantbanken Sverige (pantbanken.se) - pantauktioner: klockor, smycken, guld, design.
 * RENT SSR (Concrete-CMS), ingen browser: /auktioner/?offset=N&length=M listar objekten
 * (length upp till 500 → hela aktiva katalogen ~4700 i ~10 sidor). Korten bär ALLT server-
 * side: titel, bild, EXAKT sluttid (`.stanger` = "YYYY-MM-DD HH:MM:SS" svensk lokaltid,
 * JS gör om den till nedräkning i browsern), aktuellt bud, budledarens alias + antal bud.
 * Objekt-id = f_id. Detalj: /auktioner/visa-auktionsvara/?f_id=X (behövs ej - korten räcker).
 * Köparprovision = 15 % på antaget bud (inkl moms) → total = bud * 1,15.
 */

const BASE = "https://www.pantbanken.se";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

export interface PantItem {
  id: string; // f_id
  title: string;
  image: string | null;
  auctionNumber: string | null; // "SE27.20260701.A4976" (prefix = säljande kontor)
  /** Vinnande bud i kr, eller null om inga bud lagts än. */
  currentBid: number | null;
  /** Lägsta giltiga bud: utropspris (inga bud) resp. nästa krav = bud+höjning (har bud). */
  minBid: number | null;
  /** Antal bud (0 om inga). */
  bidCount: number;
  /** Budledarens alias, eller null om inga bud. Pantbanken exponerar aliaset (ej id). */
  leaderName: string | null;
  endsAt: string | null; // ISO UTC
}

/** Avkoda de fåtaliga HTML-entiteter som kan förekomma; rå-HTML är annars UTF-8. */
function decode(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
    .replace(/&aring;/g, "å").replace(/&auml;/g, "ä").replace(/&ouml;/g, "ö")
    .replace(/&Aring;/g, "Å").replace(/&Auml;/g, "Ä").replace(/&Ouml;/g, "Ö")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** "25 000 kr" / "1&nbsp;300 kr" → 25000 / 1300. Null om inget tal. */
function kr(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[^\d]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "2026-07-01 16:02:30" (svensk lokaltid, ur `.stanger`) → UTC-ISO. */
export function datetimeToIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const month = Number(mo) - 1;
  const offset = month >= 3 && month <= 9 ? 2 : 1; // DST-approx CEST(+2)/CET(+1)
  const ms = Date.UTC(Number(y), month, Number(d), Number(hh), Number(mi), ss ? Number(ss) : 0) - offset * 3600_000;
  return new Date(ms).toISOString();
}

/** Ren parser: en listsidas HTML → objekt + totalt antal träffar. */
export function parseListing(html: string): { items: PantItem[]; total: number } {
  const total = (() => {
    const m = /Träffar:\s*<\/strong>\s*([\d   ]+)/.exec(html);
    return m ? Number(m[1]!.replace(/[^\d]/g, "")) || 0 : 0;
  })();

  const items: PantItem[] = [];
  const blocks = html.split(/(?=<div class="varubild">)/).slice(1);
  for (const b of blocks) {
    const id = (/f_id=(\d+)/.exec(b) ?? [])[1];
    if (!id) continue;
    const imgM = /<img\s+src="([^"]*imagehandler[^"]+)"/i.exec(b);
    const title =
      decode((/<h5><a class="vara"[^>]*>([\s\S]*?)<\/a>/i.exec(b) ?? [])[1] ?? "") ||
      decode((/alt="([^"]+)"/i.exec(b) ?? [])[1] ?? "") ||
      `Pantbanken ${id}`;
    const auctionNumber = decode((/auktionsnummer">Auktionsnummer:\s*([^<]+)/i.exec(b) ?? [])[1] ?? "") || null;
    const budValue = kr((/aktuellt_bud current-bid">([^<]+)/i.exec(b) ?? [])[1]);
    const startBud = kr((/name="start_bud"[^>]*value="(\d+)"/i.exec(b) ?? [])[1]);
    const leaderRaw = ((/bid-leader">([^<]*)/i.exec(b) ?? [])[1] ?? "").trim();
    const nbidsRaw = ((/num-bids">([^<]*)/i.exec(b) ?? [])[1] ?? "").trim();
    const endsAt = datetimeToIso((/class="stanger">([^<]+)/i.exec(b) ?? [])[1]);

    const hasBids = leaderRaw !== "" && leaderRaw !== "-";
    const bidCount = hasBids ? Number(nbidsRaw.replace(/[^\d]/g, "")) || 1 : 0;

    items.push({
      id,
      title,
      image: imgM ? imgM[1]! : null,
      auctionNumber,
      // Har bud: visat bud = vinnande bud, start_bud = nästa krav. Inga bud: visat = utrop = start_bud.
      currentBid: hasBids ? budValue : null,
      minBid: hasBids ? startBud : budValue,
      bidCount,
      leaderName: hasBids ? leaderRaw : null,
      endsAt,
    });
  }
  return { items, total };
}

/**
 * Objektsidans "Objektinformation"-tabell (varuinfotabell) → beskrivningstext.
 * Pris-/tidsrader (Utropspris/Aktuellt bud/Stänger/Provision) hoppas över - de är
 * redan strukturerade fält; kvar blir Auktnr, Varukategori, Kontor, Auktionstyp, Frakt.
 */
export function parseItemInfo(html: string): string | null {
  const SKIP = /utropspris|aktuellt bud|stänger|provision/i;
  const rows: string[] = [];
  for (const m of html.matchAll(/class="varurubrik">([^<]+)<\/td>\s*<td class="varuvarde">([^<]*)</gi)) {
    const k = decode(m[1]!).trim();
    const v = decode(m[2]!).trim();
    if (k && v && !SKIP.test(k)) rows.push(`${k}: ${v}`);
  }
  return rows.length ? rows.join("\n") : null;
}

async function get(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Pantbanken HTTP ${res.status} ${path}`);
  return res.text();
}

export class PantbankenClient {
  /** En listsida: objekt + totalt antal (offset/length-paginering, length ≤ 500). */
  async fetchListing(page: number, perPage: number): Promise<{ items: PantItem[]; total: number }> {
    const length = Math.min(Math.max(perPage, 1), 500);
    const offset = (Math.max(page, 1) - 1) * length;
    return parseListing(await get(`/auktioner/?offset=${offset}&length=${length}`));
  }

  /** Objektsidan EN gång per objekt → Objektinformation-tabellen som beskrivning. */
  async fetchDetail(fId: string): Promise<string | null> {
    try {
      return parseItemInfo(await get(`/auktioner/visa-auktionsvara/?f_id=${fId}`));
    } catch {
      return null;
    }
  }
}
