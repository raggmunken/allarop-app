/**
 * Normalisering: Auktiona-lott → domäntyper. Köparen betalar BUDET (moms 25 % ingår redan,
 * settings.vat.included=true) + ev. serviceavgift (settings.serviceFee, nästan alltid "none"
 * = 0). → source-läge: total = bud + serviceavgift, ingen moms adderas. currentPrice =
 * vinnande bud när currentLeader finns, annars startbud (minBid). Budgivare anonyma → inga
 * bud-rader/ledare. Hela bildgalleriet speglas.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { AuktionaItem } from "./client.ts";

export const HOUSE = "auktiona";

function mapMedia(it: AuktionaItem): NormalizedMedia[] {
  return it.images.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapAuction(it: AuktionaItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.id,
    title: it.title,
    description: it.description,
    sourceUrl: it.sourceUrl,
  };
}

export function mapItem(it: AuktionaItem, now = new Date()): NormalizedItem {
  const endedByTime = it.endsAt != null && new Date(it.endsAt).getTime() <= now.getTime();
  return {
    house: HOUSE,
    externalId: it.id,
    partExternalId: it.id,
    auctionExternalId: it.id,
    title: it.title,
    description: it.description,
    location: it.location,
    status: endedByTime ? "ended" : "active",
    endsAt: it.endsAt,
    minBid: it.minBid, // startbud när inga bud
    currentBid: it.currentBid, // null om inga bud
    bidCount: null,
    reserveStatus: null,
    feeValue: it.serviceFee, // serviceavgift i kr (oftast 0) → total = bud + serviceavgift
    vatRate: 0, // moms (25 %) ingår redan i budet (settings.vat.included) → adderas ej
    currency: "SEK",
    seller: "Auktiona",
    listedAt: null,
    media: mapMedia(it),
    sourceUrl: it.sourceUrl,
    raw: { item: it } as unknown as RawPayload,
  };
}
