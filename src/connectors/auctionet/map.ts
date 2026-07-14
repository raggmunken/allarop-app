/**
 * Normalisering: Auctionet-objekt → projektets domäntyper.
 * Auctionet anonymiserar budgivare (heltal, ej namn) → bidderName = null.
 */

import {
  NormalizedAuction,
  NormalizedBid,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { AuctionetBid, AuctionetItem } from "./client.ts";

export const HOUSE = "auctionet";

function unixToTs(unix?: number): string | null {
  if (!unix) return null;
  return new Date(unix * 1000).toISOString();
}

function mapImages(it: AuctionetItem): NormalizedMedia[] {
  return (it.images ?? []).map((img, i) => ({
    kind: "image" as const,
    // Föredra stor bild; fall tillbaka på mindre varianter.
    url: img.hd || img.w640 || img.mini || img.thumb || "",
    sort: i + 1,
  })).filter((m) => m.url);
}

/** Härled "auktionen" (grupperingen) — Auctionet-huset som säljare. */
export function mapAuction(it: AuctionetItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(it.auction_id),
    title: it.house ?? `Auctionet ${it.auction_id}`,
    description: null,
    sourceUrl: `https://auctionet.com/sv/auctions/${it.auction_id}`,
  };
}

export function mapItem(it: AuctionetItem, ended: boolean): NormalizedItem {
  const bids = it.bids ?? [];
  const currentBid = bids.length ? Math.max(...bids.map((b) => b.amount)) : null;
  const status = ended ? (it.hammered ? "sold" : "ended") : "active";
  const desc = [it.description, it.condition ? `Skick: ${it.condition}` : ""]
    .filter(Boolean)
    .join("\n\n");

  return {
    house: HOUSE,
    externalId: String(it.id),
    partExternalId: String(it.auction_id),
    auctionExternalId: String(it.auction_id),
    title: it.title ?? "",
    description: desc || null,
    location: it.location ?? null,
    status,
    endsAt: unixToTs(it.ends_at),
    minBid: it.starting_bid_amount ?? null,
    currentBid,
    bidCount: bids.length,
    // Reservpris-status direkt ur Auctionets eget API (speglar deras UI 1:1): reserve_met
    // true=uppnått (då avslöjas reserve_amount), false=ej uppnått (beloppet dolt). Varje
    // Auctionet-lott har reserv (inget reserve_met=true saknar bud → alltid ett kvalificerat
    // bud som nått den). Förbättrar även fynd-motorns "verifierat sålt"-gate för avslutade.
    reserveStatus: it.reserve_met == null ? null : it.reserve_met ? "met" : "not_met",
    reservePrice: it.reserve_amount ?? null,
    feeValue: null, // Auctionet: procent-avgift per hus (se fees/rules.ts)
    vatRate: null,
    currency: it.currency ?? "SEK",
    // Underliggande medlemshus (t.ex. "Crafoord Auktioner") — driver källfilter.
    seller: it.house ?? null,
    listedAt: unixToTs(it.published_at),
    media: mapImages(it),
    sourceUrl: it.url ?? `https://auctionet.com/sv/${it.id}`,
    raw: it as unknown as RawPayload,
  };
}

export function mapBid(b: AuctionetBid, itemId: number): NormalizedBid {
  return {
    house: HOUSE,
    externalId: String(b.id),
    itemExternalId: String(itemId),
    value: b.amount,
    type: b.auto ? "auto" : "normal",
    createdAt: new Date(b.timestamp * 1000).toISOString(),
    bidderId: String(b.bidder), // anonymiserat heltal
    bidderName: null, // Auctionet exponerar inga budgivarnamn
    raw: b as unknown as RawPayload,
  };
}
