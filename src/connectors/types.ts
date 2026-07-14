/**
 * Gemensamma domäntyper och connector-kontraktet.
 *
 * Hierarki (gäller Tovek, generaliseras för övriga sajter):
 *   AuctionHouse → Auction → Part → Item (rop) → Bid
 *
 * En "connector" vet hur man hämtar och normaliserar data från EN sajt.
 * Allt ovanför connectors (lagring, avgiftsmotor, schemaläggare, API) är
 * sajt-agnostiskt och pratar bara mot dessa normaliserade typer.
 */

export type MediaKind = "image" | "video";

export interface NormalizedMedia {
  kind: MediaKind;
  url: string;
  sort: number;
}

export interface NormalizedAuction {
  /** Auktionshusets nyckel, t.ex. "tovek". */
  house: string;
  /** Externt auktions-id hos källan (string för att passa alla sajter). */
  externalId: string;
  title: string;
  description?: string | null;
  /** Sista betaldatum etc. om tillgängligt. */
  lastPayDate?: string | null;
  /** Säljarens/uppdragsgivarens kontaktinfo (HTML/text). */
  contact?: string | null;
  sourceUrl?: string | null;
}

/** Hela källobjektet ordagrant — så vi aldrig tappar fält vi inte normaliserat. */
export type RawPayload = Record<string, unknown>;

export interface NormalizedPart {
  house: string;
  externalId: string;
  auctionExternalId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  category?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  status: string;
  media: NormalizedMedia[];
  sourceUrl?: string | null;
  /** Föräldraauktionens fält (följer med så vi slipper ett extra anrop). */
  auctionTitle?: string | null;
  auctionDescription?: string | null;
  auctionLastPayDate?: string | null;
  auctionContact?: string | null;
  /** Hela källobjektet (alla fält källan skickade). */
  raw?: RawPayload;
}

export interface NormalizedItem {
  house: string;
  externalId: string;
  partExternalId: string;
  auctionExternalId: string;
  title: string;
  description?: string | null;
  location?: string | null;
  status: string;
  endsAt?: string | null;
  /** Lägsta giltiga bud (utropspris) i hela kronor. */
  minBid?: number | null;
  /** Nuvarande/vinnande bud i hela kronor, om det finns. */
  currentBid?: number | null;
  bidCount?: number | null;
  /**
   * Reservationspris-status: "met" = uppnått, "not_met" = ej uppnått, "none" = inget
   * reservationspris, null = okänt (källan visar det inte). Driver kort-label + filter.
   */
  reserveStatus?: "met" | "not_met" | "none" | null;
  /**
   * Själva reservationspriset i hela kronor, om källan exponerar VÄRDET (bara Junora -
   * sajten döljer det men API:t läcker det). null = värdet okänt (bara status finns).
   */
  reservePrice?: number | null;
  /** Avgift i kronor som källan anger per objekt (Toveks itemFeeValue). */
  feeValue?: number | null;
  /** Momssats i PROCENT som källan anger per objekt (Toveks itemVatValue, t.ex. 25). */
  vatRate?: number | null;
  /** Valuta, t.ex. "SEK" eller "EUR". Default SEK. */
  currency?: string | null;
  /**
   * Det faktiska auktionshuset bakom objektet. För enskilda hus = husets namn
   * ("Tovek", "Riksauktioner"). För plattformar som samlar flera hus (Auctionet)
   * = det underliggande huset, t.ex. "Crafoord Auktioner". Driver källfilter.
   */
  seller?: string | null;
  /**
   * Budledarens id/alias om källan exponerar det DIREKT på objektet (Pantbanken visar
   * aliaset på varje kort). För källor där ledaren fås ur budhistoriken sätts leader_*
   * i stället via upsertBids. null = okänt/inga bud.
   */
  leaderId?: string | null;
  leaderName?: string | null;
  /** När källan listade/publicerade objektet (ISO), för "senast tillagda"-sortering. */
  listedAt?: string | null;
  media: NormalizedMedia[];
  sourceUrl?: string | null;

  /* --- Köp-relevant detaljinfo (besiktning, avhämtning, frakt) --- */
  /** Sortordning inom parten. */
  sortNo?: number | null;
  /** Visning/besiktning: starttid, sluttid och adress. */
  showingStarts?: string | null;
  showingEnds?: string | null;
  showingAddress?: string | null;
  /** Avhämtning: starttid, sluttid och adress. */
  collectStarts?: string | null;
  collectEnds?: string | null;
  collectAddress?: string | null;
  /** Frakthjälp/lasthjälp: "yes" | "no" | "custom" e.d. */
  freightHelp?: string | null;
  forkliftHelp?: string | null;
  /** Länk till video (YouTube) om angiven. */
  youtubeLink?: string | null;
  /** Hela källobjektet (alla fält källan skickade). */
  raw?: RawPayload;
}

export interface NormalizedBid {
  house: string;
  /** Externt bud-id hos källan. */
  externalId: string;
  itemExternalId: string;
  value: number;
  /** "normal" | "auto" | etc. — källans budtyp. */
  type?: string | null;
  createdAt: string;
  /** Budgivarens id hos källan (privat projekt → vi lagrar identitet). */
  bidderId?: string | null;
  /** Budgivarens visningsnamn/alias hos källan. */
  bidderName?: string | null;
  /** Hela källobjektet (alla fält källan skickade). */
  raw?: RawPayload;
}

