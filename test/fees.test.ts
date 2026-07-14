import { describe, it, expect } from "vitest";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor, feeModelForItem } from "../src/fees/rules.ts";

describe("avgiftsmotor", () => {
  it("Auctionet Sverige: 25 % provision (inkl moms) + 80 kr slagavgift", () => {
    // Auctionets eget exempel: bud 1000 → 250 provision + 80 slagavgift = 1 330.
    const b = computeTotal({ bid: 1000 }, feeModelForItem("auctionet", "SEK"));
    expect(b.fee).toBe(330); // 250 + 80
    expect(b.vat).toBe(0); // provision anges inkl moms
    expect(b.total).toBe(1330);
  });

  it("Auctionet Storbritannien: 33,6 % + 5 GBP slagavgift", () => {
    const b = computeTotal({ bid: 100 }, feeModelForItem("auctionet", "GBP"));
    expect(b.fee).toBe(39); // 33,6 + 5 = 38,6 → 39
    expect(b.total).toBe(139); // 100 + 33,6 + 5 = 138,6 → 139
  });

  it("Auctionet euro-hus: 25 % + 8 EUR slagavgift (exempel 100 → 133)", () => {
    const b = computeTotal({ bid: 100 }, feeModelForItem("auctionet", "EUR"));
    expect(b.total).toBe(133); // 100 + 25 + 8
  });

  it("Tovek båt: objekt 0 % moms men slagavgift +25 %", () => {
    // bud 20 000 (0 % moms) + slagavgift 1 300 (alltid 25 %) → 1 625 kr avgift.
    const b = computeTotal(
      { bid: 20000, sourceFeeValue: 1300, sourceVatRate: 0 },
      feeModelFor("tovek"),
    );
    expect(b.basis).toBe("source");
    expect(b.fee).toBe(1300);
    expect(b.vat).toBe(325); // 25 % av 1 300 (objektets 0 % gäller bara budet)
    expect(b.total).toBe(21625);
  });

  it("Tovek skrivbord: objekt 25 % + slagavgift 25 %", () => {
    const b = computeTotal(
      { bid: 600, sourceFeeValue: 250, sourceVatRate: 25 },
      feeModelFor("tovek"),
    );
    expect(b.fee).toBe(250);
    expect(b.vat).toBe(213); // 25 % av 600 + 25 % av 250 = 150 + 62,5
    expect(b.total).toBe(1063); // (600+250)×1,25
  });

  it("source utan feeVatRate: objektets momssats gäller även avgiften", () => {
    const b = computeTotal(
      { bid: 1000, sourceFeeValue: 200, sourceVatRate: 25 },
      { kind: "source" },
    );
    expect(b.vat).toBe(300); // 25 % av (1000+200)
    expect(b.total).toBe(1500);
  });

  it("procentmodell respekterar minsta kronbelopp", () => {
    const b = computeTotal(
      { bid: 100 },
      { kind: "percentage", premiumRate: 0.18, premiumMinKr: 95, vatRate: 0.25 },
    );
    expect(b.fee).toBe(95); // golvet slår in (18 % av 100 = 18 < 95)
    expect(b.vat).toBe(24); // 25 % av 95 = 23.75 → 24
    expect(b.total).toBe(219);
  });

  it("moms på totalen i stället för bara avgiften", () => {
    const b = computeTotal(
      { bid: 1000 },
      { kind: "percentage", premiumRate: 0.1, vatRate: 0.25, vatOnTotal: true },
    );
    expect(b.fee).toBe(100);
    expect(b.vat).toBe(275); // 25 % av (1000+100)
    expect(b.total).toBe(1375);
  });

  it("Riksauktioner: klubbavgift min 100 kr + moms på bud & avgift", () => {
    // bud 100 (25 % moms) → avgift max(10,100)=100 → moms 25+25 = 50 → 250.
    const b = computeTotal(
      { bid: 100, sourceVatRate: 25 },
      feeModelFor("riksauktioner"),
    );
    expect(b.fee).toBe(100);
    expect(b.vat).toBe(50);
    expect(b.total).toBe(250);
  });

  it("Riksauktioner: momsbefriat fordon (0 % på bud) men moms kvar på avgift", () => {
    // bud 5000 (0 % objektsmoms) → avgift 500 → moms bara på avgift = 125 → 5625.
    const b = computeTotal(
      { bid: 5000, sourceVatRate: 0 },
      feeModelFor("riksauktioner"),
    );
    expect(b.fee).toBe(500);
    expect(b.vat).toBe(125);
    expect(b.total).toBe(5625);
  });

  it("Riksauktioner: avgiftstak 10 000 kr slår in vid höga bud", () => {
    // bud 200 000 → 10 % = 20 000 men taket = 10 000.
    const b = computeTotal(
      { bid: 200000, sourceVatRate: 25 },
      feeModelFor("riksauktioner"),
    );
    expect(b.fee).toBe(10000); // tak, inte 20 000
    expect(b.total).toBe(262500); // 200000 + 10000 + 50000 + 2500
  });
});
