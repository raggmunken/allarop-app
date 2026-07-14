import { describe, it, expect } from "vitest";
import { attrsCompatible, isComparable, lotCount, modelMatch, quotedModels } from "../src/db/similar.ts";

describe("lotCount (explicit antal ur titeln)", () => {
  it("N st, par, okänt", () => {
    expect(lotCount("CARL MALMSTEN. stolar, 4 st, björk, ”Lilla Åland”, Stolab, 1997")).toBe(4);
    expect(lotCount("Stolar, 2 st, Lilla Åland")).toBe(2);
    expect(lotCount("CARL MALMSTEN. Stolar, ett par, ”Lilla Åland”")).toBe(2);
    expect(lotCount('CARL MALMSTEN. Stolar, 4 stycken, "Lilla Åland"')).toBe(4); // "stycken"
    expect(lotCount("Skruvar, 100st.")).toBe(100);
    expect(lotCount("Stolar, Lilla Åland, Carl Malmsten")).toBeNull();
    expect(lotCount("Stol, Carl Malmsten")).toBeNull();
    expect(lotCount("Matta, 240 x 170 cm")).toBeNull(); // mått är inte antal
  });
});

describe("quotedModels (citerade modellnamn)", () => {
  it("typografiska + raka citat", () => {
    expect(quotedModels('CARL MALMSTEN. Karmstol, "Lilla Åland", Stolab')).toEqual(["Lilla Åland"]);
    expect(quotedModels("Stol, ”Eva”, Bruno Mathsson")).toEqual(["Eva"]);
    expect(quotedModels("Stolar, Lilla Åland, Carl Malmsten")).toEqual([]);
  });
});

describe("isComparable (samma objekt: antal + variant)", () => {
  const target4st = "CARL MALMSTEN. stolar, 4 st, björk, ”Lilla Åland”, Stolab, 1997";

  it("mål med känt flertal matchar BARA samma antal", () => {
    // Skärmbildens felmatchningar (2026-07-03): par/enstaka/okänt antal mot en 4 st-lott.
    expect(isComparable(target4st, 'CARL MALMSTEN (1888-1972), stolar, 4 st, "Lilla Åland"')).toBe(true);
    expect(isComparable(target4st, 'CARL MALMSTEN. Stolar, ett par, "Lilla Åland"')).toBe(false);
    expect(isComparable(target4st, 'CARL MALMSTEN (1888-1972), stolar, 2 st, "Lilla Åland"')).toBe(false);
    expect(isComparable(target4st, "Stolar, Lilla Åland, Carl Malmsten")).toBe(false); // okänt antal
    expect(isComparable(target4st, "Stola, Lilla Åland, Carl Malmsten")).toBe(false); // enstaka
  });

  it("citerad modell i målet måste finnas i jämförelsen (variant-skydd)", () => {
    // "Stol, Carl Malmsten" kan vara VILKEN Malmsten-modell som helst - inte jämförbar.
    expect(isComparable('Karmstol, "Lilla Åland", Carl Malmsten', "Stol, Carl Malmsten")).toBe(false);
    expect(isComparable('Karmstol, "Lilla Åland", Carl Malmsten', "Carl Malmsten karmstol Lilla Åland")).toBe(true);
  });

  it("modelMatch: modellnummer räcker ensamt; annars majoritet av frasens ord", () => {
    // Eames-fallet (2026-07-05): hela frasen "EA208 Soft Pad Chair" fanns aldrig i
    // historikens korta titlar → siffertoken "ea208" räcker.
    expect(modelMatch(["EA208 Soft Pad Chair"], "Eames EA208 kontorsstol Vitra")).toBe(true);
    expect(modelMatch(["EA208 Soft Pad Chair"], "Eames Soft Pad kontorsstol")).toBe(true); // 2 av 3 ord
    expect(modelMatch(["EA208 Soft Pad Chair"], "Kontorsstol Charles Eames Vitra")).toBe(false); // inget
    // "Lilla Åland" (inga siffror): kräver båda orden - "Åland karta" räcker inte.
    expect(modelMatch(["Lilla Åland"], "Karta över Åland, 1800-tal")).toBe(false);
    expect(modelMatch(["Lilla Åland"], "Stol Lilla Åland björk")).toBe(true);
  });

  it("requireModel:false (loose-passet) släpper modellkravet men inte antalsregeln", () => {
    const target = 'Charles & Ray Eames, kontorsstol, "EA208 Soft Pad Chair", Vitra';
    expect(isComparable(target, "Kontorsstol Charles Eames Vitra")).toBe(false); // strikt
    expect(isComparable(target, "Kontorsstol Charles Eames Vitra", {}, { requireModel: false })).toBe(true);
    expect(isComparable(target, "Kontorsstolar Eames, 4 st", {}, { requireModel: false })).toBe(false); // antal gäller
  });

  it("mål utan antal utesluter kända flerpack men tillåter okänt/enstaka", () => {
    expect(isComparable("Stol, Lilla Åland", "Stolar, 4 st, Lilla Åland")).toBe(false);
    expect(isComparable("Stol, Lilla Åland", "Stol, Lilla Åland, björk")).toBe(true);
  });

  it("utan citerade modeller gäller bara antalsregeln", () => {
    expect(isComparable("DeWalt DCD996 slagborrmaskin", "DeWalt DCD996 borrmaskin")).toBe(true);
    expect(isComparable("DeWalt DCD996 slagborrmaskin", "DeWalt DCD996, 2 st")).toBe(false);
  });

  it("AI-räknat antal (lot_count) går före titel-regexen", () => {
    // Titlarna säger inget om antal - men AI:n räknade 4 resp. 1 i bilderna.
    expect(isComparable("Stolar, Lilla Åland", "Stolar, Lilla Åland", { t: 4, s: 1 })).toBe(false);
    expect(isComparable("Stolar, Lilla Åland", "Stolar, Lilla Åland", { t: 4, s: 4 })).toBe(true);
    // AI-antal överröstar titelns "4 st" (t.ex. felskriven titel).
    expect(isComparable("Stolar, 4 st", "Stol", { t: 1, s: 1 })).toBe(true);
    // Ena sidan okänd → titel-regexen som förut.
    expect(isComparable("Stolar, 4 st", "Stolar, 4 st", { t: null, s: null })).toBe(true);
  });
});

