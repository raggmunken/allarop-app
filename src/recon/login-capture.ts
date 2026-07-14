/**
 * Inloggnings-fångst: öppnar en SYNLIG stealth-browser (CloakBrowser) där ANVÄNDAREN
 * själv loggar in och klickar runt - all icke-statisk trafik (URL, metod, request-body,
 * svarskropp) spelas in kontinuerligt, över ALLA domäner i sessionen. Vi hanterar ALDRIG
 * inloggningsuppgifter - användaren skriver dem själv i browserfönstret.
 *
 * Körs: npx tsx src/recon/login-capture.ts [start-url]
 * Avsluta: stäng browserfönstret (eller Ctrl+C) → fångsten skrivs till
 * recon-output/login-capture-<host>.json (flushas dessutom var 20 s).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SKIP_CT = /image\/|font\/|text\/css|video\/|audio\/|\.woff/i;
const DATA_CT = /json|text\/x-component|text\/html|xml|graphql|text\/plain/i;
const SKIP_URL = /google|gstatic|facebook|doubleclick|linkedin|mixpanel|hotjar|clarity|cookiebot|trustpilot|analytics|maps\./i;

interface Captured {
  at: string;
  url: string;
  method: string;
  status: number;
  contentType: string;
  postData?: string;
  bodyPreview?: string;
  bodyBytes?: number;
}

async function main(): Promise<void> {
  const startUrl = process.argv[2] ?? "https://www.budi.se/";
  let launch: ((o?: unknown) => Promise<any>) | undefined;
  try {
    ({ launch } = (await import("cloakbrowser")) as any);
  } catch (e) {
    console.error("cloakbrowser saknas:", (e as Error).message);
    process.exit(1);
  }

  const host = new URL(startUrl).host.replace(/[^a-z0-9.]/gi, "_");
  const outFile = join("recon-output", `login-capture-${host}.json`);
  await mkdir("recon-output", { recursive: true });

  const browser = await launch!({ headless: false, humanize: true });
  const captured: Captured[] = [];

  const flush = async (): Promise<void> => {
    try {
      await writeFile(outFile, JSON.stringify(captured, null, 1), "utf8");
    } catch {
      /* skrivfel - försök igen nästa flush */
    }
  };

  const page = await browser.newPage();
  page.on("response", async (res: any) => {
    try {
      const req = res.request();
      const url: string = req.url();
      const ct = (res.headers()["content-type"] ?? "").split(";")[0];
      if (SKIP_CT.test(ct) || SKIP_URL.test(url)) return;
      const rec: Captured = {
        at: new Date().toISOString(),
        url,
        method: req.method(),
        status: res.status(),
        contentType: ct,
      };
      const post = req.postData?.();
      if (post) rec.postData = String(post).slice(0, 2000);
      if (DATA_CT.test(ct)) {
        try {
          const txt = await res.text();
          rec.bodyBytes = txt.length;
          rec.bodyPreview = txt.slice(0, 4000);
        } catch {
          /* body ej läsbar (stream/avbruten) */
        }
      }
      captured.push(rec);
    } catch {
      /* ignorera enskilt svar */
    }
  });

  const timer = setInterval(flush, 20_000);
  const finish = async (): Promise<void> => {
    clearInterval(timer);
    await flush();
    console.log(`\nFångst sparad: ${outFile} (${captured.length} svar)`);
    process.exit(0);
  };
  process.on("SIGINT", () => void finish());
  browser.on?.("disconnected", () => void finish());

  console.log(`Öppnar ${startUrl} - logga in och klicka runt; ALLT spelas in.`);
  console.log(`Du kan navigera till andra sajter i samma fönster (Budi/Upplands/Retrade...).`);
  console.log(`Stäng fönstret när du är klar → ${outFile}`);
  await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});

  // Håll processen vid liv tills fönstret stängs; upptäck stängning även utan event.
  for (;;) {
    await new Promise((r) => setTimeout(r, 5_000));
    try {
      if (browser.pages && (await browser.pages()).length === 0) return void (await finish());
      if (browser.isConnected && !browser.isConnected()) return void (await finish());
    } catch {
      return void (await finish());
    }
  }
}

main();
