/**
 * Normalisering av Tradera-sålt → NormalizedItem (för price_history + media).
 *
 * VIKTIGT (GDPR, användarens beslut): vi sparar ALDRIG säljarens identitet.
 * sellerAlias och sellerMemberId tas medvetet inte med. Vi behåller bara
 * pris/objekt-fält (titel, pris, datum, kategori, bild, typ, antal bud).
 *
 * Tradera-annonser mellan privatpersoner har ingen köparprovision/moms - `price`
 * ÄR vad varan gick för. Därför total = pris (fee-modell "tradera" = source utan
 * avgift, se fees/rules.ts). "Hellre inget än fel": vi hittar aldrig på en total.
 */

import type { NormalizedItem, NormalizedMedia } from "../types.ts";
import type { RawTraderaItem } from "./flight.ts";

export const HOUSE = "tradera";

/** Bildformat på Traderas CDN (verifierat: 250-square finns; medelstor för tumnagel). */
const IMG_FORMAT = "500-square";

function mediaFrom(it: RawTraderaItem): NormalizedMedia[] {
  const urls: string[] = [];
  if (it.imageUrlTemplate) urls.push(it.imageUrlTemplate);
  if (it.imageSecondaryUrlTemplate) urls.push(it.imageSecondaryUrlTemplate);
  return urls
    .map((t) => t.replace("{format}", IMG_FORMAT))
    .map((url, i) => ({ kind: "image" as const, url, sort: i }));
}

/**
 * Ett sålt Tradera-objekt → NormalizedItem. `price` = slutpris (vinnande bud för
 * auktion, köp-nu-pris för fastpris). reserveStatus sätts så upsertPriceHistory
 * markerar sold=true (objektet ÄR sålt). part/auction-id lämnas tomma - de används
 * inte av upsertPriceHistory (price_history-only, ingen items/parts-rad).
 */
export function mapSoldItem(it: RawTraderaItem): NormalizedItem | null {
  const price = Number(it.price ?? it.buyNowPrice ?? 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  const externalId = String(it.itemId);
  return {
    house: HOUSE,
    externalId,
    partExternalId: "",
    auctionExternalId: "",
    title: (it.shortDescription ?? "").trim() || `Tradera ${externalId}`,
    status: "ended",
    endsAt: it.endDate ?? null,
    currentBid: Math.round(price),
    bidCount: typeof it.totalBids === "number" ? it.totalBids : null,
    // Sålt objekt: reserv nådd (eller ingen reserv) - aldrig "not_met".
    reserveStatus: it.reservedPriceReached ? "met" : "none",
    currency: "SEK",
    feeValue: null, // privat Tradera: ingen köparavgift
    vatRate: null, // ingen moms läggs på (privatförsäljning)
    media: mediaFrom(it),
    sourceUrl: it.itemUrl ?? null,
    raw: {
      itemType: it.itemType ?? null,
      categoryId: it.categoryId ?? null,
      sellerIsCompany: it.sellerIsCompany ?? null, // anonym flagga, ingen identitet
      totalBids: it.totalBids ?? null,
    },
  };
}
