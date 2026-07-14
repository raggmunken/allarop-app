/**
 * HTTP-replay av Toveks Next.js Server Actions. Bygger rätt headers, postar
 * JSON-body som text/plain, parsar Flight-svaret och returnerar action-
 * resultatet. Vid fel som tyder på utgången hash/deploy görs en session-refresh
 * och ett omförsök.
 */

import { getActionResult } from "./flight.ts";
import {
  ActionName,
  PAGAENDE_PATH,
  TOVEK_ORIGIN,
  USER_AGENT,
} from "./actions.ts";
import { TovekSession } from "./session.ts";

export interface TovekClientOptions {
  /** Min millisekunder mellan anrop (artighet/anti-block). Default 400 ms. */
  minDelayMs?: number;
}

export class TovekClient {
  readonly session: TovekSession;
  private readonly minDelayMs: number;
  private lastCallAt = 0;

  constructor(session: TovekSession, opts: TovekClientOptions = {}) {
    this.session = session;
    this.minDelayMs = opts.minDelayMs ?? 400;
  }

  private async throttle(): Promise<void> {
    const wait = this.lastCallAt + this.minDelayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }

  /**
   * Anropa en Server Action. `path` är sid-URL:en actionen hör till (Tovek
   * accepterar listsidan för flera actions). Body är JSON-arrayen som text.
   */
  private async call(
    action: ActionName,
    body: unknown,
    path = PAGAENDE_PATH,
    attempt = 0,
  ): Promise<unknown> {
    await this.session.load();
    await this.throttle();

    const url = TOVEK_ORIGIN + path;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": this.session.hash(action),
        "next-router-state-tree": this.session.getStateTree(),
        "user-agent": USER_AGENT,
        referer: url,
        "x-deployment-id": this.session.getDeploymentId(),
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    const looksValid =
      res.ok &&
      (res.headers.get("content-type") ?? "").includes("text/x-component") &&
      text.startsWith("0:");

    if (!looksValid) {
      if (attempt === 0) {
        // Troligen ny deploy → upptäck nya hashar/deploy-id via HTTP, försök igen.
        await this.session.discoverViaHttp();
        return this.call(action, body, path, attempt + 1);
      }
      throw new Error(
        `Tovek-action "${action}" misslyckades: HTTP ${res.status}, ` +
          `content-type=${res.headers.get("content-type")}, ` +
          `body[0..80]=${text.slice(0, 80)}`,
      );
    }

    return getActionResult(text);
  }

  /** Lista parts (auktionssektioner). */
  async listParts(opts: {
    offset?: number;
    limit?: number;
    status?: "running" | "ended" | "upcoming";
    sort?: "asc" | "desc";
  } = {}): Promise<TovekPartRaw[]> {
    const body = [
      {
        offset: opts.offset ?? 0,
        limit: opts.limit ?? 100,
        sort: { partAuctionStart: opts.sort ?? "asc" },
        filter: {},
        partStatus: opts.status ?? "running",
      },
    ];
    const res = (await this.call("listParts", body)) as {
      auctions?: TovekPartRaw[];
      totalHits?: number;
    } | null;
    return res?.auctions ?? [];
  }

  /** Antal parts för ett status (totalHits) — för backfill-planering. */
  async countParts(status: "running" | "ended" | "upcoming"): Promise<number> {
    const body = [{ offset: 0, limit: 1, sort: { partAuctionStart: "desc" }, filter: {}, partStatus: status }];
    const res = (await this.call("listParts", body)) as { totalHits?: number } | null;
    return res?.totalHits ?? 0;
  }

  /** Hämta items (rop) inom en part. */
  async listItems(partId: number, offset = 0, limit = 200): Promise<TovekItemRaw[]> {
    const body = [partId, { offset, limit }, null, null];
    const res = (await this.call("partItems", body)) as {
      auctionItems?: TovekItemRaw[];
    } | null;
    return res?.auctionItems ?? [];
  }

  /** Hämta budhistorik för ett item (sorterat fallande, högsta först). */
  async listBids(itemId: number, offset = 0): Promise<TovekBidRaw[]> {
    const map = await this.listItemBids([itemId], offset);
    return map.get(itemId)?.bids ?? [];
  }

  /**
   * Hämta bud för FLERA items i ETT anrop (getRecentItemBidsByItemIds).
   * Returnerar per item: budhistorik + aktuell sluttid + servertid — det
   * sistnämnda behövs för soft-close (avslut = serverTime passerat endTime).
   */
  async listItemBids(
    itemIds: number[],
    offset = 0,
  ): Promise<Map<number, ItemBidsResult>> {
    const out = new Map<number, ItemBidsResult>();
    if (itemIds.length === 0) return out;
    // Tredje argumentet är ett slumptal i klienten (cache-buster); fast värde ok.
    const body = [itemIds, offset, "0.0"];
    const res = (await this.call("itemBids", body)) as {
      allItemBids?: Array<{
        itemId: number;
        itemEndTime?: string;
        serverTime?: string;
        bids?: TovekBidRaw[];
      }>;
    } | null;
    for (const e of res?.allItemBids ?? []) {
      out.set(e.itemId, {
        bids: e.bids ?? [],
        endTime: e.itemEndTime ?? null,
        serverTime: e.serverTime ?? null,
      });
    }
    return out;
  }
}

export interface ItemBidsResult {
  bids: TovekBidRaw[];
  /** Aktuell sluttid (flyttas framåt av sena bud — soft close). */
  endTime: string | null;
  /** Toveks servertid vid svaret (för att avgöra verkligt avslut). */
  serverTime: string | null;
}

/* ---- Råtyper som speglar Toveks fält (delmängd vi bryr oss om) ---- */

export interface TovekMediaRaw {
  type: "image" | "video";
  url: string;
  sort: number;
}

export interface TovekPartRaw {
  partId: number;
  partAuctionId: number;
  partTitle: string;
  partDescription?: string;
  partLocation?: string;
  partCategory?: string;
  partAuctionStart?: string;
  partStatus?: string;
  auctionId: number;
  auctionTitle?: string;
  auctionDescription?: string;
  auctionContactDescription?: string;
  auctionLastPayDate?: string;
  itemLastEndDate?: string;
  media?: TovekMediaRaw[];
  images?: string[];
  videos?: string[];
}

export interface TovekAddressRaw {
  addressShowingStart?: string;
  addressShowingEnd?: string;
  addressCollectStart?: string;
  addressCollectEnd?: string;
}

export interface TovekItemRaw {
  itemId: number;
  itemSortNo?: number;
  itemTitle?: string;
  itemMinBid?: number;
  itemStatus?: string;
  itemDescription?: string;
  itemEndTime?: string;
  itemVatValue?: number;
  itemFeeValue?: number;
  itemPartId?: number;
  itemAuctionId?: number;
  itemWinningBidValue?: number | null;
  itemLocation?: string[];
  itemShowingAddress?: string;
  itemCollectAddress?: string;
  itemFreightHelp?: string;
  itemForkliftHelp?: string;
  itemYoutubeLink?: string | null;
  address?: TovekAddressRaw;
  media?: TovekMediaRaw[];
  images?: string[];
  videos?: string[];
}

export interface TovekBidRaw {
  historyBidId: number;
  historyBidType?: string;
  historyBidValue: number;
  historyBidItemId: number;
  historyBidCreated: string;
  historyBidUserId?: number;
  historyBidUsername?: string;
  historyBidOverbid?: string;
  totalHits?: number;
}
