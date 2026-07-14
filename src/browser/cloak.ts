/**
 * Återanvändbar stealth-browser (CloakBrowser) för sajter bakom Cloudflare/bot-
 * management som fingeravtryckar vanliga HTTP-klienter (t.ex. Blinto: Node-fetch
 * och curl kan blockas, men en riktig stealth-Chromium släpps igenom). Detta är
 * STANDARDVÄGEN för all browser-/bot-skyddad åtkomst (användarens beslut: säkrast).
 *
 * En enda browser-instans startas lazy och återanvänds (billigt per sida). I CLI
 * stängs den via `closeBrowser()`; i schemaläggaren lever den med processen.
 * Kräver paketet "cloakbrowser" (laddar ~535 MB stealth-Chromium första gången).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
let browserPromise: Promise<any> | null = null;

async function getBrowser(): Promise<any> {
  if (!browserPromise) {
    browserPromise = (async () => {
      let launch: ((o?: unknown) => Promise<any>) | undefined;
      try {
        ({ launch } = (await import("cloakbrowser")) as any);
      } catch {
        throw new Error(
          "cloakbrowser saknas. Installera med `npm i cloakbrowser` (krävs för " +
            "browser-/Cloudflare-skyddade hus som Blinto).",
        );
      }
      return launch!({ humanize: true, headless: true });
    })();
  }
  return browserPromise;
}

export interface BrowserFetchOptions {
  /** "domcontentloaded" (default) eller "networkidle" om data laddas via JS. */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  /** Extra väntan (ms) efter navigering, t.ex. för Cloudflare-JS eller XHR. */
  dwellMs?: number;
  /** Timeout per navigering (ms). */
  timeoutMs?: number;
}

/** Hämta en sidas FÄRDIGRENDERADE HTML via stealth-browsern. */
export async function browserFetch(
  url: string,
  opts: BrowserFetchOptions = {},
): Promise<string> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(url, {
      waitUntil: opts.waitUntil ?? "domcontentloaded",
      timeout: opts.timeoutMs ?? 45_000,
    });
    if (opts.dwellMs) await page.waitForTimeout?.(opts.dwellMs);
    return await page.content();
  } finally {
    await page.close?.().catch(() => {});
  }
}

export interface BrowserApiRequest {
  path: string; // absolut path på origin, t.ex. "/include/httprequest_4MaxBid?id=1"
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Kör en uppsättning in-page `fetch`-anrop från en session-sida på `origin`.
 * Eftersom de görs i den riktiga (Cloudflare-godkända) browsern bär de cf-cookien
 * och slipper fingeravtryck — men utan att rendera en sida per anrop (snabbt: en
 * XHR ~100-300 ms i stället för ~4 s sidladdning). Returnerar svarstexterna i
 * inskickad ordning (null vid fel). Batchas internt med begränsad samtidighet.
 *
 * Används för Blintos live-data-API (4MaxBid/getAuctionData) i stället för att
 * rendera ~950 objektsidor.
 */
export async function browserApi(
  origin: string,
  requests: BrowserApiRequest[],
  opts: { concurrency?: number; sessionPath?: string; chunk?: number } = {},
): Promise<(string | null)[]> {
  if (requests.length === 0) return [];
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.goto(`${origin}${opts.sessionPath ?? "/"}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout?.(800);
    const concurrency = opts.concurrency ?? 6;
    const chunk = opts.chunk ?? 200;
    const out: (string | null)[] = [];
    for (let i = 0; i < requests.length; i += chunk) {
      const slice = requests.slice(i, i + chunk);
      // OBS: callbacken serialiseras till browsern → använd BARA inline anonyma
      // arrow-funktioner (inga namngivna funktioner), annars injicerar esbuild/tsx
      // en `__name`-hjälpare som inte finns i sidkontexten ("__name is not defined").
      // Samtidighet via batchad Promise.all i stället för en namngiven worker-pool.
      const res: (string | null)[] = await page.evaluate(
        async ({ reqs, conc }: { reqs: BrowserApiRequest[]; conc: number }) => {
          const results: (string | null)[] = new Array(reqs.length).fill(null);
          for (let i = 0; i < reqs.length; i += conc) {
            const batch = reqs.slice(i, i + conc);
            const settled = await Promise.all(
              batch.map((r) =>
                fetch(r.path, { method: r.method ?? "GET", headers: r.headers, body: r.body })
                  .then((resp) => resp.text())
                  .catch(() => null),
              ),
            );
            for (let j = 0; j < settled.length; j++) results[i + j] = settled[j] ?? null;
          }
          return results;
        },
        { reqs: slice, conc: concurrency },
      );
      out.push(...res);
    }
    return out;
  } finally {
    await page.close?.().catch(() => {});
  }
}

/** Stäng browsern (CLI/avslut). Säker att anropa även om den aldrig startades. */
export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    const browser = await p;
    await browser.close?.();
  } catch {
    /* redan stängd / aldrig startad */
  }
}
