import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import { parseList, parseCountdown, parseDetail } from "../src/connectors/kronofogden/client.ts";
import { mapItem } from "../src/connectors/kronofogden/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "kronofogden", n), "utf8");
const NOW = new Date("2026-06-28T22:00:00Z");

describe("Kronofogden listparser (renderad Auction2000-DOM)", () => {
  const items = parseList(fx("list.html"), NOW);

  it("plockar alla objekt med id/inA/inO/titel/varunr/plats/bild", () => {
    expect(items.length).toBeGreaterThan(40);
    const v = items[0]!;
    expect(v.objId).toMatch(/^\d+$/);
    expect(v.inA).toMatch(/^\d+_\d+$/);
    expect(v.inO).toMatch(/^\d+$/);
    expect(v.title).toContain("Gipslift");
    expect(v.varunr).toBe("F106066");
    expect(v.location).toContain("Bredared");
    expect(v.image).toMatch(/auction2000\.online.*114170_1\.jpg$/);
    expect(v.image).not.toContain("_thumb");
  });

  it("läser Utrop (värdering) + Startpris (inga bud) ELLER Högsta bud (bud finns)", () => {
    const gips = items.find((i) => i.objId === "114170")!;
    expect(gips.estimate).toBe(50000);
    expect(gips.startBid).toBe(12000); // inga bud → startpris
    expect(gips.currentBid).toBeNull();

    const dacia = items.find((i) => i.title.includes("Dacia"))!;
    expect(dacia.currentBid).toBe(37000); // Högsta bud
    expect(dacia.startBid).toBeNull();

    // ALLA objekt har ett pris (startpris eller bud).
    expect(items.every((i) => i.startBid != null || i.currentBid != null)).toBe(true);
  });

  it("beräknar sluttid ur nedräkningen (nu + offset)", () => {
    expect(items.every((i) => i.endsAt != null)).toBe(true);
    // "10 tim 46 minuter" från NOW → 2026-06-29 08:46Z
    expect(items[0]!.endsAt).toBe("2026-06-29T08:46:00.000Z");
  });
});

describe("Kronofogden nedräkning → sluttid", () => {
  it("dygn/tim/min/sek", () => {
    expect(parseCountdown("3 dygn 2 tim", NOW)).toBe("2026-07-02T00:00:00.000Z");
    expect(parseCountdown("5 minuter 12 sekunder", NOW)).toBe("2026-06-28T22:05:12.000Z");
    expect(parseCountdown("45 minuter", NOW)).toBe("2026-06-28T22:45:00.000Z");
  });
  it("tom/avslutad → null", () => {
    expect(parseCountdown("", NOW)).toBeNull();
    expect(parseCountdown("Avslutad", NOW)).toBeNull();
  });
});

describe("Kronofogden objektsida (statisk SSR)", () => {
  const d = parseDetail(fx("detail.html"), "114170", "20260615_1158");

  it("läser objektets beskrivning ur margin-top-blocket (ej rubrik-baserat)", () => {
    expect(d.description).toContain("Lyftverktyger");
    expect(d.description).toContain("Maximalbelastning 1500 kg");
    // Kronofogdens standard-disclaimer (frakt/skick/moms) ska vara bortklippt.
    expect(d.description).not.toMatch(/Vi säljer all egendom|erbjuda frakt|momspliktig/i);
  });

  it("galleri full storlek (ej thumb)", () => {
    expect(d.images.length).toBeGreaterThan(0);
    for (const u of d.images) expect(u).not.toContain("_thumb");
  });
});

describe("Kronofogden avgift: inga avgifter → total = bud", () => {
  const items = parseList(fx("list.html"), NOW);

  it("mapItem: source-läge, feeValue 0, vatRate 0; total = bud", () => {
    const dacia = items.find((i) => i.title.includes("Dacia"))!;
    const it = mapItem(dacia, null, NOW);
    expect(it.house).toBe("kronofogden");
    expect(it.seller).toBe("Kronofogden");
    expect(it.currentBid).toBe(37000);
    expect(it.feeValue).toBe(0);
    expect(it.vatRate).toBe(0);
    const total = computeTotal({ bid: 37000, sourceFeeValue: 0, sourceVatRate: 0 }, feeModelFor("kronofogden"));
    expect(total.total).toBe(37000); // inga avgifter tillkommer
  });

  it("objekt utan bud visar startpris som minBid", () => {
    const gips = items.find((i) => i.objId === "114170")!;
    const it = mapItem(gips, null, NOW);
    expect(it.currentBid).toBeNull();
    expect(it.minBid).toBe(12000);
  });
});
