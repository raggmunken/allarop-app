/**
 * Normalisering: Retrade-objekt (list + detalj) → projektets domäntyper.
 * Retrade är ETT hus (seller = "Retrade"); varje objekt är sin egen auktion.
 * Köparavgiften är en glidande skala som ej finns i API:t → external-läge: vi visar
 * budet och markerar i UI att avgift + moms tillkommer (ingen fejkad total).
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { RetradeDetail, RetradeListItem } from "./client.ts";

export const HOUSE = "retrade";
const ORIGIN = "https://retrade.eu";

const sourceUrl = (id: string) => `${ORIGIN}/sv/auction/${id}`;

export function mapAuction(it: RetradeListItem, detail: RetradeDetail | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.id,
    title: it.heading || `Retrade ${it.id}`,
    description: detail?.description ?? null,
    sourceUrl: sourceUrl(it.id),
  };
}

function mapMedia(it: RetradeListItem, detail: RetradeDetail | null): NormalizedMedia[] {
  const urls = detail?.images?.length ? detail.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(
  it: RetradeListItem,
  detail: RetradeDetail | null = null,
  now = new Date(),
): NormalizedItem {
  // LIVE-fält (bud + sluttid) drivs av LISTAN - den är alltid färsk i fetchPage och
  // hålls färsk för heta objekt av fetchItem (som uppdaterar list-objektet). Den
  // CACHADE detaljen är statisk (berikas en gång) → att föredra detail.highestBid
  // skulle frysa budet på berikade objekt. Detaljen ger soft-close (effectiveEndAt)
  // som reserv + statiskt (beskrivning/galleri/märke) + nästa minbud + antal bud.
  const endsAt = it.auctionEnd ?? detail?.effectiveEndAt ?? detail?.auctionEnd ?? null;
  const endedByTime = endsAt != null && new Date(endsAt).getTime() <= now.getTime();
  const active = !endedByTime && (detail ? !(detail.hasEnded || detail.isSold) : true);
  const bid = (it.highestBid ?? detail?.highestBid);
  return {
    house: HOUSE,
    externalId: it.id,
    partExternalId: it.id,
    auctionExternalId: it.id,
    title: it.heading,
    description: detail?.description ?? null,
    location: detail?.location ?? it.place,
    status: active ? "active" : "ended",
    endsAt,
    // Nästa giltiga bud = utrop/golv så objekt utan bud får ett pris att visa.
    minBid: detail?.lowestValidBid ?? null,
    currentBid: bid != null && bid > 0 ? bid : null,
    bidCount: detail ? detail.bidCount : null,
    // external-läge: avgift går ej att beräkna ur publik data → feeValue/vatRate null,
    // avgiftsmotorn ger basis "external" (UI markerar "avgift + moms tillkommer").
    feeValue: null,
    vatRate: null,
    currency: it.currency || "SEK",
    seller: "Retrade",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: sourceUrl(it.id),
    raw: { item: it, detail } as unknown as RawPayload,
  };
}