export interface ListPartsOptions {
  offset?: number;
  limit?: number;
  status?: "running" | "ended" | "upcoming";
  /** Sortering på starttid: "asc" (default) eller "desc" (nyast först). */
  sort?: "asc" | "desc";
}

/**
 * Platt, objekt-centrerad källa (t.ex. Auctionet, Riksauktioner, KVD) — till
 * skillnad från part-baserade källor (Tovek). Paginerar objekt direkt; varje
 * objekt bär sin auktion + inbäddade bud.
 */
export interface FlatSourcePage {
  items: {
    auction: NormalizedAuction;
    item: NormalizedItem;
    bids: NormalizedBid[];
  }[];
  currentPage: number;
  totalPages: number;
  totalEntries: number;
}

export interface FlatSource {
  readonly house: string;
  fetchPage(opts: {
    ended?: boolean;
    page?: number;
    perPage?: number;
    companyId?: number;
    /** Shard-nyckel (t.ex. Auctionet-kategori) för att kringgå pagineringstak. */
    shard?: string;
  }): Promise<FlatSourcePage>;

  /**
   * Valfri: dela upp den aktiva katalogen i shards som var och en ligger under
   * källans pagineringstak, så ALLA objekt kan nås. (Auctionet: 25 toppkategorier,
   * var och en < 10 000, mot ett globalt tak på ~10 000 av ~36 000.)
   */
  listShards?(): Promise<{ key: string; label?: string }[]>;

  /**
   * Valfri: hämta ETT objekts färska läge (bud + ev. förlängd sluttid). Används
   * för att fånga exakt slutpris precis innan ett objekt finaliseras. Returnerar
   * null om objektet inte längre finns. (Riksauktioner: GET /objects/{id}.)
   */
  fetchItem?(externalId: string): Promise<{
    item: NormalizedItem;
    bids: NormalizedBid[];
  } | null>;

  /**
   * Valfri: BATCHAD variant av fetchItem för hett-poll (uppdatera många snart-
   * avslutande objekt i ETT anrop). Källor där per-objekt-hämtning är dyr (Blinto:
   * en browser-XHR/objekt men en gemensam session) implementerar denna så hot-
   * pollen inte blockeras av sekventiella anrop. Returnerar de objekt som hittades.
   */
  fetchItems?(externalIds: string[]): Promise<
    Map<string, { item: NormalizedItem; bids: NormalizedBid[] }>
  >;

  /**
   * True om källan har en separat feed för AVSLUTADE objekt (med slutpris) som
   * kan backfillas för historik. (Auctionet: items.json?is_ended=true.)
   */
  readonly hasEndedArchive?: boolean;

  /**
   * True om fetchPage returnerar objekten "slutar snart först" (sida 1 = de som
   * avslutas närmast). Då kan schemaläggaren hålla heta objekt färska genom att
   * tät-refresha sida 1 — även utan per-objekt-endpoint. (Auctionet.)
   */
  readonly endingSortedFirst?: boolean;
}

/** Resultat av en realtidspoll av ett objekt (för soft-close-finalisering). */
export interface ItemPollResult {
  bids: NormalizedBid[];
  /** Aktuell sluttid (kan ha förlängts av sena bud). */
  endsAt: string | null;
  /** Källans servertid vid svaret. */
  serverTime: string | null;
  /** True om objektet verkligt avslutats (servertid passerat sluttiden). */
  ended: boolean;
}

/**
 * Kontraktet varje sajt-connector implementerar. Connectorn ansvarar för
 * transport (HTTP/headless), avkodning (t.ex. RSC/Flight) och normalisering.
 */
export interface Connector {
  /** Stabil nyckel, t.ex. "tovek". */
  readonly house: string;

  /** Lista parts (auktionssektioner). Default: pågående. */
  listParts(opts?: ListPartsOptions): Promise<NormalizedPart[]>;

  /** Hämta alla items (rop) inom en part, med pris/avgift/media. */
  listItems(partExternalId: string): Promise<NormalizedItem[]>;

  /** Hämta budhistorik för ett item (för prishistorik och realtid). */
  listBids(itemExternalId: string): Promise<NormalizedBid[]>;

  /**
   * Valfri batch: hämta bud för flera items i ett anrop (itemId → bud).
   * Connectorer som stödjer det (t.ex. Tovek) låter pipeline/schemaläggare
   * polla många objekt billigt.
   */
  listBidsForItems?(
    itemExternalIds: string[],
  ): Promise<Map<string, NormalizedBid[]>>;

  /**
   * Valfri: realtidspoll av objekt som ger bud + aktuell (ev. förlängd) sluttid
   * + om objektet verkligt avslutats. Används för soft-close-finalisering.
   */
  pollItems?(
    itemExternalIds: string[],
  ): Promise<Map<string, ItemPollResult>>;

  /** Valfri: antal parts för ett status (för backfill-progress). */
  countParts?(status: "running" | "ended" | "upcoming"): Promise<number>;

  /**
   * Valfri: verifiera vid uppstart/periodiskt att åtkomsten fortfarande gäller
   * (t.ex. Toveks deploy-beroende hashar) och uppdatera annars. Returnerar true
   * om något uppdaterades.
   */
  ensureFresh?(): Promise<boolean>;
}
