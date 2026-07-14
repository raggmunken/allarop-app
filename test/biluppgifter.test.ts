import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseValuation, parseVehiclePage, regnrFrom } from "../src/vehicle/biluppgifter.ts";
import { regnrForItem } from "../src/vehicle/enrich.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "biluppgifter", n), "utf8");

describe("regnrFrom (svenskt regnr ur fritext)", () => {
  it("ABC123, ABC 123 och nya formatet ABC12D", () => {
    expect(regnrFrom("Ford Transit, reg FXH667, besiktigad")).toBe("FXH667");
    expect(regnrFrom("regnr fxh 667")).toBe("FXH667");
    expect(regnrFrom("Volvo V70 ABC12D dragkrok")).toBe("ABC12D");
  });

  it("kastar skräp: I/Q/V-bokstäver, modellkoder, inget regnr", () => {
    expect(regnrFrom("Eames EA208 Soft Pad")).toBeNull(); // 2 bokstäver + 3 siffror ≠ regnr
    expect(regnrFrom("QIV123")).toBeNull(); // Q/I/V används ej på svenska skyltar
    expect(regnrFrom("Stol i björk")).toBeNull();
    expect(regnrFrom(null)).toBeNull();
  });

  it("regnrForItem: AI-attributet (skylt ur bild) före text-regexen", () => {
    expect(regnrForItem({ title: "Skåpbil", description: null, attrs: { reg: "ABC123" } })).toBe("ABC123");
    expect(regnrForItem({ title: "Skåpbil XYZ456", description: null, attrs: null })).toBe("XYZ456");
    expect(regnrForItem({ title: "Skåpbil", description: null, attrs: null })).toBeNull();
  });
});

describe("parseVehiclePage (fixtur FXH667, hämtad 2026-07-06)", () => {
  const v = parseVehiclePage("FXH667", fx("fordon.html"))!;

  it("identitet + historik + besiktning", () => {
    expect(v.regnr).toBe("FXH667");
    expect(v.summary).toContain("Peugeot 207 SW");
    expect(v.ownerCount).toBe(10);
    expect(v.lastOwnerChange).toBe("2023-06-20");
    expect(v.inspectedAt).toBe("2026-03-02");
    expect(v.odometerMil).toBe(21796);
    expect(v.firstRegistered).toBe("2008-03-10");
  });

  it("ekonomi + belastningar + teknik", () => {
    expect(v.taxSekPerYear).toBe(2146);
    expect(v.onCredit).toBe(false);
    expect(v.leased).toBe(false);
    expect(v.imported).toBe(false);
    expect(v.horsepower).toBe(109);
    expect(v.gearbox).toBe("Manuell");
    expect(v.fuel).toBe("Diesel");
  });

  it("värderingslänkens km-estimat plockas ur sidan; fel regnr → null", () => {
    expect(v.valuationKm).toBe(228288);
    expect(parseVehiclePage("ZZZ999", fx("fordon.html"))).toBeNull();
  });
});

describe("parseValuation (fixtur)", () => {
  it("bilhandlar- och privatpris-intervall", () => {
    const val = parseValuation(fx("valuation.html"));
    expect(val.dealerMin).toBe(21000);
    expect(val.dealerMax).toBe(23000);
    expect(val.privateMin).toBe(19000);
    expect(val.privateMax).toBe(21000);
  });
});

import { makeMatches } from "../src/vehicle/enrich.ts";

describe("makeMatches (plåt-korsvalidering, OCR-skydd 2026-07-06)", () => {
  const veh = (summary: string) => ({ summary } as Parameters<typeof makeMatches>[0]);
  it("rätt märke i titeln → accepteras", () => {
    expect(makeMatches(veh("SOB533 Volvo S60 I 2.4 T Grön 2001"), { title: "Volvo S60 2.4T -01", attrs: null })).toBe(true);
  });
  it("fel märke (OCR läste annan skylt) → kastas", () => {
    expect(makeMatches(veh("SOB533 Volvo S60 I 2.4 T Grön 2001"), { title: "Ford Transit skåpbil", attrs: null })).toBe(false);
  });
  it("märket i attrs.b räcker; VW-alias fångas", () => {
    expect(makeMatches(veh("XYZ123 Peugeot 207 SW"), { title: "Fransk halvkombi", attrs: { b: "Peugeot" } })).toBe(true);
    expect(makeMatches(veh("ABC123 Volkswagen Passat"), { title: "VW Passat kombi", attrs: null })).toBe(true);
  });
});
