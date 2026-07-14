import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseAuctions,
  parseLots,
  stripPlus,
  slugify,
  imageUrl,
} from "../src/connectors/bidflow/client.ts";
import { mapItem, vatFromAuctionName } from "../src/connectors/bidflow/map.ts";
import { BIDFLOW_HOUSES } from "../src/connectors/bidflow/houses.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "bidflow", n), "utf8");
const SAJAB = BIDFLOW_HOUSES.find((h) => h.house === "sajab")!;

describe("Bidflow client-parsers", () => {
  it("stripPlus + slugify + imageUrl (konto ur Version-fältet)", () => {
    expect(stripPlus("+221")).toBe("221");
    expect(stripPlus(null)).toBe("");
    expect(slugify("Gårdsauktion Brännudden-Momsfri")).toBe("gardsauktion-brannudden-momsfri");
    // Kontot är bildens Version (byraneffecta), INTE byraneffecta-dev (som ger 422).
    expect(imageUrl("abc123", "byraneffecta")).toBe(
      "https://img.imageboss.me/byraneffecta/width/1600/withoutEnlargement:true/abc123",
    );
  });

  it("parseAuctions → active + history med strippade '+'-id", () => {
    const { history } = parseAuctions(fx("auctions.json"));
    expect(history.length).toBeGreaterThan(0);
    const a = history[0]!;
    expect(a.id).not.toMatch(/^\+/);
    expect(a.name.length).toBeGreaterThan(0);
    expect(a.slug).toBe(slugify(a.name));
  });

  it("parseLots → objekt med bud/reserv/bild, '+' strippat, bild-konto ur Version", () => {
    const { lots, total } = parseLots(fx("lots.json"));
    expect(lots.length).toBe(3);
    expect(total).toBeGreaterThanOrEqual(3);
    const l = lots[0]!;
    expect(l.lotId).not.toMatch(/^\+/);
    expect(l.name.length).toBeGreaterThan(0);
    expect([true, false, null]).toContain(l.reserveMet);
    if (l.images[0]) expect(l.images[0]).toContain("img.imageboss.me/byraneffecta/");
  });
});

describe("Bidflow normalisering (external, config-driven)", () => {
  const { history } = parseAuctions(fx("auctions.json"));
  const auc = history[0]!;
  const { lots } = parseLots(fx("lots.json"));

  it("mapItem: composite-id, reserv, seller ur config; utan kalibrering → external", () => {
    const it = mapItem(lots[0]!, auc, SAJAB);
    expect(it.house).toBe("sajab");
    expect(it.seller).toBe("Sajab");
    expect(it.externalId).toBe(`${lots[0]!.auctionId}-${lots[0]!.lotId}`);
    expect([null, "met", "not_met"]).toContain(it.reserveStatus);
    // Okalibrerad (feeValue null) → externalFallback: total = bud, ingen fejkad avgift.
    expect(it.feeValue).toBeNull();
    const total = computeTotal({ bid: 5000 }, feeModelFor("sajab"));
    expect(total.basis).toBe("external");
    expect(total.total).toBe(5000);
  });

  it("kalibrerad avgiftslinje → feeValue = a*bud + b, vatRate 0 (allt i avgiften)", () => {
    // Effecta Maskin verifierat 2026-07-03: 25 % provision + 30 kr slagavgift (inkl moms):
    // getProvisions(1000)=1280, (100000)=125030 → a=0.25, b=30.
    const withBid = { ...lots[0]!, currentBid: 1000 };
    const it = mapItem(withBid, auc, SAJAB, { a: 0.25, b: 30 });
    expect(it.feeValue).toBe(280);
    expect(it.vatRate).toBe(0);
    const total = computeTotal(
      { bid: 1000, sourceFeeValue: it.feeValue, sourceVatRate: it.vatRate },
      feeModelFor("sajab"),
    );
    expect(total.basis).toBe("source");
    expect(total.total).toBe(1280);
  });

  it("alla Bidflow-hus är source med external-fallback", () => {
    for (const h of BIDFLOW_HOUSES) {
      const m = feeModelFor(h.house);
      expect(m.kind).toBe("source");
      expect(m.kind === "source" && m.externalFallback).toBe(true);
    }
  });

  it("moms härleds ur auktionsnamnet", () => {
    expect(vatFromAuctionName("Gårdsauktion Brännudden-Momsfri")).toBe(0);
    expect(vatFromAuctionName("Marsauktion-Moms")).toBe(25);
    expect(vatFromAuctionName("Juniauktion")).toBeNull();
  });
});
