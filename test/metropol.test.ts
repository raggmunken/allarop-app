import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseCards, datetimeToIso } from "../src/connectors/metropol/client.ts";
import { mapItem, HOUSE } from "../src/connectors/metropol/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "metropol", n), "utf8");

describe("Metropol client-parser", () => {
  it("datetimeToIso (svensk lokaltid → UTC)", () => {
    // juli → CEST (+2): 19:30 lokalt = 17:30 UTC
    expect(datetimeToIso("2026-07-13T19:30")).toBe("2026-07-13T17:30:00.000Z");
    expect(datetimeToIso(null)).toBeNull();
  });

  it("parseCards → id/titel/beskrivning/minBid/utrop/sluttid/bild", () => {
    const items = parseCards(fx("product-cards.html"));
    expect(items.length).toBe(3);
    const it = items[0]!;
    expect(it.id).toBe("732614");
    expect(it.title.length).toBeGreaterThan(2);
    expect(it.description).toBeTruthy();
    expect(it.minBid).toBe(50); // "Bjud mer än: 50 kr"
    expect(it.estimate).toBe(1000); // "Utrop: 1.000 kr"
    expect(it.endsAt).toBe("2026-07-13T17:30:00.000Z");
    expect(it.image).toContain("imagebank");
  });
});

describe("Metropol normalisering (avgift 25 % + 100 kr)", () => {
  it("mapItem: minBid, seller; total = bud + 25 % + 100 kr (inkl moms)", () => {
    const it = parseCards(fx("product-cards.html"))[0]!;
    const n = mapItem(it, new Date("2020-01-01"));
    expect(n.house).toBe(HOUSE);
    expect(n.seller).toBe("Metropol Auktioner");
    expect(n.externalId).toBe("732614");
    expect(n.minBid).toBe(50);
    expect(n.status).toBe("active");
    // Objektsidans budbekräftelse (verifierad 2026-07-03): "tillkommer 25% + 100 kronor
    // på det klubbade priset" → 5000 + 1250 + 100 = 6350.
    const total = computeTotal({ bid: 5000 }, feeModelFor("metropol"));
    expect(total.basis).toBe("percentage");
    expect(total.total).toBe(6350);
  });
});
