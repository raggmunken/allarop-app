/**
 * Normalisering: BNA-objekt (objektsida) → projektets domäntyper.
 * BNA är ETT hus (seller = "BNA"); auktionseventet (konkurs/dödsbo) grupperar
 * objekten. Budgivare visas utan identitet → inga bud-rader.
 */

import {
  NormalizedAuction,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { BnaDetail, BnaEvent } from "./client.ts";

export const HOUSE = "bna";
const ORIGIN = "https://bna.nu";

/** Snygga till eventtiteln: ta bort inledande datum, versalisera. */
function cleanTitle(t: string): string {
  const noDate = t.replace(/^\d{4}\s\d{2}\s\d{2}\s*/, "").trim();
  return noDate ? noDate.charAt(0).toUpperCase() + noDate.slice(1) : t;
}

export function mapAuction(ev: BnaEvent): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: ev.id,
    title: cleanTitle(ev.title),
    description: null,
    sourceUrl: `${ORIGIN}${ev.href}`,
  };
}

function mapImages(d: BnaDetail): NormalizedMedia[] {
  return d.images.map((url, i) => ({ kind: "image" as const, url, sort: i + 1 }));
}

export function mapItem(d: BnaDetail, eventId: string): NormalizedItem {
  const live = d.endsAt == null || new Date(d.endsAt).getTime() > Date.now();
  return {
    house: HOUSE,
    externalId: d.itemId,
    partExternalId: eventId,
    auctionExternalId: eventId,
    title: d.title,
    description: null,
    location: d.location,
    status: live ? "active" : "ended",
    endsAt: d.endsAt,
    minBid: d.minBid,
    currentBid: d.currentBid,
    bidCount: null,
    feeValue: null, // procentmodell (12 % + 25 % momsavgift) i fees/rules.ts
    // Objektsmoms per objekt: 25 % konkursvara, 0 % momsfritt (fordon m.m.).
    vatRate: d.vatRate,
    currency: "SEK",
    seller: "BNA",
    listedAt: null,
    media: mapImages(d),
    sourceUrl: `${ORIGIN}${d.href}`,
    raw: d as unknown as RawPayload,
  };
}
