import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseAuctions, parseLots } from "../src/connectors/upplands/client.ts";
import { mapItem, HOUSE } from "../src/connectors/upplands/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "upplands", n), "utf8");

describe("Upplands client-parsers", () => {
  it("parseAuctions → test-auktioner bort, avslutad-flagga ur datum", () => {
    const a = parseAuctions(fx("auctions.json"), new Date("2027-01-01"));
    expect(a.length).toBeGreaterThan(0);
    expect(a.some((x) => /test/i.test(x.name))).toBe(false);
    // alla med passerad sluttid + winnersGenerated → ended (now=2027)
    expect(a.some((x) => x.ended)).toBe(true);
  });

  it("parseLots → inventoryItems ur __NEXT_DATA__ (bud/namn/reserv/bild)", () => {
    const lots = parseLots(fx("lots.html"));
    expect(lots.length).toBe(3);
    const l = lots[0]!;
    expect(l.name.length).toBeGreaterThan(0);
    expect(l.highBid).toBeGreaterThan(0); // avslutad auktion → slutbud
    expect(typeof l.hasReserve).toBe("boolean");
  });
});

describe("Upplands normalisering (avgift ur auktionens köparvillkor)", () => {
  const lots = parseLots(fx("lots.html"));
  const auc = parseAuctions(fx("auctions.json"), new Date("2027-01-01")).find((a) => a.id === lots[0]!.auctionId) ?? null;

  it("mapItem: reserv-status, seller, composite-id; utan villkor → external", () => {
    const noFee = auc ? { ...auc, buyersPremiumPct: null, hammerFeeTotalKr: null } : null;
    const it = mapItem(lots[0]!, noFee, new Date("2020-01-01"));
    expect(it.house).toBe(HOUSE);
    expect(it.seller).toBe("Upplands Auktionsverk");
    expect(it.externalId).toBe(String(lots[0]!.id));
    expect(it.currentBid).toBe(lots[0]!.highBid);
    expect(["met", "not_met", "none"]).toContain(it.reserveStatus);
    expect(it.feeValue).toBeNull();
    const total = computeTotal({ bid: 5000 }, feeModelFor("upplands"));
    expect(total.basis).toBe("external");
    expect(total.total).toBe(5000);
  });

  it("mapItem med villkor: avgift = bud × premium% × 1,25 + slagavgift (inkl moms)", () => {
    // Verifierat 2026-07-03: API buyersPremium 20 (exkl moms) + hammerFees.buyer.total 30
    // = sidans villkorstext "provision på 25% inkl moms samt slagavgift på 30kr inkl moms".
    const withFee = { ...(auc ?? { id: lots[0]!.auctionId, name: "x", startDate: null, endDate: null, ended: false, buyersPremiumPct: null, hammerFeeTotalKr: null }), buyersPremiumPct: 20, hammerFeeTotalKr: 30 };
    const lot = { ...lots[0]!, highBid: 10000 };
    const it = mapItem(lot, withFee, new Date("2020-01-01"));
    expect(it.feeValue).toBe(2530); // 10000×0,25 + 30
    expect(it.vatRate).toBe(0);
    const total = computeTotal(
      { bid: 10000, sourceFeeValue: it.feeValue, sourceVatRate: it.vatRate },
      feeModelFor("upplands"),
    );
    expect(total.basis).toBe("source");
    expect(total.total).toBe(12530);
  });

  it("parseAuctions plockar buyersPremium + hammerFees.buyer.total", () => {
    const a = parseAuctions(JSON.stringify([{ auctionId: 1, name: "A", endDate: null, buyersPremium: 16.0, hammerFees: { buyer: { amount: 16, rate: 25, tax: 4, total: 20 } } }]));
    expect(a[0]!.buyersPremiumPct).toBe(16);
    expect(a[0]!.hammerFeeTotalKr).toBe(20);
  });
});
