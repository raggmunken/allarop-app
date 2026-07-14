/**
 * Vaxxas serviceavgifts-action: `getProductFeeAction` är en Next.js Server Action
 * (POST /auctions/{id}, header `next-action: <hash>`, body `[productId, amount]`,
 * svar text/x-component med `"actionData":{"fee":N,"dynamic":bool}`). Hashen byts
 * vid varje deploy → browser-fri auto-discovery (Tovek-mönstret): läs en objektsidas
 * HTML → JS-chunk-URL:er → `createServerReference("<hash>", …, "getProductFeeAction")`.
 * Cachas på disk; vid trasigt svar körs discovery om en gång och anropet görs om.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const CACHE_PATH = "./data/vaxxa-session.json";
const ORIGIN = "https://app.vaxxa.se";
/** Frö-hash (2026-07-03) - används tills discovery hittar en nyare. */
const SEED_HASH = "60d9940b2aafc12985693c92cba839f338c9268e30";
const FN_NAME = "getProductFeeAction";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const CHUNK_RE = /\/_next\/static\/chunks\/[A-Za-z0-9._/-]+\.js/g;
const ACTION_RE = new RegExp(
  `createServerReference\\)?\\(\\s*"([0-9a-f]{20,})"[^)]{0,200}?"${FN_NAME}"\\s*\\)`,
  "g",
);

const DISCOVER_COOLDOWN_MS = 10 * 60_000;

export class VaxxaSession {
  private hash = SEED_HASH;
  private loaded = false;
  private lastDiscoverAt = 0;

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(CACHE_PATH, "utf8")) as { hash?: string };
      if (data.hash) this.hash = data.hash;
    } catch {
      /* ingen cache än - kör på frö-hashen */
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(
      CACHE_PATH,
      JSON.stringify({ hash: this.hash, updatedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  }

  async getHash(): Promise<string> {
    await this.load();
    return this.hash;
  }

  /**
   * Läs aktuell action-hash ur en objektsidas JS-chunkar (actionen ligger bara i
   * produktsidans bundles → discovery behöver en riktig objektsida som utgångspunkt).
   * Returnerar true om hashen ändrades.
   */
  async discover(productPath: string): Promise<boolean> {
    await this.load();
    // Cooldown: ett nätverkshickup på många objekt samtidigt får inte utlösa en
    // chunk-nedladdningsstorm - en discovery per 10 min räcker (deploys är sällsynta).
    const now = Date.now();
    if (now - this.lastDiscoverAt < DISCOVER_COOLDOWN_MS) return false;
    this.lastDiscoverAt = now;
    let html: string;
    try {
      const res = await fetch(ORIGIN + productPath, { headers: { "User-Agent": UA, Accept: "text/html" } });
      if (!res.ok) return false;
      html = await res.text();
    } catch {
      return false;
    }
    const chunks = Array.from(new Set(html.match(CHUNK_RE) ?? []));
    for (const path of chunks) {
      try {
        const res = await fetch(ORIGIN + path, { headers: { "User-Agent": UA } });
        if (!res.ok) continue;
        const js = await res.text();
        const m = ACTION_RE.exec(js);
        ACTION_RE.lastIndex = 0;
        if (m?.[1]) {
          const changed = m[1] !== this.hash;
          this.hash = m[1];
          await this.save();
          return changed;
        }
      } catch {
        /* hoppa över trasig chunk */
      }
    }
    return false;
  }
}
