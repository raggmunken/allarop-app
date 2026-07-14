import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseListing, parseItemInfo, datetimeToIso } from "../src/connectors/pantbanken/client.ts";
import { mapItem, HOUSE } from "../src/connectors/pantbanken/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "pantbanken", n), "utf8");

describe("Pantbanken client-parser", () => {
  it("datetimeToIso (svensk lokaltid → UTC, med sekunder)", () => {
    // juli → CEST (+2): 16:02:30 lokalt = 14:02:30 UTC
    expect(datetimeToIso("2026-07-01 16:02:30")).toBe("2026-07-01T14:02:30.000Z");
    // januari → CET (+1): 12:00:00 lokalt = 11:00:00 UTC
    expect(datetimeToIso("2026-01-15 12:00:00")).toBe("2026-01-15T11:00:00.000Z");
    expect(datetimeToIso(null)).toBeNull();
  });

  it("parseListing → total + objekt (utan bud / med bud)", () => {
    const { items, total } = parseListing(fx("listing.html"));
    expect(total).toBe(4712);
    expect(items.length).toBe(2);

    // Utan bud: visat pris = utropspris, inget aktuellt bud, ingen budledare.
    const noBid = items[0]!;
    expect(noBid.id).toBe("1392455");
    expect(noBid.title).toContain("Collier med diamanter");
    expect(noBid.image).toContain("imagehandler.pantbanken.se");
    expect(noBid.image).toContain("bredd=stor");
    expect(noBid.auctionNumber).toBe("SE27.20260701.A4976");
    expect(noBid.currentBid).toBeNull();
    expect(noBid.minBid).toBe(25000); // utropspris = start_bud
    expect(noBid.bidCount).toBe(0);
    expect(noBid.leaderName).toBeNull();
    expect(noBid.endsAt).toBe("2026-07-01T14:02:30.000Z");

    // Med bud: visat pris = vinnande bud, start_bud = nästa krav, budledare satt.
    const bid = items[1]!;
    expect(bid.id).toBe("1392457");
    expect(bid.currentBid).toBe(11000); // vinnande bud
    expect(bid.minBid).toBe(11500); // nästa krav (bud + höjning)
    expect(bid.bidCount).toBe(1);
    expect(bid.leaderName).toBe("m_e_vb");
    expect(bid.endsAt).toBe("2026-07-01T14:03:30.000Z");
  });
});

describe("Pantbanken normalisering + avgift (15 % inkl moms)", () => {
  it("mapItem: bud → currentBid + leaderName, seller", () => {
    const bid = parseListing(fx("listing.html")).items[1]!;
    const n = mapItem(bid, null, new Date("2020-01-01"));
    expect(n.house).toBe(HOUSE);
    expect(n.seller).toBe("Pantbanken Sverige");
    expect(n.externalId).toBe("1392457");
    expect(n.currentBid).toBe(11000);
    expect(n.leaderName).toBe("m_e_vb");
    expect(n.status).toBe("active");
    expect(n.sourceUrl).toContain("visa-auktionsvara/?f_id=1392457");
  });

  it("mapItem utan bud: currentBid null, minBid = utrop, ingen ledare", () => {
    const noBid = parseListing(fx("listing.html")).items[0]!;
    const n = mapItem(noBid, null, new Date("2020-01-01"));
    expect(n.currentBid).toBeNull();
    expect(n.minBid).toBe(25000);
    expect(n.leaderName).toBeNull();
  });

  it("computeTotal: 15 % provision inkl moms → bud * 1,15", () => {
    const total = computeTotal({ bid: 11000 }, feeModelFor("pantbanken"));
    expect(total.basis).toBe("percentage");
    expect(total.fee).toBe(1650); // 11000 * 0,15
    expect(total.vat).toBe(0); // provisionen inkl moms
    expect(total.total).toBe(12650); // 11000 * 1,15
  });
});

describe("Pantbanken objektinformation", () => {
  it("parseItemInfo: behåller spec-rader, hoppar pris/tid, null utan tabell", () => {
    const detail =
      '<table class="varuinfotabell">' +
      '<tr><td class="varurubrik">Auktnr</td><td class="varuvarde">SE15.A40201</td></tr>' +
      '<tr><td class="varurubrik">Varukategori</td><td class="varuvarde">Guld / &Ouml;vrigt</td></tr>' +
      '<tr><td class="varurubrik">Utropspris</td><td class="varuvarde">25 000 kr</td></tr>' +
      '<tr><td class="varurubrik">Aktuellt bud</td><td class="varuvarde">26 000 kr</td></tr>' +
      '<tr><td class="varurubrik">Frakt</td><td class="varuvarde">149 kr</td></tr>' +
      "</table>";
    expect(parseItemInfo(detail)).toBe("Auktnr: SE15.A40201\nVarukategori: Guld / Övrigt\nFrakt: 149 kr");
    expect(parseItemInfo("<p>ingen tabell</p>")).toBeNull();
  });
});
