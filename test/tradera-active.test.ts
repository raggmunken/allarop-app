import { describe, it, expect } from "vitest";
import { mapActiveItem, mapSoldItem } from "../src/connectors/tradera/map.ts";
import type { RawTraderaItem } from "../src/connectors/tradera/flight.ts";

const AUCTION: RawTraderaItem = {
  itemId: 123456789,
  price: 450,
  shortDescription: "Vintage kaffeservis, 12 delar",
  itemUrl: "https://www.tradera.com/item/123456789",
  itemType: "Auction",
  totalBids: 7,
  endDate: "2026-08-05T19:30:00.000Z",
  isActive: true,
  categoryId: 12,
  reservedPriceReached: true,
  imageUrlTemplate: "https://img.tradera.net/images/{format}/123.jpg",
  sellerIsCompany: false,
};

const FIXED: RawTraderaItem = {
  itemId: 987654321,
  price: 1200,
  buyNowPrice: 1500,
  shortDescription: "Cykel, dam 28 tum",
  itemUrl: "https://www.tradera.com/item/987654321",
  itemType: "PureBin",
  endDate: "2026-09-01T12:00:00.000Z",
  imageUrlTemplate: "https://img.tradera.net/images/{format}/456.jpg",
  sellerIsCompany: true,
};

describe("mapActiveItem (aktiva Tradera-objekt → items)", () => {
  it("auktion: price = aktuellt bud, aktiv status, antal bud", () => {
    const it = mapActiveItem(AUCTION)!;
    expect(it.house).toBe("tradera");
    expect(it.externalId).toBe("123456789");
    expect(it.status).toBe("active");
    expect(it.currentBid).toBe(450);
    expect(it.bidCount).toBe(7);
    expect(it.endsAt).toBe("2026-08-05T19:30:00.000Z");
    expect(it.reserveStatus).toBe("met");
    expect(it.currency).toBe("SEK");
    expect(it.sourceUrl).toBe(AUCTION.itemUrl);
  });

  it("köp nu (PureBin): buyNowPrice vinner över price", () => {
    const it = mapActiveItem(FIXED)!;
    expect(it.currentBid).toBe(1500);
    expect(it.status).toBe("active");
  });

  it("köp nu (PureBin): ingen sluttid - Traderas syntetiska sluttid (~15 år) ignoreras", () => {
    const it = mapActiveItem({ ...FIXED, endDate: "2041-07-01T12:00:00.000Z" })!;
    expect(it.endsAt).toBeNull();
    expect(it.status).toBe("active");
  });

  it("auktion: normal sluttid behålls", () => {
    expect(mapActiveItem(AUCTION)!.endsAt).toBe("2026-08-05T19:30:00.000Z");
  });

  it("auktion: absurd sluttid (>2 år fram) kläms till null", () => {
    const it = mapActiveItem({ ...AUCTION, endDate: "2041-07-01T12:00:00.000Z" })!;
    expect(it.endsAt).toBeNull();
  });

  it("GDPR: aldrig säljaridentitet - seller är alltid 'Tradera'", () => {
    expect(mapActiveItem(AUCTION)!.seller).toBe("Tradera");
    expect(mapActiveItem(FIXED)!.seller).toBe("Tradera");
    // raw får bara anonyma flaggor (ingen alias/memberId).
    const raw = mapActiveItem(AUCTION)!.raw as Record<string, unknown>;
    expect(raw.sellerAlias).toBeUndefined();
    expect(raw.sellerMemberId).toBeUndefined();
  });

  it("ingen köparavgift/moms (privat Tradera) → total = pris via source-läge", () => {
    const it = mapActiveItem(AUCTION)!;
    expect(it.feeValue).toBeNull();
    expect(it.vatRate).toBeNull();
  });

  it("bilder normaliseras till 500-square", () => {
    const it = mapActiveItem(AUCTION)!;
    expect(it.media.length).toBe(1);
    expect(it.media[0]!.url).toBe("https://img.tradera.net/images/500-square/123.jpg");
  });

  it("skippar objekt utan pris (ContactOnly/0 kr)", () => {
    expect(mapActiveItem({ itemId: 1, itemType: "ContactOnly", price: 0 })).toBeNull();
    expect(mapActiveItem({ itemId: 2, itemType: "Auction" })).toBeNull();
  });

  it("endDate null (fastpris utan sluttid) → endsAt null men aktiv", () => {
    const it = mapActiveItem({ ...FIXED, endDate: undefined })!;
    expect(it.status).toBe("active");
    expect(it.endsAt).toBeNull();
  });
});

describe("mapSoldItem (oförändrat beteende)", () => {
  it("sålt objekt mappas fortfarande som ended", () => {
    const it = mapSoldItem({ ...AUCTION, price: 500 })!;
    expect(it.status).toBe("ended");
    expect(it.currentBid).toBe(500);
  });
});
