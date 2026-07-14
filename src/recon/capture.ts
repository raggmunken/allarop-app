/**
 * Recon-harness: kör CloakBrowser mot en sajt och spelar in ALL nätverkstrafik
 * (requests + responses) till en strukturerad "site-profile". Det här är det
 * återanvändbara verktyget för att kartlägga en ny auktionssajt innan man
 * skriver en connector — den automatiserade versionen av HAR-filerna i `tovek/`.
 *
 * Kräver paketet "cloakbrowser" (lazy import). Utan det loggas en instruktion.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface CapturedRequest {
  url: string;
  method: string;
  resourceType?: string;
  headers: Record<string, string>;
  postData?: string | null;
  status?: number;
  responseContentType?: string;
  responseSize?: number;
}

export interface SiteProfile {
  target: string;
  startedAt: string;
  visited: string[];
  requests: CapturedRequest[];
}

export interface ReconOptions {
  /** Sidor att besöka för att trigga API-anrop. */
  paths?: string[];
  /** Vänta så här länge (ms) på varje sida. */
  dwellMs?: number;
  /** Var profilen skrivs. */
  outDir?: string;
}

/**
 * Spela in trafik från `origin` (t.ex. "https://tovek.se") över angivna paths.
 * Returnerar profilen och skriver den till disk.
 */
export async function reconSite(
  origin: string,
  opts: ReconOptions = {},
): Promise<SiteProfile> {
  const paths = opts.paths ?? ["/"];
  const dwellMs = opts.dwellMs ?? 3000;
  const outDir = opts.outDir ?? "./recon-output";

  let launch: ((o?: unknown) => Promise<any>) | undefined;
  try {
    ({ launch } = (await import("cloakbrowser")) as any);
  } catch {
    throw new Error(
      "cloakbrowser saknas. Installera med `npm i cloakbrowser` för att köra recon.",
    );
  }

  const profile: SiteProfile = {
    target: origin,
    startedAt: new Date().toISOString(),
    visited: [],
    requests: [],
  };

  const browser = await launch!({ humanize: true, headless: true });
  try {
    const page = await browser.newPage();
    const byUrl = new Map<string, CapturedRequest>();

    page.on("request", (req: any) => {
      const rec: CapturedRequest = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType?.(),
        headers: req.headers(),
        postData: req.postData?.() ?? null,
      };
      byUrl.set(req.url() + "#" + profile.requests.length, rec);
      profile.requests.push(rec);
    });

    page.on("response", (res: any) => {
      try {
        const req = res.request();
        const match = profile.requests.find(
          (r) => r.url === req.url() && r.status === undefined,
        );
        if (match) {
          match.status = res.status();
          const h = res.headers();
          match.responseContentType = h["content-type"];
          const len = h["content-length"];
          if (len) match.responseSize = Number(len);
        }
      } catch {
        /* ignorera */
      }
    });

    for (const p of paths) {
      const url = origin.replace(/\/$/, "") + p;
      profile.visited.push(url);
      await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout?.(dwellMs);
    }

    await mkdir(outDir, { recursive: true });
    const host = new URL(origin).host.replace(/[^a-z0-9.]/gi, "_");
    const file = join(outDir, `${host}.profile.json`);
    await writeFile(file, JSON.stringify(profile, null, 2), "utf8");
    console.log(
      `Recon klar: ${profile.requests.length} requests från ${profile.visited.length} sidor → ${file}`,
    );
  } finally {
    await browser.close?.();
  }

  return profile;
}

/** Gruppera och summera fångade endpoints (enkel analys). */
export function summarizeProfile(profile: SiteProfile): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of profile.requests) {
    try {
      const u = new URL(r.url);
      const key = `${r.method} ${u.host}${u.pathname}`;
      counts[key] = (counts[key] ?? 0) + 1;
    } catch {
      /* ignorera */
    }
  }
  return counts;
}
