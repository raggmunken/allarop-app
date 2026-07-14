/**
 * Normalisering: PS Auction-kort (+ live + detalj) → projektets domäntyper.
 * PS Auction är ETT hus (seller = "PS Auction"); varje objekt en auktion.
 * Avgift = percentage-läge (serviceavgift 16 % + 25 % moms på avgiften) med
 * objektsmoms per objekt (NormalizedItem.vatRate) - samma struktur som BNA.
 */

import {
  NormalizedAuction,
  NormalizedBid,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { PSDetail, PSItem, PSLive } from "./client.ts";

export const HOUSE = "psauction";
const ORIGIN = "https://psauction.se";

/**
 * "2026-06-28 14:00" (svensk lokaltid) → UTC-ISO. DST-approx: apr-okt = CEST
 * (UTC+2), annars CET (UTC+1). Tål även sekunder.
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

export function mapAuction(it: PSItem, detail: PSDetail | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.itemId,
    title: it.title || `PS Auction ${it.itemId}`,
    description: detail?.description ?? null,
    sourceUrl: `${ORIGIN}${it.href}`,
  };
}

function mapMedia(it: PSItem, detail: PSDetail | null): NormalizedMedia[] {
  const urls = detail?.images?.length ? detail.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(
  it: PSItem,
  detail: PSDetail | null,
  live: PSLive | null = null,
  now = new Date(),
): NormalizedItem {
  const endsAt = parseExactEnd(live?.endText ?? it.endText);
  const cancelled = live?.cancelled ?? false;
  const endedByTime = endsAt != null && new Date(endsAt).getTime() <= now.getTime();
  const active = live ? live.active && !cancelled : !it.ended && !endedByTime;
  return {
    house: HOUSE,
    externalId: it.itemId,
    partExternalId: it.itemId,
    auctionExternalId: it.itemId,
    title: it.title,
    description: detail?.description ?? null,
    location: it.location,
    status: active ? "active" : "ended",
    endsAt,
    minBid: live?.nextMinBid ?? null,
    currentBid: live?.currentBid ?? it.currentBid,
    bidCount: live ? live.bids.length : null,
    // Reservpris-status (PS Auction visar bara status, ej värdet). Live-JSON:en skiljer
    // INTE "inget reservpris" från "ej uppnått" (båda ger reservationPriceReached=false).
    // Kortet gör det: den gröna klassen reserveprice-reached sätts vid BÅDE "uppnått"
    // OCH "inget reservpris". Kombinera (verifierat mot riktig data 2026-07-07):
    //   live uppnått             → met
    //   live ej + kort grönt     → none     (inget reservpris)
    //   live ej + kort ej grönt  → not_met
    reserveStatus: live
      ? (live.reservationReached ? "met" : it.reservationReached ? "none" : "not_met")
      : null,
    // Objektsmoms per objekt (25/0) ur live-data; default 25 % tills berikat.
    feeValue: null, // percentage-läge → ingen per-objekt-avgift i kr
    vatRate: live?.vatRate ?? 25,
    currency: live?.currency ?? "SEK",
    seller: "PS Auction",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: `${ORIGIN}${it.href}`,
    raw: { item: it, live, detail } as unknown as RawPayload,
  };
}

/** Budhistorik (PS Auction visar riktiga användarnamn + id) → NormalizedBid[]. */
export function mapBids(it: PSItem, live: PSLive | null): NormalizedBid[] {
  if (!live) return [];
  return live.bids.map((b) => ({
    house: HOUSE,
    // Inget bud-id i API:t → syntetisera stabilt id (objekt + tid + belopp).
    externalId: `${it.itemId}:${b.date}:${b.value}`,
    itemExternalId: it.itemId,
    value: b.value,
    type: null,
    createdAt: parseExactEnd(b.date) ?? b.date,
    bidderId: b.bidderId,
    bidderName: b.bidderName,
    raw: b as unknown as RawPayload,
  }));
}
