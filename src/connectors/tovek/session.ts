/**
 * Hanterar Toveks "session": Server Action-hashar, x-deployment-id och
 * router-state-tree som behövs för att återspela anrop över ren HTTP.
 *
 * Dessa värden ändras vid varje Vercel-deploy. De uppdateras helt via HTTP
 * (ingen webbläsare behövs):
 *   1. Hämta listsidans HTML → deploymentId (ur `?dpl=`-parametern) + alla
 *      JS-chunk-URL:er.
 *   2. Ladda ned chunkarna och läs ut server actions som de exponeras som
 *      `createServerReference("<hash>", …, "<funktionsnamn>")`. Slå upp aktuell
 *      hash per funktionsnamn (stabilt mellan deploys).
 *
 * De tre actions pipelinen behöver (getAuctions, getAuctionItems,
 * getRecentItemBidsByItemIds) finns alla i listsidans chunkar, så en enda
 * sidladdning räcker. Värdena cachas på disk.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ACTION_FUNCTION_NAMES,
  ACTION_HASHES,
  ActionName,
  DEFAULT_DEPLOYMENT_ID,
  PAGAENDE_PATH,
  PAGAENDE_STATE_TREE,
  TOVEK_ORIGIN,
  USER_AGENT,
} from "./actions.ts";

const CACHE_PATH = "./data/tovek-session.json";

const CHUNK_RE = /\/_next\/static\/chunks\/[A-Za-z0-9._/-]+\.js/g;
const DPL_RE = /dpl=(dpl_[A-Za-z0-9]+)/;
const ACTION_RE =
  /createServerReference\)\("([0-9a-f]+)",[a-z]\.callServer,void 0,[a-z]\.findSourceMapURL,"([A-Za-z0-9_]+)"\)/g;

interface SessionData {
  hashes: Record<string, string>;
  deploymentId: string;
  stateTree: string;
  updatedAt: string;
}

export class TovekSession {
  private hashes: Record<string, string>;
  private deploymentId: string;
  private stateTree: string;
  private loaded = false;

  constructor() {
    this.hashes = { ...ACTION_HASHES };
    this.deploymentId = DEFAULT_DEPLOYMENT_ID;
    this.stateTree = PAGAENDE_STATE_TREE;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(CACHE_PATH, "utf8");
      const data = JSON.parse(raw) as SessionData;
      this.hashes = { ...this.hashes, ...data.hashes };
      if (data.deploymentId) this.deploymentId = data.deploymentId;
      if (data.stateTree) this.stateTree = data.stateTree;
    } catch {
      // Ingen cache än — kör på frö-värden.
    }
  }

  private async save(): Promise<void> {
    const data: SessionData = {
      hashes: this.hashes,
      deploymentId: this.deploymentId,
      stateTree: this.stateTree,
      updatedAt: new Date().toISOString(),
    };
    await mkdir(dirname(CACHE_PATH), { recursive: true });
    await writeFile(CACHE_PATH, JSON.stringify(data, null, 2), "utf8");
  }

  hash(name: ActionName): string {
    return this.hashes[name] ?? ACTION_HASHES[name];
  }

  getDeploymentId(): string {
    return this.deploymentId;
  }

  getStateTree(): string {
    return this.stateTree;
  }

  private async fetchListingHtml(): Promise<string> {
    const res = await fetch(TOVEK_ORIGIN + PAGAENDE_PATH, {
      headers: { "User-Agent": USER_AGENT },
    });
    return res.text();
  }

  private deploymentIdFrom(html: string): string | null {
    return html.match(DPL_RE)?.[1] ?? null;
  }

  /**
   * Browser-fri auto-discovery: läs deploymentId + aktuella action-hashar ur
   * listsidans JS-bundles. Returnerar antal uppdaterade hashar.
   */
  async discoverViaHttp(): Promise<number> {
    await this.load();
    const html = await this.fetchListingHtml();
    return this.discoverFromHtml(html);
  }

  /** Discovery utifrån redan hämtad listsido-HTML (delas av ensureFresh). */
  private async discoverFromHtml(html: string): Promise<number> {
    const dpl = this.deploymentIdFrom(html);
    if (dpl) this.deploymentId = dpl;

    const chunkPaths = Array.from(new Set(html.match(CHUNK_RE) ?? []));
    const nameToHash = new Map<string, string>();
    await Promise.all(
      chunkPaths.map(async (path) => {
        try {
          const res = await fetch(TOVEK_ORIGIN + path, {
            headers: { "User-Agent": USER_AGENT },
          });
          const js = await res.text();
          for (const m of js.matchAll(ACTION_RE)) nameToHash.set(m[2]!, m[1]!);
        } catch {
          /* hoppa över en chunk vid fel */
        }
      }),
    );

    let updated = 0;
    for (const role of Object.keys(ACTION_FUNCTION_NAMES) as ActionName[]) {
      const found = nameToHash.get(ACTION_FUNCTION_NAMES[role]);
      if (found && this.hashes[role] !== found) {
        this.hashes[role] = found;
        updated++;
      }
    }

    await this.save();
    return updated;
  }

  /**
   * Verifiera vid uppstart att cachade hashar fortfarande gäller, annars hämta
   * nya — så vi alltid har de senaste.
   *
   * Tovek byter action-hashar BARA vid deploy, och varje deploy byter
   * x-deployment-id. Så det räcker att jämföra live deployment-id (ur
   * listsidans `?dpl=`) mot det cachade:
   *   - oförändrat → hasharna gäller, ingen chunk-nedladdning behövs.
   *   - ändrat (ny deploy) → kör full discovery och uppdatera hasharna.
   *
   * Returnerar true om en ny deploy upptäcktes och hashar uppdaterades.
   */
  async ensureFresh(): Promise<boolean> {
    await this.load();
    let html: string;
    try {
      html = await this.fetchListingHtml();
    } catch {
      return false; // nätfel → behåll cache, reaktiv refresh täcker resten
    }
    const live = this.deploymentIdFrom(html);
    if (!live || live === this.deploymentId) return false; // oförändrad deploy
    await this.discoverFromHtml(html);
    return true;
  }
}
