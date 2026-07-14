import { describe, it, expect } from "vitest";
import { dv, mapDoc } from "../src/connectors/auktiona/client.ts";
import { mapItem, HOUSE } from "../src/connectors/auktiona/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const DOC_PREFIX = "projects/gobid-4db14/databases/(default)/documents/auctionItems/";

/** Firestore REST-doc: lott MED bud (currentLeader satt, egen sluttid). */
const withBid = {
  name: DOC_PREFIX + "abc123",
  fields: {
    title: { stringValue: "Land Rover Discovery V 3.0 TD6" },
    description: { stringValue: "4x4 258hk 2017" },
    currentPrice: { integerValue: "157000" },
    valuation: { integerValue: "270000" },
    currentLeader: { mapValue: { fields: { userId: { stringValue: "Tp6B4JoM6HNQlu1s0PRQ4yRac5w1" } } } },
    dateRange: { mapValue: { fields: { endDate: { timestampValue: "2026-07-08T11:00:00Z" } } } },
    auctionId: { stringValue: "AUC1" },
    images: { arrayValue: { values: [{ stringValue: "https://firebasestorage.googleapis.com/v0/b/gobid-4db14.firebasestorage.app/o/x.webp?alt=media&token=t" }] } },
    url: { stringValue: "/land-rover/land-rover-discovery-v" },
    status: { stringValue: "published" },
  },
};

/** Firestore REST-doc: lott UTAN bud (ingen currentLeader, ärver sluttid + ort från auktionen). */
const noBid = {
  name: DOC_PREFIX + "def456",
  fields: {
    title: { stringValue: "Indoor walker" },
    currentPrice: { integerValue: "100" },
    valuation: { integerValue: "3000" },
    currentLeader: { nullValue: null },
    auctionId: { stringValue: "AUC2" },
    images: { arrayValue: { values: [] } },
    url: { stringValue: "/gymmaskiner/indoor-walker" },
    status: { stringValue: "published" },
  },
};

const auctions = new Map([
  ["AUC1", { endDate: "2026-07-08T11:00:00.000Z", city: "Lomma" }],
  ["AUC2", { endDate: "2026-07-09T11:00:00.000Z", city: "Malmö" }],
]);

describe("Auktiona Firestore-avkodning", () => {
  it("dv() avkodar typade Firestore-värden", () => {
    expect(dv({ stringValue: "x" })).toBe("x");
    expect(dv({ integerValue: "42" })).toBe(42);
    expect(dv({ booleanValue: true })).toBe(true);
    expect(dv({ nullValue: null })).toBeNull();
    expect(dv({ mapValue: { fields: { a: { integerValue: "1" } } } })).toEqual({ a: 1 });
    expect(dv({ arrayValue: { values: [{ stringValue: "a" }, { stringValue: "b" }] } })).toEqual(["a", "b"]);
  });
});

describe("Auktiona mapDoc (bud / utan bud + arv)", () => {
  it("med bud: currentBid satt, egen sluttid, bilder, serviceFee 0, sourceUrl", () => {
    const it = mapDoc(withBid, auctions);
    expect(it.id).toBe("abc123");
    expect(it.currentBid).toBe(157000);
    expect(it.minBid).toBeNull();
    expect(it.valuation).toBe(270000);
    expect(it.endsAt).toBe("2026-07-08T11:00:00.000Z");
    expect(it.images.length).toBe(1);
    expect(it.images[0]).toContain("firebasestorage");
    expect(it.serviceFee).toBe(0); // ingen settings → "none"
    expect(it.sourceUrl).toBe("https://auktiona.se/auktioner/land-rover/land-rover-discovery-v");
  });

  it("utan bud: currentBid null, minBid = startbud, ärver sluttid + ort", () => {
    const it = mapDoc(noBid, auctions);
    expect(it.currentBid).toBeNull();
    expect(it.minBid).toBe(100);
    expect(it.endsAt).toBe("2026-07-09T11:00:00.000Z"); // ärvd från AUC2
    expect(it.location).toBe("Malmö"); // ärvd ort
  });
});

describe("Auktiona normalisering (source: total = bud + serviceavgift)", () => {
  it("mapItem: source, seller, total = bud (serviceFee 0, moms ingår)", () => {
    const n = mapItem(mapDoc(withBid, auctions), new Date("2020-01-01"));
    expect(n.house).toBe(HOUSE);
    expect(n.seller).toBe("Auktiona");
    expect(n.currentBid).toBe(157000);
    expect(n.media.length).toBe(1);
    const total = computeTotal({ bid: 157000, sourceFeeValue: n.feeValue, sourceVatRate: n.vatRate }, feeModelFor("auktiona"));
    expect(total.basis).toBe("source");
    expect(total.total).toBe(157000); // serviceFee 0 + moms ingår → total = bud
  });
});
