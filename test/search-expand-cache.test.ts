import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// expandQuery talar med Postgres (pool) och OpenRouter (callLlm) - båda mockas så vi kan
// testa KONTROLLFLÖDET (negativ cache + timeout) utan DB/nätverk. parseExpansion och
// buildExpandPrompt körs på riktigt (rena funktioner).
const queryMock = vi.fn();
const callLlmMock = vi.fn();

vi.mock("../src/db/pool.ts", () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));
vi.mock("../src/ai/classify-llm.ts", () => ({
  callLlm: (...args: unknown[]) => callLlmMock(...args),
}));

const { expandQuery } = await import("../src/ai/search-expand.ts");

/** Rutta pool.query: SELECT = cache-uppslag (givna rader), allt annat (INSERT) = tomt. */
function routeQuery(cacheRows: unknown[]) {
  queryMock.mockImplementation((sql: string) =>
    /^\s*SELECT/i.test(sql) ? Promise.resolve({ rows: cacheRows }) : Promise.resolve({ rows: [] }),
  );
}

const inserts = () => queryMock.mock.calls.filter((c) => /INSERT/i.test(c[0] as string));

describe("expandQuery: negativ cache (betala LLM-rundan EN gång)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    callLlmMock.mockReset();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("LLM svarar men svaret är oparsbart → cacha TOM expansion + returnera tom", async () => {
    routeQuery([]); // cache-miss
    callLlmMock.mockResolvedValue("kan tyvärr inte svara på det"); // ingen JSON → parseExpansion null

    const exp = await expandQuery("klocka");

    expect(exp).toEqual({ synonyms: [], related: [], categories: [] });
    expect(inserts()).toHaveLength(1); // en tom rad skrevs
    expect(inserts()[0]![1]).toEqual(["klocka", [], [], [], expect.any(String)]);
  });

  it("cache-träff på tom rad → ingen LLM-runda, ingen ny skrivning (fast path)", async () => {
    routeQuery([{ synonyms: [], related: [], categories: [] }]); // negativ cache-träff

    const exp = await expandQuery("klocka");

    expect(exp).toEqual({ synonyms: [], related: [], categories: [] });
    expect(callLlmMock).not.toHaveBeenCalled();
    expect(inserts()).toHaveLength(0);
  });

  it("lyckad expansion cachas som förr (ingen regression)", async () => {
    routeQuery([]);
    callLlmMock.mockResolvedValue('{"synonyms":["ho","vask"],"related":["blandare"],"categories":[]}');

    const exp = await expandQuery("diskho");

    expect(exp).toEqual({ synonyms: ["ho", "vask"], related: ["blandare"], categories: [] });
    expect(inserts()[0]![1]).toEqual(["diskho", ["ho", "vask"], ["blandare"], [], expect.any(String)]);
  });
});

describe("expandQuery: timeout (aldrig blockera sökningen)", () => {
  beforeEach(() => {
    queryMock.mockReset();
    callLlmMock.mockReset();
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("skickar en AbortSignal till callLlm (timeout-skydd finns)", async () => {
    routeQuery([]);
    callLlmMock.mockResolvedValue('{"synonyms":["ur"],"related":[],"categories":[]}');

    await expandQuery("armbandsur");

    expect(callLlmMock).toHaveBeenCalledTimes(1);
    expect(callLlmMock.mock.calls[0]![1]).toBeInstanceOf(AbortSignal);
  });

  it("hängande modell → deadline avbryter, returnerar null UTAN cache-skrivning (försök igen)", async () => {
    vi.stubEnv("SEARCH_EXPAND_TIMEOUT_MS", "20"); // kort deadline → snabbt test
    routeQuery([]);
    // Riktiga callModels fångar AbortError och returnerar null när fetch avbryts av signalen.
    // Utan signal (nuvarande buggiga kod) hänger anropet för evigt - precis det vi fixar.
    callLlmMock.mockImplementation(
      (_prompt: string, signal?: AbortSignal) =>
        new Promise<string | null>((resolve) => {
          if (!signal) return; // ingen deadline → häng
          if (signal.aborted) return resolve(null);
          signal.addEventListener("abort", () => resolve(null));
        }),
    );

    const raced = await Promise.race([
      expandQuery("guldklocka"),
      new Promise((r) => setTimeout(() => r("HANG"), 400)),
    ]);

    expect(raced).toBeNull(); // löste inom deadline (20 ms), inte "HANG" (400 ms)
    expect(inserts()).toHaveLength(0); // timeout = transient → cacha ALDRIG
  });
});
