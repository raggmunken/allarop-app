/**
 * Normalisering: Frivio-fordon (list + detalj) → projektets domäntyper. Avgift =
 * percentage-läge (slagavgift 5 % + 25 % moms PÅ avgiften, som Netauktion/PS) med
 * objektsmoms per objekt: privatperson → 0 (momsfri/VMB, vanligast), företag → 25.
 * Säljartypen kommer ur detaljens `foretag`. Budgivare anonyma (userId) → inga bud-rader.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { FrivioDetail, FrivioVehicle } from "./client.ts";

export const HOUSE = "frivio";
const SITE = "https://frivio.se";

const sourceUrl = (v: FrivioVehicle) => `${SITE}/auktion/${v.id}`;

/** "Hobby" + "560 LU Exellent" → "Hobby 560 LU Exellent" (märket först om det saknas i titeln). */
function fullTitle(v: FrivioVehicle): string {
  if (v.brand && !v.title.toLowerCase().includes(v.brand.toLowerCase())) {
    return `${v.brand} ${v.title}`.trim();
  }
  return v.title;
}

export function mapAuction(v: FrivioVehicle, detail: FrivioDetail | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(v.id),
    title: fullTitle(v),
    description: detail?.description ?? null,
    sourceUrl: sourceUrl(v),
  };
}

function mapMedia(v: FrivioVehicle): NormalizedMedia[] {
  return v.images.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(
  v: FrivioVehicle,
  detail: FrivioDetail | null = null,
  now = new Date(),
): NormalizedItem {
  const endedByTime = v.auctionEnd != null && new Date(v.auctionEnd).getTime() <= now.getTime();
  const active = v.active && !v.ended && !endedByTime;
  const bid = v.currentPrice;
  return {
    house: HOUSE,
    externalId: String(v.id),
    partExternalId: String(v.id),
    auctionExternalId: String(v.id),
    title: fullTitle(v),
    description: detail?.description ?? null,
    location: v.city ?? v.region,
    status: active ? "active" : "ended",
    endsAt: v.auctionEnd,
    minBid: v.startingPrice, // utrop/startbud
    currentBid: bid != null && bid > 0 ? bid : null,
    bidCount: detail?.bidCount ?? v.bidCount,
    reserveStatus: null, // Frivio exponerar ingen reservpris-status (reservations_pris alltid false)
    feeValue: null, // percentage-läge
    // Objektsmoms: företag 25 / privatperson 0 (default 0 tills detalj berikat - majoriteten privat).
    vatRate: detail ? (detail.isCompany ? 25 : 0) : 0,
    currency: "SEK",
    seller: "Frivio",
    listedAt: null,
    media: mapMedia(v),
    sourceUrl: sourceUrl(v),
    raw: { vehicle: v, detail } as unknown as RawPayload,
  };
}
