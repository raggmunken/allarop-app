import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseVehicles, parseDetail, imageUrl, msToIso } from "../src/connectors/frivio/client.ts";
import { mapItem, HOUSE } from "../src/connectors/frivio/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "frivio", n), "utf8");

describe("Frivio client-parsers", () => {
  it("imageUrl + msToIso", () => {
    expect(imageUrl(596, "a1.jpeg")).toBe("https://backend.frivio.se/vehicle/596/a1.jpeg");
    expect(msToIso(1782830160000)).toBe(new Date(1782830160000).toISOString());
    expect(msToIso(null)).toBeNull();
  });

  it("parseVehicles → fordon med bud/sluttid/bild/avgift", () => {
    const vs = parseVehicles(fx("vehicles.json"));
    expect(vs.length).toBe(3);
    const v = vs[0]!;
    expect(v.title.length).toBeGreaterThan(0);
    expect(v.auctionEnd).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(v.hammerFeePct).toBe(5);
    if (v.images[0]) expect(v.images[0]).toContain("backend.frivio.se/vehicle/");
  });

  it("parseDetail → beskrivning + säljartyp (privat = momsfri)", () => {
    const d = parseDetail(fx("detail.json"));
    expect(d.isCompany).toBe(false); // foretag null → privatperson
    expect(typeof d.bidCount === "number" || d.bidCount === null).toBe(true);
  });
});

describe("Frivio normalisering (percentage 5 % + objektsmoms)", () => {
  const vs = parseVehicles(fx("vehicles.json"));
  const d = parseDetail(fx("detail.json"));

  it("mapItem: bud/utrop/sluttid/seller + objektsmoms ur säljartyp", () => {
    const it = mapItem(vs[0]!, d, new Date("2020-01-01"));
    expect(it.house).toBe(HOUSE);
    expect(it.seller).toBe("Frivio");
    expect(it.feeValue).toBeNull(); // percentage-läge
    expect(it.vatRate).toBe(0); // privat → momsfri
    expect(it.minBid).toBe(vs[0]!.startingPrice);
  });

  it("total: privat 100000 → 106250 (bud + 5 % slagavgift + 25 % moms på avgift)", () => {
    const total = computeTotal({ bid: 100000, sourceVatRate: 0 }, feeModelFor("frivio"));
    expect(total.basis).toBe("percentage");
    expect(total.total).toBe(106250);
  });

  it("total: företag 100000 → 131250 (+ 25 % objektsmoms på budet)", () => {
    const total = computeTotal({ bid: 100000, sourceVatRate: 25 }, feeModelFor("frivio"));
    expect(total.total).toBe(131250);
  });
});
