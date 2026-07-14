/**
 * Verifieringsverktyg för recon-svepet. Använder CloakBrowser (stealth) för att
 * besöka en eller flera URL:er, fånga ALLA icke-statiska anrop MED svarskroppar,
 * och skriva ut vad sajten faktiskt skickar. Syftet: bekräfta datamekanismen med
 * RIKTIG data (inte gissa) även när sajten har bot-/Cloudflare-skydd.
 *
 * Körs: npx tsx src/recon/verify.ts <url> [url2 ...]
 * Skriver fångst till recon-output/<host>-verify.json
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SKIP_CT = /image\/|font\/|text\/css|video\/|audio\/|\.woff/i;
const DATA_CT = /json|text\/x-component|text\/html|xml|graphql/i;

interface Captured {
  url: string;
  method: string;
  status: number;
  contentType: string;
  bodyPreview?: string;
  bodyBytes?: number;
}

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error("Användning: tsx src/recon/verify.ts <url> [url2 ...]");
    process.exit(1);
  }

  let launch: ((o?: unknown) => Promise<any>) | undefined;
  try {
    ({ launch } = (await import("cloakbrowser")) as any);
  } catch (e) {
    console.error("cloakbrowser saknas:", (e as Error).message);
    process.exit(1);
  }

  const browser = await launch!({ headless: true, humanize: true });
  const captured: Captured[] = [];
  try {
    const page = await browser.newPage();

    page.on("response", async (res: any) => {
      try {
        const req = res.request();
        const ct = (res.headers()["content-type"] ?? "").split(";")[0];
        if (SKIP_CT.test(ct)) return;
        const rec: Captured = {
          url: req.url(),
          method: req.method(),
          status: res.status(),
          contentType: ct,
        };
        if (DATA_CT.test(ct)) {
          try {
            const txt = await res.text();
            rec.bodyBytes = txt.length;
            rec.bodyPreview = txt.slice(0, 600);
          } catch {
            /* body ej läsbar */
          }
        }
        captured.push(rec);
      } catch {
        /* ignorera enskilt svar */
      }
    });

    for (const url of urls) {
      console.log(`\n=== Navigerar: ${url} ===`);
      try {
        const resp = await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
        await page.waitForTimeout?.(2500);
        const finalUrl = page.url();
        const title = await page.title().catch(() => "");
        const html = await page.content().catch(() => "");
        console.log(`  → slut-URL: ${finalUrl}`);
        console.log(`  → titel: ${title}`);
        console.log(`  → HTML-status: ${resp?.status()}, HTML-storlek: ${html.length} tecken`);
        await mkdir("recon-output", { recursive: true });
        const safe = url.replace(/[^a-z0-9]/gi, "_").slice(0, 80);
        await writeFile(join("recon-output", `${safe}.html`), html, "utf8");
      } catch (e) {
        console.log(`  ! navigeringsfel: ${(e as Error).message}`);
      }
    }

    // Sammanfatta intressanta (data-bärande) anrop.
    const data = captured.filter((c) => DATA_CT.test(c.contentType) && !/google|cookiebot|trustpilot|analytics|cdn-cgi/.test(c.url));
    console.log(`\n=== Data-bärande svar (${data.length}) ===`);
    for (const c of data.slice(0, 25)) {
      console.log(`\n[${c.status}] ${c.method} ${c.url}`);
      console.log(`  ct=${c.contentType} bytes=${c.bodyBytes ?? "-"}`);
      if (c.bodyPreview) console.log("  body:", c.bodyPreview.replace(/\s+/g, " ").slice(0, 400));
    }

    await mkdir("recon-output", { recursive: true });
    const host = new URL(urls[0]!).host.replace(/[^a-z0-9.]/gi, "_");
    const file = join("recon-output", `${host}-verify.json`);
    await writeFile(file, JSON.stringify(captured, null, 2), "utf8");
    console.log(`\nFull fångst: ${file} (${captured.length} svar)`);
  } finally {
    await browser.close?.();
  }
}

main();