describe("Attribut-gate (attrsCompatible, Transit-fallet 2026-07-06)", () => {
  it("olika typ/epok avvisas: veteranhusbil 1971 vs skåpbil 2012", () => {
    const veteran = { b: "Ford", m: "Transit 1100", t: "veteranhusbil", y: 1971 };
    const modern = { b: "Ford", m: "Transit", t: "skåpbil", y: 2012 };
    expect(attrsCompatible(veteran, modern)).toBe(false); // typ OCH epok skiljer
    expect(isComparable("Husbil veteran FORD TRANSIT 1100", "Skåpbil Ford Transit", {}, { attrs: { t: veteran, s: modern } })).toBe(false);
    // Gaten håller även i loose-passet (requireModel:false).
    expect(isComparable("Husbil veteran FORD TRANSIT 1100", "Skåpbil Ford Transit", {}, { requireModel: false, attrs: { t: veteran, s: modern } })).toBe(false);
  });

  it("olika märken avvisas; substring-modell är förenlig; saknade fält avvisar aldrig", () => {
    expect(attrsCompatible({ b: "Marshall" }, { b: "Fender" })).toBe(false);
    expect(attrsCompatible({ b: "Ford", m: "Transit 1100" }, { b: "Ford", m: "Transit" })).toBe(true); // substring ok
    expect(attrsCompatible({ b: "Ford" }, {})).toBe(true); // tomma attrs → ingen gate
    expect(attrsCompatible(null, { b: "Ford" })).toBe(true);
    expect(attrsCompatible({ y: 1971 }, { y: 1985 })).toBe(true); // 14 år ≤ 20 → ok
    expect(attrsCompatible({ y: 1971 }, { y: 2012 })).toBe(false); // olika epoker
  });

  it("material gatar INTE (silver ⊂ nysilver-fällan)", () => {
    expect(attrsCompatible({ mat: "silver" }, { mat: "trä" })).toBe(true);
  });
});
