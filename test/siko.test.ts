import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseDetail, imageUrl, swedishToIso } from "../src/connectors/siko/client.ts";
import { mapItem, HOUSE } from "../src/connectors/siko/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "siko", n), "utf8");

describe("Sikö client-parsers", () => {
  it("imageUrl (zero-padded id, fullstorlek im920) + swedishToIso", () => {
    expect(imageUrl(884800, 1)).toBe(
      "https://siko-im920.fra1.cdn.digitaloceanspaces.com/00884800_1.jpg",
    );
    expect(swedishToIso("2026-07-03 19:14:00")).toBe(new Date(swedishToIso("2026-07-03 19:14:00")!).toISOString());
    // juli → CEST (UTC+2): 19:14 lokalt = 17:14 UTC
    expect(swedishToIso("2026-07-03 19:14:00")).toBe("2026-07-03T17:14:00.000Z");
    expect(swedishToIso(null)).toBeNull();
  });

  it("parseDetail → titel/sluttid/utrop/bild ur SSR-HTML", () => {
    const d = parseDetail(fx("detail.html"), 884800);
    expect(d.title).toBe("Formar Gefle Blått");
    expect(d.valuation).toBe(300);
    expect(d.endsAt).toBe("2026-07-03T17:14:00.000Z");
    expect(d.images[0]).toContain("siko-im920.fra1.cdn.digitaloceanspaces.com/00884800_1.jpg");
  });
});

describe("Sikö normalisering (percentage 18 % + 28 kr)", () => {
  it("mapItem: bud ur live, sluttid ur detalj, seller, momsfri", () => {
    const live = { id: 884800, bid: 175, secondsRemaining: 5000 };
    const d = parseDetail(fx("detail.html"), 884800);
    const it = mapItem(live, d, new Date("2020-01-01"));
    expect(it.house).toBe(HOUSE);
    expect(it.seller).toBe("Sikö");
    expect(it.externalId).toBe("884800");
    expect(it.currentBid).toBe(175);
    expect(it.status).toBe("active");
    expect(it.endsAt).toBe("2026-07-03T17:14:00.000Z"); // ur detaljen, ej now+sec
    expect(it.vatRate).toBe(0);
  });

  it("sluttid faller tillbaka på now + seconds_remaining utan detalj", () => {
    const now = new Date("2026-06-30T12:00:00.000Z");
    const it = mapItem({ id: 1, bid: 50, secondsRemaining: 3600 }, null, now);
    expect(it.endsAt).toBe("2026-06-30T13:00:00.000Z");
    expect(it.title).toBe("Sikö 1");
  });

  it("total: bud 1000 → 1208 (1000 + 18 % provision + 28 kr slagavgift)", () => {
    const total = computeTotal({ bid: 1000, sourceVatRate: 0 }, feeModelFor("siko"));
    expect(total.basis).toBe("percentage");
    expect(total.total).toBe(1208);
  });
});
