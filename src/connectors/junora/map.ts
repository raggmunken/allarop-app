/**
 * Normalisering: Junora-objekt (list + Shopify-detalj) → projektets domäntyper.
 * Junora är ETT hus (seller = "Junora"); varje objekt en egen auktion. Slagavgiften
 * är en fast avgift PER OBJEKT som bara visas inloggad → external-läge: vi visar budet
 * och markerar "slagavgift tillkommer" (ingen fejkad total). Budgivare anonyma → inga bud-rader.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { JunoraDetail, JunoraListItem, toIsoUtc } from "./client.ts";
import { slagavgiftForReserve } from "./fee.ts";

export const HOUSE = "junora";
const SHOP = "https://junora.se";

const sourceUrl = (it: JunoraListItem) => `${SHOP}/products/${it.slug}`;

export function mapAuction(it: JunoraListItem, detail: JunoraDetail | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.remoteId,
    title: it.name || `Junora ${it.remoteId}`,
    description: detail?.description ?? null,
    sourceUrl: sourceUrl(it),
  };
}

function mapMedia(it: JunoraListItem, detail: JunoraDetail | null): NormalizedMedia[] {
  const urls = detail?.images?.length ? detail.images : it.imageUrl ? [it.imageUrl] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(
  it: JunoraListItem,
  detail: JunoraDetail | null = null,
  now = new Date(),
): NormalizedItem {
  const endsAt = toIsoUtc(it.endTimeUtc);
  const endedByTime = endsAt != null && new Date(endsAt).getTime() <= now.getTime();
  // status 2 = aktiv; allt annat (4 = avslutad/såld m.fl.) = avslutad.
  const active = it.status === 2 && !endedByTime;
  const bid = it.currentPrice;
  return {
    house: HOUSE,
    externalId: it.remoteId,
    partExternalId: it.remoteId,
    auctionExternalId: it.remoteId,
    title: it.name,
    description: detail?.description ?? null,
    location: it.city,
    status: active ? "active" : "ended",
    endsAt,
    // Minsta giltiga bud: minimumBidAmount (det man MÅSTE buda, även när currentPrice=0),
    // annars startingPrice. Driver "utrop" + estimate-basis för 0-budsobjekt.
    minBid: detail?.minBidAmount ?? detail?.startBid ?? null,
    currentBid: bid != null && bid > 0 ? bid : null,
    bidCount: it.numBids,
    // Reservpris: status ur list-flaggorna, VÄRDET ur detaljen (Junora läcker det).
    reserveStatus: it.withoutReserve ? "none" : it.reserveMet ? "met" : "not_met",
    reservePrice: detail?.reservePrice ?? null,
    // UNGEFÄRLIG slagavgift ur reservpriset (harvestad trapp-tabell) + bud-moms ur
    // säljartyp → avgiftsmotorn ger basis "estimate" (UI markerar totalen med "≈").
    // Saknas reservpris → feeValue null → external-fallback ("+ avgift") tills berikat.
    feeValue: detail?.reservePrice != null ? slagavgiftForReserve(detail.reservePrice) : null,
    // Bud-moms ur säljartyp; okänd (sidhämtning misslyckades) men estimate → default 25
    // ("På samtliga objekt tillkommer moms om inget annat anges"), annars null.
    vatRate: detail?.sellerVatRate ?? (detail?.reservePrice != null ? 25 : null),
    currency: "SEK",
    seller: "Junora",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: sourceUrl(it),
    raw: { item: it, detail } as unknown as RawPayload,
  };
}
