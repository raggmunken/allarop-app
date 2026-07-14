/**
 * TovekConnector — implementerar det sajt-agnostiska Connector-kontraktet
 * ovanpå HTTP-replay-klienten och normaliseringen.
 */

import {
  Connector,
  ItemPollResult,
  ListPartsOptions,
  NormalizedBid,
  NormalizedItem,
  NormalizedPart,
} from "../types.ts";
import { TovekClient, TovekClientOptions } from "./client.ts";
import { TovekSession } from "./session.ts";
import { HOUSE, mapBid, mapItem, mapPart } from "./map.ts";

export { HOUSE } from "./map.ts";

export class TovekConnector implements Connector {
  readonly house = HOUSE;
  readonly client: TovekClient;

  constructor(opts: TovekClientOptions = {}) {
    this.client = new TovekClient(new TovekSession(), opts);
  }

  async listParts(opts: ListPartsOptions = {}): Promise<NormalizedPart[]> {
    const raw = await this.client.listParts({
      offset: opts.offset,
      limit: opts.limit,
      status: opts.status ?? "running",
      sort: opts.sort,
    });
    return raw.map(mapPart);
  }

  async listItems(partExternalId: string): Promise<NormalizedItem[]> {
    const raw = await this.client.listItems(Number(partExternalId));
    return raw.map(mapItem);
  }

  async listBids(itemExternalId: string): Promise<NormalizedBid[]> {
    const raw = await this.client.listBids(Number(itemExternalId));
    return raw.map(mapBid);
  }

  async listBidsForItems(
    itemExternalIds: string[],
  ): Promise<Map<string, NormalizedBid[]>> {
    const rawMap = await this.client.listItemBids(itemExternalIds.map(Number));
    const out = new Map<string, NormalizedBid[]>();
    for (const [itemId, r] of rawMap) {
      out.set(String(itemId), r.bids.map(mapBid));
    }
    return out;
  }

  async pollItems(
    itemExternalIds: string[],
  ): Promise<Map<string, ItemPollResult>> {
    const rawMap = await this.client.listItemBids(itemExternalIds.map(Number));
    const out = new Map<string, ItemPollResult>();
    for (const [itemId, r] of rawMap) {
      // Verkligt avslut: servertid har passerat (den ev. förlängda) sluttiden.
      const ended =
        r.serverTime != null &&
        r.endTime != null &&
        new Date(r.serverTime.replace(" ", "T")).getTime() >=
          new Date(r.endTime.replace(" ", "T")).getTime();
      out.set(String(itemId), {
        bids: r.bids.map(mapBid),
        endsAt: r.endTime,
        serverTime: r.serverTime,
        ended,
      });
    }
    return out;
  }

  async countParts(
    status: "running" | "ended" | "upcoming",
  ): Promise<number> {
    return this.client.countParts(status);
  }

  /** Verifiera/uppdatera Toveks deploy-beroende hashar (browser-fritt). */
  async ensureFresh(): Promise<boolean> {
    return this.client.session.ensureFresh();
  }
}
