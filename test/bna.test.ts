import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  parseAuctions,
  parseDetail,
  parseEventObjects,
  stockholmToIso,
} from "../src/connectors/bna/client.ts";
import { mapItem } from "../src/connectors/bna/map.ts";
import { computeTotal } from "../src/fees/engine.ts";
import { feeModelFor } from "../src/fees/rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => readFileSync(join(here, "fixtures", "bna", n), "utf8");

describe("BNA parsers", () => {
  it("/auktioner → aktiva event (inkl. slug med '/' och å/ä/ö)", () => {
    const evs = parseAuctions(fx("auktioner.html"));
    expect(evs.length).toBe(6);
    // Event 323:s slug innehåller "/" ("verktyg-/-maskiner-sunne") - får ej tappas.
    const e323 = evs.find((e) => e.id === "323");
    expect(e323).toBeTruthy();
    expect(e323!.href).toBe("/auktion/2026-06-30-verktyg-/-maskiner-sunne/323");
    // Event med å/ä/ö i slug (kontorsbaracker ... kök) fångas också.
    expect(evs.map((e) => e.id)).toContain("326");
  });

  it("eventsida → objektens detalj-URL:er", () => {
    const objs = parseEventObjects(fx("event.html"));
    expect(objs.length).toBe(7);
    expect(objs[0]).toMatchObject({ itemId: "28769" });
    expect(objs[0]!.href).toContain("/auktion/objekt/");
  });

  it("eventsida med '/'+å/ä/ö i objekt-slugs → alla objekt fångas", () => {
    const objs = parseEventObjects(fx("event-slashslug.html"));
    expect(objs.length).toBe(29); // event 323 har 29 objekt
    // Objekt-slug kan innehålla "/" (t.ex. "...cs400/36...") - id ska ändå bli rätt.
    for (const o of objs) expect(o.itemId).toMatch(/^\d+$/);
  });

  it("objektsida med moms: bud, exakt sluttid, 25 % objektsmoms, bilder", () => {
    const d = parseDetail(fx("detail-moms.html"), "/auktion/objekt/byggstaket-demex/28769");
    expect(d.itemId).toBe("28769");
    expect(d.title).toBe("BYGGSTAKET DEMEX");
    expect(d.currentBid).toBe(2000);
    expect(d.vatRate).toBe(25);
    expect(d.endsAt).toBe("2026-06-30T13:00:00.000Z"); // 15:00 CEST → 13:00 UTC
    expect(d.images.length).toBeGreaterThan(1);
    // Fullstora bilder, inte thumbnails (/tn/).
    expect(d.images[0]).toMatch(/\/images\/custom\/AuctionItem\/\d+\.jpg$/);
    for (const u of d.images) expect(u).not.toContain("/tn/");
  });

  it("objektsida momsfri (fordon): 0 % objektsmoms", () => {
    const d = parseDetail(fx("detail-nomoms.html"), "/auktion/objekt/husbil-iveco/28834");
    expect(d.vatRate).toBe(0);
    expect(d.currentBid).toBeGreaterThan(0);
    expect(d.title.toLowerCase()).toContain("husbil");
  });

  it("stockholmToIso hanterar sommartid (CEST +2)", () => {
    expect(stockholmToIso("2026-07-01 14:30:00")).toBe("2026-07-01T12:30:00.000Z");
  });
});

describe("BNA avgift (12 % köpavgift + 25 % momsavgift + objektsmoms)", () => {
  it("momspliktigt: bud 2 200 → 3 080", () => {
    const b = computeTotal(
      { bid: 2200, sourceVatRate: 25 },
      feeModelFor("bna"),
    );
    expect(b.fee).toBe(264); // 12 % av 2 200
    expect(b.vat).toBe(616); // 25 % av 264 (66) + 25 % av 2 200 (550)
    expect(b.total).toBe(3080);
  });

  it("momsfritt (fordon): bud 100 000 → 115 000", () => {
    const b = computeTotal({ bid: 100000, sourceVatRate: 0 }, feeModelFor("bna"));
    expect(b.fee).toBe(12000);
    expect(b.vat).toBe(3000); // bara 25 % av köpavgiften
    expect(b.total).toBe(115000);
  });
});

describe("BNA normalisering", () => {
  it("mapItem speglar bud/moms/sluttid/säljare", () => {
    const d = parseDetail(fx("detail-moms.html"), "/auktion/objekt/byggstaket-demex/28769");
    const it = mapItem(d, "324");
    expect(it.house).toBe("bna");
    expect(it.externalId).toBe("28769");
    expect(it.auctionExternalId).toBe("324");
    expect(it.currentBid).toBe(2000);
    expect(it.vatRate).toBe(25);
    expect(it.currency).toBe("SEK");
    expect(it.seller).toBe("BNA");
    expect(it.sourceUrl).toContain("/auktion/objekt/byggstaket-demex/28769");
  });
});
