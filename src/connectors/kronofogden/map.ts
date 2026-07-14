/**
 * Normalisering: Kronofogden-objekt (renderad lista + statisk detalj) → domäntyper.
 * Kronofogden (Sveriges exekutiva myndighet) säljer utmätt/beslagtaget gods. ETT hus
 * (seller = "Kronofogden"); varje objekt en egen auktion. **Inga köparavgifter**
 * ("Inga avgifter tillkommer") → source-läge med feeValue 0 + vatRate 0 → total = bud.
 * Budgivare visas anonymt (bara "Högsta bud") → inga bud-rader.
 */

import {
  NormalizedAuction,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { KronofogdenDetail, KronofogdenItem } from "./client.ts";

export const HOUSE = "kronofogden";
const ORIGIN = "https://auktion.kronofogden.se";

const sourceUrl = (it: KronofogdenItem) =>
  `${ORIGIN}/auk/w.object?inC=KFM&inA=${it.inA}&inO=${it.inO}`;

export function mapAuction(
  it: KronofogdenItem,
  detail: KronofogdenDetail | null = null,
): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.objId,
    title: it.title || `Kronofogden ${it.objId}`,
    description: detail?.description ?? null,
    sourceUrl: sourceUrl(it),
  };
}

function mapMedia(it: KronofogdenItem, detail: KronofogdenDetail | null): NormalizedMedia[] {
  const urls = detail?.images?.length ? detail.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(
  it: KronofogdenItem,
  detail: KronofogdenDetail | null = null,
  now = new Date(),
): NormalizedItem {
  const endedByTime = it.endsAt != null && new Date(it.endsAt).getTime() <= now.getTime();
  return {
    house: HOUSE,
    externalId: it.objId,
    partExternalId: it.objId,
    auctionExternalId: it.inA, // auktionsbatchen objektet tillhör
    title: it.title,
    description: detail?.description ?? null,
    location: it.location,
    status: endedByTime ? "ended" : "active",
    endsAt: it.endsAt,
    // Startpris = lägsta bud (visas tills någon budat); currentBid = Högsta bud.
    minBid: it.startBid,
    currentBid: it.currentBid,
    bidCount: null, // budgivare anonyma → ingen budhistorik
    // Inga köparavgifter → source-läge, total = bud (feeValue 0, vatRate 0).
    feeValue: 0,
    vatRate: 0,
    currency: "SEK",
    seller: "Kronofogden",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: sourceUrl(it),
    raw: { item: it, detail } as unknown as RawPayload,
  };
}
