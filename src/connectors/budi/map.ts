/**
 * Normalisering: Budi-objekt → domäntyper. AVGIFTER: serviceavgiftens parametrar (fast
 * belopp ELLER procent-med-min, exkl moms) läses ur objektsidans data-budi-servicefee-*-
 * attribut → feeValue räknas ur parametrarna för aktuellt bud (feeFor); +25 % moms på
 * avgiften läggs av motorn (feeVatRate 25). Budets moms (vatPercentage, 0=momsfri) kommer
 * ur batch-API:t. Utan parametrar/moms → external-fallback (ingen fejkad total).
 * Budgivare anonyma (B2B) → inga bud-rader/ledare.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { BudiItem, feeFor } from "./client.ts";

export const HOUSE = "budi";

function mapMedia(it: BudiItem): NormalizedMedia[] {
  // Berikat galleri (objektsidan) om det finns; annars kortets enda thumbnail.
  const urls = it.images.length ? it.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapAuction(it: BudiItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.id,
    title: it.title,
    description: it.description,
    sourceUrl: it.sourceUrl,
  };
}

export function mapItem(it: BudiItem, now = new Date()): NormalizedItem {
  const endedByTime = it.endsAt != null && new Date(it.endsAt).getTime() <= now.getTime();
  return {
    house: HOUSE,
    externalId: it.id,
    partExternalId: it.id,
    auctionExternalId: it.id,
    title: it.title,
    description: it.description,
    location: it.location,
    status: it.ended || endedByTime ? "ended" : "active",
    endsAt: it.endsAt,
    minBid: it.minBid, // startbud (visat belopp när 0 bud)
    currentBid: it.currentBid, // vinnande bud exkl moms (null om 0 bud)
    bidCount: it.bidCount,
    // Reservstatus ur batch-API:t (isReservationPriceMet) → driver reserv-pillen.
    reserveStatus: it.reserveMet == null ? null : it.reserveMet ? "met" : "not_met",
    // Serviceavgift (exkl moms) ur parametrarna för aktuellt bud. Kräver KÄND budmoms -
    // annars skulle totalen sakna den (external-fallback tills bidinfo levererat).
    feeValue: it.vatPercentage != null ? feeFor(it.feeParams, it.currentBid) : null,
    vatRate: it.vatPercentage, // moms på budet (25/0) ur batch-API:t
    currency: "SEK",
    seller: "Budi Auktioner",
    listedAt: null,
    media: mapMedia(it),
    sourceUrl: it.sourceUrl,
    raw: { item: it } as unknown as RawPayload,
  };
}
