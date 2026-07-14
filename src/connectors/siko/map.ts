/**
 * Normalisering: Sikö (live-probe + SSR-detalj) → projektets domäntyper. Bud + sluttid
 * kommer ur live-endpointen (winner_bid + seconds_remaining); titel/utrop/bild/beskrivning
 * ur detaljsidan (berikas gradvis). Avgift = percentage-läge (18 % provision + 28 kr
 * slagavgift, provisionen inkl moms → feeVatRate 0). Lotterna är mest konsumentvaror/
 * privatsålt → objektsmoms 0 (VMB/momsfri). Budgivare anonyma → inga bud-rader.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { SikoDetail, SikoLive, imageUrl } from "./client.ts";

export const HOUSE = "siko";
const WWW = "https://www.sikoauktioner.se";

const sourceUrl = (id: number) => `${WWW}/auktion/${id}`;

export function mapAuction(live: SikoLive, detail: SikoDetail | null = null): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: String(live.id),
    title: detail?.title ?? `Sikö ${live.id}`,
    description: detail?.description ?? null,
    sourceUrl: sourceUrl(live.id),
  };
}

function mapMedia(live: SikoLive, detail: SikoDetail | null): NormalizedMedia[] {
  const urls = detail?.images?.length ? detail.images : [imageUrl(live.id, 1)];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(live: SikoLive, detail: SikoDetail | null = null, now = new Date()): NormalizedItem {
  // Sluttid: detaljens exakta data-stopsec först, annars nu + seconds_remaining.
  const endsAt =
    detail?.endsAt ?? new Date(now.getTime() + live.secondsRemaining * 1000).toISOString();
  const active = live.secondsRemaining > 0;
  return {
    house: HOUSE,
    externalId: String(live.id),
    partExternalId: String(live.id),
    auctionExternalId: String(live.id),
    title: detail?.title ?? `Sikö ${live.id}`,
    description: detail?.description ?? null,
    location: null,
    status: active ? "active" : "ended",
    endsAt,
    minBid: null,
    currentBid: live.bid != null && live.bid > 0 ? live.bid : null,
    bidCount: null,
    reserveStatus: null,
    feeValue: null, // percentage-läge
    vatRate: 0, // objektsmoms: konsumentvaror/privatsålt → momsfri/VMB
    currency: "SEK",
    seller: "Sikö",
    listedAt: null,
    media: mapMedia(live, detail),
    sourceUrl: sourceUrl(live.id),
    raw: { live, detail } as unknown as RawPayload,
  };
}
