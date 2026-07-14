import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseList, parseDetail } from "../src/connectors/retrade/client.ts";
import { mapItem } from "../src/connectors/retrade/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "retrade", n), "utf8");

describe("Retrade list-API (public-list)", () => {
  const { items, totalPages } = parseList(fx("list.json"));

  it("läser objekt med id, titel, bud, valuta, plats, sluttid (ISO UTC) och sidor", () => {
    expect(items.length).toBe(50);
    expect(totalPages).toBeGreaterThan(1);
    const v = items[0]!;
    expect(v.id).toBe("143294");
    expect(v.heading).toContain("Comacchio");
    expect(v.highestBid).toBe(28000);
    expect(v.currency).toBe("SEK");
    expect(v.place).toBe("Västerås");
    expect(v.auctionEnd).toBe("2026-06-30T11:00:00.000Z");
  });
});

describe("Retrade detalj-API", () => {
  const d = parseDetail(fx("detail.json"))!;

  it("läser beskrivning (fritext + svenska specar), galleri, status, antal bud, minbud", () => {
    expect(d.description).toContain("Comacchio"); // säljarens fritext
    expect(d.description).toContain("Märke: Comacchio"); // product_information, sv-etikett
    expect(d.description).toMatch(/Modell och märke|Fysisk beskrivning/); // gruppnamn på sv
    expect(d.images.length).toBeGreaterThan(10);
    for (const u of d.images) expect(u).toMatch(/^https:\/\/.*assetfront/);
    expect(d.hasEnded).toBe(false);
    expect(d.bidCount).toBe(14);
    expect(d.lowestValidBid).toBe(30000);
  });
});

describe("Retrade avgift = external-läge (avgift ej beräkningsbar)", () => {
  it("visar budet, ingen fejkad total, basis 'external'", () => {
    const b = computeTotal({ bid: 28000, sourceFeeValue: null, sourceVatRate: null }, feeModelFor("retrade"));
    expect(b.fee).toBe(0);
    expect(b.vat).toBe(0);
    expect(b.total).toBe(28000); // = budet (avgift + moms tillkommer, markeras i UI)
    expect(b.basis).toBe("external");
  });
});

describe("Retrade normalisering (list + detalj)", () => {
  const v = parseList(fx("list.json")).items[0]!;
  const d = parseDetail(fx("detail.json"));
  const now = new Date("2026-06-28T00:00:00Z");

  it("mapItem speglar bud/sluttid/galleri/beskrivning, moms okänd (null)", () => {
    const it = mapItem(v, d, now);
    expect(it.house).toBe("retrade");
    expect(it.externalId).toBe("143294");
    expect(it.currentBid).toBe(28000);
    expect(it.minBid).toBe(30000);
    expect(it.endsAt).toBe("2026-06-30T11:00:00.000Z");
    expect(it.status).toBe("active");
    expect(it.vatRate).toBeNull(); // okänd → external
    expect(it.feeValue).toBeNull();
    expect(it.seller).toBe("Retrade");
    expect(it.media.length).toBeGreaterThan(10);
    expect(it.description).toContain("Comacchio");
  });
});
