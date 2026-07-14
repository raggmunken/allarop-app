/**
 * Normalisering: Netauktion (kort + batch-status + detalj) → projektets domäntyper.
 * Live-bud/total/ledare/sluttid kommer ur det LÄTTVIKTIGA batch-API:t
 * (update_auction_status); beskrivning + galleri ur objektsidan (en gång).
 * Avgift = percentage-läge (slagavgift 12 % + 25 % moms, golv 100/tak 50000).
 * Objektsmoms (0/25 %) HÄRLEDS ur API:ts exakta total så computeTotal blir exakt.
 */

import {
  NormalizedAuction,
  NormalizedBid,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { NetauktionDetail, NetauktionItem, NetauktionStatus } from "./client.ts";

export const HOUSE = "netauktion";
const ORIGIN = "https://www.netauktion.se";

const sourceUrl = (it: NetauktionItem) => `${ORIGIN}/auktion/${it.slug}?product=${it.productId}`;

/** Slagavgift (samma som rules.ts) - för att härleda objektsmomsen ur exakt total. */
function feeKr(bid: number): number {
  return Math.min(Math.max(bid * 0.12, 100), 50000);
}

/**
 * Objektsmoms (0/25 %) härledd ur API:ts EXAKTA total (top_bid_with_fee_and_tax):
 * total = bud + slagavgift + 25 % moms på avgiften + objektsmoms på budet. Det som
 * blir över efter bud+avgift+avgiftsmoms är objektsmomsen → 25 % eller 0 (momsfri/VMB).
 */
export function deriveVatRate(bid: number | null, total: number | null): number {
  if (bid == null || total == null || bid <= 0) return 25; // default tills bud finns
  const fee = feeKr(bid);
  const objVat = total - bid - fee - fee * 0.25;
  return objVat > bid * 0.05 ? 25 : 0;
}

/**
 * "2026-06-28 19:35:00" (svensk lokaltid) → UTC-ISO. DST-approx: apr-okt = CEST
 * (UTC+2), annars CET (UTC+1).
 */
export function parseSwedishEnd(raw: string | null | undefined): string | null {
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

export function mapAuction(it: NetauktionItem, detail: NetauktionDetail | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.productId,
    title: it.title || `Netauktion ${it.productId}`,
    description: detail?.description ?? null,
    sourceUrl: sourceUrl(it),
  };
}

function mapMedia(it: NetauktionItem, detail: NetauktionDetail | null): NormalizedMedia[] {
  const urls = detail?.images?.length ? detail.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(
  it: NetauktionItem,
  status: NetauktionStatus | null = null,
  detail: NetauktionDetail | null = null,
  now = new Date(),
): NormalizedItem {
  // Sluttid: API:ts expiration_datetime (auktoritativ) först, annars kortets.
  const endsAt = parseSwedishEnd(status?.endText ?? it.endText);
  const endedByTime = endsAt != null && new Date(endsAt).getTime() <= now.getTime();
  const active = status ? status.active && !endedByTime : !endedByTime;
  const bid = status?.currentBid ?? null;
  return {
    house: HOUSE,
    externalId: it.productId,
    partExternalId: it.productId,
    auctionExternalId: it.productId,
    title: it.title,
    description: detail?.description ?? null,
    location: it.location,
    status: active ? "active" : "ended",
    endsAt,
    minBid: status?.nextBid ?? null, // startbud / lägsta giltiga bud
    currentBid: bid,
    bidCount: status ? status.bids.length : null,
    // Reservpris-status (Netauktion visar bara status, ej värdet).
    reserveStatus: status ? (status.reserveMet ? "met" : "not_met") : null,
    feeValue: null, // percentage-läge
    vatRate: deriveVatRate(bid, status?.total ?? null),
    currency: "SEK",
    seller: "Netauktion",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: sourceUrl(it),
    raw: { item: it, status, detail } as unknown as RawPayload,
  };
}

/** Hel budhistorik (Netauktion visar budgivarnamn) → NormalizedBid[]. */
export function mapBids(it: NetauktionItem, status: NetauktionStatus | null): NormalizedBid[] {
  if (!status) return [];
  return status.bids.map((b) => ({
    house: HOUSE,
    externalId: `${it.productId}:${b.date ?? ""}:${b.value}`,
    itemExternalId: it.productId,
    value: b.value,
    type: b.autobid ? "auto" : "normal",
    createdAt: parseSwedishEnd(b.date) ?? new Date().toISOString(),
    bidderId: b.bidderId,
    bidderName: b.bidderName,
    raw: b as unknown as RawPayload,
  }));
}
