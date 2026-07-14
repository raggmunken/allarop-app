/**
 * Normalisering: Vaxxa-Typesense-träff → domäntyper. AVGIFTER: serviceavgiften (exkl moms)
 * hämtas per (objekt, aktuellt bud) via getProductFeeAction → feeValue; +25 % moms på
 * avgiften läggs av avgiftsmotorn (feeVatRate 25). Budets moms styrs av objektsidans
 * is_taxable (1 → vatRate 25, 0 → momsfri). Utan hämtad avgift → external-fallback
 * ("serviceavgift + moms tillkommer", ingen fejkad total). Reservstatus fås direkt
 * (is_reserve_met → met/not_met) och driver reserv-pillen. Budgivare anonyma → inga bud-rader.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { VaxxaItem, sourceUrl } from "./client.ts";

export const HOUSE = "vaxxa";

function mapMedia(it: VaxxaItem): NormalizedMedia[] {
  // Berikat galleri (objektsidan, s=full) om det finns; annars Typesense-thumbnail.
  const urls = it.images.length ? it.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapAuction(it: VaxxaItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.externalId,
    title: it.title,
    description: it.description,
    sourceUrl: sourceUrl(it.externalId),
  };
}

export function mapItem(it: VaxxaItem, now = new Date()): NormalizedItem {
  const endedByTime = it.endsAt != null && new Date(it.endsAt).getTime() <= now.getTime();
  return {
    house: HOUSE,
    externalId: it.externalId,
    partExternalId: it.externalId,
    auctionExternalId: it.externalId,
    title: it.title,
    description: it.description,
    location: it.location,
    status: endedByTime ? "ended" : "active",
    endsAt: it.endsAt,
    // Auktioner har INGET utrop hos Vaxxa (budgivning från 0 - verifierat 2026-07-06);
    // köp nu-objekt (BUY_NOW) bär sitt pris i price → visas som minBid + driver totalen.
    minBid: it.buyNowPrice,
    currentBid: it.currentBid,
    bidCount: it.bidCount,
    // Reservstatus direkt ur indexet (driver reserv-pillen som Junora).
    reserveStatus: it.reserveMet ? "met" : "not_met",
    // Serviceavgift (exkl moms; motorn lägger +25 % via feeVatRate) för bud/köp nu-pris,
    // eller minimiavgiften fee(0) för budlösa auktioner (Vaxxa visar den så på objektsidan).
    // Kräver KÄND momsstatus - annars skulle totalen sakna budmoms → external tills båda finns.
    feeValue: it.isTaxable != null ? it.feeExVat : null,
    // Budets moms ur is_taxable; null = okänd än (external-fallback tills avgift+moms finns).
    vatRate: it.isTaxable == null ? null : it.isTaxable ? 25 : 0,
    currency: "SEK",
    seller: "Vaxxa",
    listedAt: null,
    media: mapMedia(it),
    sourceUrl: sourceUrl(it.externalId),
    raw: { item: it } as unknown as RawPayload,
  };
}
