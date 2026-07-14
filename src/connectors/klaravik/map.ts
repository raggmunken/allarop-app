/**
 * Normalisering: Klaravik-objekt (list-API) → projektets domäntyper.
 * Klaravik är ETT hus (seller = "Klaravik"); varje objekt är sin egen auktion.
 * Förmedlingsavgiften (auctionFee) kommer EXAKT ur API:t → source-läge i motorn.
 */

import {
  NormalizedAuction,
  NormalizedItem,
  NormalizedMedia,
  RawPayload,
} from "../types.ts";
import { fullImage, KlaravikItem } from "./client.ts";

export const HOUSE = "klaravik";

/**
 * Objektsmoms (procent) på budet. Fordon säljs oftast vinstmarginalbeskattat
 * (VMB) → 0 % tillkommande moms; maskinkategorierna är momspliktiga → 25 %.
 * Verifierat mot objektsidornas inbjäddade `vat`-fält 2026-06 (Fordon=0, Entreprenad/
 * Lantbruk/Skogsbruk/Grönyta/Liftar=25). Exakt sats hämtas för heta objekt via
 * fetchItem; detta är bulk-heuristiken.
 */
export function vatForCategory(cat: string | null | undefined): number {
  return (cat ?? "").toLowerCase() === "fordon" ? 0 : 25;
}

function mapMedia(it: KlaravikItem): NormalizedMedia[] {
  const url = fullImage(it.mainImage?.imageUrlThumb);
  return url ? [{ kind: "image", url, sort: 1 }] : [];
}

function location(it: KlaravikItem): string | null {
  const parts = [it.municipalityName, it.countyName].filter(Boolean) as string[];
  return parts.length ? parts.join(", ") : null;
}

export function mapAuction(it: KlaravikItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(it.id),
    title: it.name ?? `Klaravik ${it.id}`,
    description: null,
    sourceUrl: it.url ?? "https://www.klaravik.se",
  };
}

/**
 * `vatOverride` används av fetchItem (exakt moms ur objektsidan). `description`
 * berikas ur objektsidan (div.product-grid__content) en gång/objekt.
 */
export function mapItem(
  it: KlaravikItem,
  vatOverride?: number,
  description: string | null = null,
): NormalizedItem {
  const endsAt = it.endDate ? new Date(it.endDate).toISOString() : null;
  const live = !it.ended;
  const bid = it.currentBid && it.currentBid > 0 ? it.currentBid : null;
  return {
    house: HOUSE,
    externalId: String(it.id),
    partExternalId: String(it.id),
    auctionExternalId: String(it.id),
    title: it.name ?? "",
    description,
    location: location(it),
    status: live ? "active" : "ended",
    endsAt,
    // Lägsta giltiga bud: utropspris om satt, annars nästa budsteg (startingPrice är ofta
    // 0 → visa nextBidStep/bidStep så det aldrig står 0 kr när bud saknas).
    minBid:
      (it.startingPrice && it.startingPrice > 0 ? it.startingPrice : null) ??
      (it.nextBidStep && it.nextBidStep > 0 ? it.nextBidStep : null) ??
      (it.bidStep && it.bidStep > 0 ? it.bidStep : null),
    currentBid: bid,
    bidCount: it.amountOfBids ?? 0,
    // Reservpris-status ur Klaraviks eget enum: REACHED=uppnått, NOTREACHED=ej uppnått,
    // NONE=inget reservpris (löser no-reserve rent). Beloppet exponeras ej → reservePrice null.
    reserveStatus:
      it.reservePriceStatus === "REACHED" ? "met"
      : it.reservePriceStatus === "NOTREACHED" ? "not_met"
      : it.reservePriceStatus === "NONE" ? "none"
      : null,
    // Exakt köpar-förmedlingsavgift i kr (source-läge, inkl. moms → feeVatRate 0).
    feeValue: it.auctionFee ?? null,
    vatRate: vatOverride ?? vatForCategory(it.categoryNameLevel1),
    currency: "SEK",
    seller: "Klaravik",
    listedAt: it.startDate ? new Date(it.startDate).toISOString() : null,
    media: mapMedia(it),
    sourceUrl: it.url ?? `https://www.klaravik.se/auktion/produkt/${it.id}/`,
    raw: it as unknown as RawPayload,
  };
}
