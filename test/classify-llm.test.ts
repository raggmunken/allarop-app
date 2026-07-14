import { describe, it, expect } from "vitest";
import { buildAttrsPrompt, buildClassifyPrompt, buildImageClassifyPrompt, parseAttrsResponse, parseClassifyResponse, validKeys } from "../src/ai/classify-llm.ts";

describe("LLM-klassning (prompt + svarsvalidering)", () => {
  it("validKeys innehåller taxonomins huvud/under-nycklar", () => {
    const keys = validKeys();
    expect(keys.has("ovrigt/diverse")).toBe(true);
    expect(keys.has("ovrigt/partier")).toBe(true);
    expect(keys.has("media/tvspel")).toBe(true);
    expect(keys.has("påhittad/nyckel")).toBe(false);
  });

  it("buildClassifyPrompt: taxonomi + numrerade objekt (titel+text+hus) + JSON-instruktion", () => {
    const p = buildClassifyPrompt([
      { title: "NES Tillbehör", desc: "Game Genie, Aladdin Deck Enhancer", house: "Kronofogden" },
      { title: "Tig tillbehör" },
    ]);
    expect(p).toContain("media/tvspel");
    expect(p).toContain('0: "NES Tillbehör"');
    expect(p).toContain("[hus: Kronofogden]");
    expect(p).toContain('1: "Tig tillbehör"');
    expect(p).toContain("JSON-array");
  });

  it("buildImageClassifyPrompt: bild N ↔ objekt N-koppling + taxonomi", () => {
    const p = buildImageClassifyPrompt([{ title: "Okänt föremål" }, { title: "Låda med saker" }]);
    expect(p).toContain("bild 1 hör till objekt 0");
    expect(p).toContain('0: "Okänt föremål"');
    expect(p).toContain("ovrigt/partier");
  });

  it("parseClassifyResponse: giltiga nycklar + antal in, skräp ut", () => {
    const text = 'Här är svaret:\n```json\n[{"i":0,"k":"media/tvspel","n":4},{"i":1,"k":"verktyg/svets"},{"i":2,"k":"hittepå/nyckel"},{"i":99,"k":"hem/husgerad-kok"},{"i":0,"k":"hem/husgerad-kok"},{"n":2,"i":3,"k":"hem/husgerad-kok"}]\n```';
    const m = parseClassifyResponse(text, 4);
    expect(m.get(0)).toEqual({ key: "media/tvspel", n: 4, attrs: null }); // dubblett för i=0 ignoreras
    expect(m.get(3)).toEqual({ key: "hem/husgerad-kok", n: 2, attrs: null }); // godtycklig nyckelordning ok
    expect(m.has(2)).toBe(false); // ogiltig nyckel kastas
    expect(m.has(99)).toBe(false); // index utanför batchen kastas
  });

  it("parseClassifyResponse: ogiltigt antal → n null; obrukbart svar → tomt", () => {
    const m = parseClassifyResponse('[{"i":0,"k":"hem/husgerad-kok","n":-3},{"i":1,"k":"hem/husgerad-kok","n":"många"}]', 2);
    expect(m.get(0)).toEqual({ key: "hem/husgerad-kok", n: null, attrs: null });
    expect(m.get(1)).toEqual({ key: "hem/husgerad-kok", n: null, attrs: null });
    expect(parseClassifyResponse("jag kan inte svara på det", 5).size).toBe(0);
    expect(parseClassifyResponse("[invalid json", 5).size).toBe(0);
  });
});

describe("parseClassifyResponse nyckel-räddning (spinn-fixen 2026-07-06)", () => {
  it("ogiltig undernyckel med giltig huvudkategori räddas till main-nivå", () => {
    const v = parseClassifyResponse('[{"i":0,"k":"elektronik/diverse","n":2},{"i":1,"k":"samla/hobby"}]', 2);
    expect(v.get(0)).toEqual({ key: "elektronik", n: 2, attrs: null });
    expect(v.get(1)).toEqual({ key: "samla", n: null, attrs: null });
  });

  it("helt påhittad huvudkategori kastas fortfarande", () => {
    const v = parseClassifyResponse('[{"i":0,"k":"rymdskepp/ufo"}]', 1);
    expect(v.size).toBe(0);
  });
});

describe("Attribut-extraktion (b/m/d/t/y/mat, 2026-07-06)", () => {
  it("parseClassifyResponse: belagda attribut följer med verdiktet", () => {
    const v = parseClassifyResponse(
      '[{"i":0,"k":"fordon/husbil-husvagn","n":1,"b":"Ford","m":"Transit 1100","t":"veteranhusbil","y":1971,"mat":"plåt"}]',
      1,
    );
    expect(v.get(0)).toEqual({
      key: "fordon/husbil-husvagn",
      n: 1,
      attrs: { b: "Ford", m: "Transit 1100", t: "veteranhusbil", y: 1971, mat: "plåt" },
    });
  });

  it("parseAttrsResponse: tom post {} = försökt utan fält; orimligt år kastas", () => {
    const v = parseAttrsResponse('[{"i":0,"b":"Marshall","y":9999},{"i":1},{"i":7}]', 2);
    expect(v.get(0)).toEqual({ b: "Marshall" }); // y=9999 ogiltigt → bort
    expect(v.get(1)).toEqual({}); // uttryckligen tomt → markeras försökt
    expect(v.has(7)).toBe(false); // utanför batchen
  });

  it("buildAttrsPrompt innehåller objektraderna + fältinstruktionen", () => {
    const p = buildAttrsPrompt([{ title: "Skåpbil Ford Transit", desc: "Årsmodell 2012" }]);
    expect(p).toContain("Skåpbil Ford Transit");
    expect(p).toContain("GISSA ALDRIG");
  });
});
