/**
 * Normalisering: Metropol-kort → domäntyper. Köparprovisionen ej publik → external-läge
 * (visa bud + "avgift tillkommer", ingen fejkad total). "Bjud mer än" = lägsta giltiga bud
 * (minBid). Budgivare anonyma → inga bud-rader. Korten bär rik beskrivning + exakt sluttid.
 */

import { NormalizedAuction, NormalizedItem, NormalizedMedia, RawPayload } from "../types.ts";
import { MetropolItem } from "./client.ts";

export const HOUSE = "metropol";
const BASE = "https://www.metropol.se";

const sourceUrl = (it: MetropolItem) => `${BASE}${it.goPath}`;

export function mapAuction(it: MetropolItem): NormalizedAuction {
  return {
    house: HOUSE,
    externalId: it.id,
    title: it.title,
    description: it.description,
    sourceUrl: sourceUrl(it),
  };
}

export interface MetropolDetail {
  images: string[];
}

function mapMedia(it: MetropolItem, detail: MetropolDetail | null): NormalizedMedia[] {
  // Berikat galleri (objektsidans imagebank-bilder) om det finns; annars kortets bild.
  const urls = detail?.images?.length ? detail.images : it.image ? [it.image] : [];
  return urls.map((url, i) => ({ kind: "image", url, sort: i + 1 }));
}

export function mapItem(it: MetropolItem, detail: MetropolDetail | null = null, now = new Date()): NormalizedItem {
  const endedByTime = it.endsAt != null && new Date(it.endsAt).getTime() <= now.getTime();
  return {
    house: HOUSE,
    externalId: it.id,
    partExternalId: it.id,
    auctionExternalId: it.id,
    title: it.title,
    description: it.description,
    location: null,
    status: endedByTime ? "ended" : "active",
    endsAt: it.endsAt,
    minBid: it.minBid, // "Bjud mer än" (lägsta giltiga bud / utrop)
    currentBid: null, // Metropol visar ej aktuellt bud på kortet, bara lägsta giltiga
    bidCount: null,
    reserveStatus: null,
    feeValue: null, // external
    vatRate: null,
    currency: "SEK",
    seller: "Metropol Auktioner",
    listedAt: null,
    media: mapMedia(it, detail),
    sourceUrl: sourceUrl(it),
    raw: { item: it } as unknown as RawPayload,
  };
}
