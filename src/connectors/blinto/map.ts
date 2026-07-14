/**
 * Normalisering: Blinto-objekt (startsidans kort + objektsidans detalj) →
 * projektets domäntyper. Blinto är ETT hus (seller = "Blinto"); varje auktion är
 * ett objekt. Slagavgift per objekt → source-läge (som Tovek/Fabeo).
 */

import {
  NormalizedAuction,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { BlintoDetail, BlintoItem } from "./client.ts";

export const HOUSE = "blinto";
const ORIGIN = "https://www.blinto.se";

const SV_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, maj: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, okt: 9, nov: 10, dec: 11,
};

/**
 * "29 jun 09:59" (svensk lokaltid, årslöst) → UTC-ISO. Sluttider ligger i
 * framtiden → om datumet hamnar i dåtid tillhör det nästa år. DST-approx:
 * apr–okt = CEST (UTC+2), annars CET (UTC+1).
 */
export function parseSwedishEnd(text: string | null, now = new Date()): string | null {
  if (!text) return null;
  const m = /(\d{1,2})\s+([a-zåäö]{3})\s+(\d{1,2}):(\d{2})/i.exec(text);
  if (!m) return null;
  const day = Number(m[1]);
  const month = SV_MONTHS[(m[2] ?? "").toLowerCase()];
  const hh = Number(m[3]);
  const mi = Number(m[4]);
  if (month == null) return null;
  let year = now.getFullYear();
  const offset = (mo: number) => (mo >= 3 && mo <= 9 ? 2 : 1);
  const toUtc = (y: number) => Date.UTC(y, month, day, hh, mi) - offset(month) * 3600_000;
  let ms = toUtc(year);
  if (ms < now.getTime() - 86_400_000) ms = toUtc(++year); // dåtid → nästa år
  return new Date(ms).toISOString();
}

/**
 * Exakt sluttid "2026-06-30 10:10:00" (svensk lokaltid, ur 4MaxBid) → UTC-ISO.
 * DST-approx: apr-okt = CEST (UTC+2), annars CET (UTC+1).
 */
export function parseExactEnd(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss] = m;
  const month = Number(mo) - 1;
  const offset = month >= 3 && month <= 9 ? 2 : 1;
  const ms =
    Date.UTC(Number(y), month, Number(d), Number(hh), Number(mi), Number(ss ?? 0)) -
    offset * 3600_000;
  return new Date(ms).toISOString();
}

export function mapAuction(it: BlintoItem, detail: BlintoDetail | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.objId,
    title: it.title || `Blinto ${it.objId}`,
    description: detail?.description ?? null,
    sourceUrl: `${ORIGIN}${it.href}`,
  };
}

function mapMedia(it: BlintoItem, detail: BlintoDetail | null): NormalizedMedia[] {
  const urls = detail?.images?.length ? detail.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(it: BlintoItem, detail: BlintoDetail | null, now = new Date()): NormalizedItem {
  // Exakt sluttid ur 4MaxBid (live) först; SSR-textens relativa tid som reserv.
  const endsAt = parseExactEnd(it.endsAtRaw) ?? parseSwedishEnd(it.endText, now);
  const live = endsAt == null || new Date(endsAt).getTime() > now.getTime();
  // Typ + märke/modell som titel (typen hjälper sök, t.ex. "grävmaskin").
  const title = it.type && !it.title.toLowerCase().startsWith(it.type.toLowerCase())
    ? `${it.type} ${it.title}`
    : it.title;
  return {
    house: HOUSE,
    externalId: it.objId,
    partExternalId: it.objId,
    auctionExternalId: it.objId,
    title,
    description: detail?.description ?? null,
    location: it.location,
    status: live ? "active" : "ended",
    endsAt,
    minBid: it.nextMinBid ?? null,
    currentBid: it.currentBid,
    bidCount: it.bidCount,
    // Slagavgift per objekt (kr, exkl moms) → source-läge; objektsmoms 25/0.
    feeValue: detail?.feeValue ?? null,
    vatRate: detail?.vatRate ?? 25,
    currency: "SEK",
    seller: "Blinto",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: `${ORIGIN}${it.href}`,
    raw: { item: it, detail } as unknown as RawPayload,
  };
}
