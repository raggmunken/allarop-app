/**
 * Tovek-specifika konstanter, kartlagda ur inspelad nätverkstrafik (se mappen
 * `tovek/`) och verifierade mot live-svar 2026-06-26.
 *
 * Tovek är en Next.js App Router-sajt på Vercel. Det finns inget rent REST-API:
 * data hämtas via Next.js Server Actions (POST mot en sid-URL med headern
 * `next-action: <hash>`, svar i `text/x-component`/Flight-format).
 *
 * VIKTIGT: `next-action`-hasharna och `x-deployment-id` ändras vid varje
 * Vercel-deploy. Dessa värden är därför "frö"/default — session.ts kan
 * uppdatera dem live via CloakBrowser när ett anrop börjar fela.
 */

export const TOVEK_ORIGIN = "https://tovek.se";

/** Sidan vars Server Actions vi främst anropar. */
export const PAGAENDE_PATH = "/auktioner/pagaende-auktioner";

/** Default Server Action-hashar (frö). Uppdateras vid behov av session.ts. */
export const ACTION_HASHES = {
  /** body: [{offset,limit,sort,filter,partStatus}] → {auctions:[...parts], totalHits, auctionsToday} */
  listParts: "7f73301507738d1d532e34555a22a8fa17b00a2410",
  /** body: [partId] → {options:[...facetter], totalItems} */
  partFacets: "7ffabb6f2a28929412a95b783aae8e6fa63613be01",
  /** body: [partId,{offset,limit},null,null] → {auctionItems:[...], totalHits} */
  partItems: "7f869dc9a8f3ba0a6c063e0939bd8175c06fb361fb",
  /** body: [partId,[itemIds],"sök"] → filtrerade items */
  searchItems: "7f22f988973a730aaa5944ad94329d1755a03409bd",
  /** body: [[itemIds], offset, "<rand>"] → {allItemBids:[{itemId,bids:[...]}]} (batchbar!) */
  itemBids: "7fefa3c8fc073d54e3bea2cee240acbed24d77fd6c",
} as const;

export type ActionName = keyof typeof ACTION_HASHES;

/**
 * Server Actions exponeras i Toveks klient-JS som
 *   createServerReference("<hash>", …, "<funktionsnamn>")
 * Funktionsnamnet är stabilt mellan deploys (hashen är det inte). session.ts
 * läser bundlarna och slår upp aktuell hash via dessa namn. De tre rollerna
 * nedan räcker för hela pipelinen och finns alla i listsidans chunkar.
 */
export const ACTION_FUNCTION_NAMES: Record<ActionName, string> = {
  listParts: "getAuctions",
  partItems: "getAuctionItems",
  itemBids: "getRecentItemBidsByItemIds",
  partFacets: "getAuctionItemFilterSettings",
  searchItems: "getRecentItemBidsByAuctionPartId",
};

/** Default x-deployment-id (frö). Uppdateras vid behov av session.ts. */
export const DEFAULT_DEPLOYMENT_ID = "dpl_8sqGoKQhUvuxeM2YLLzemdHZTqoT";

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

/**
 * next-router-state-tree för listsidan. Next.js validerar inte trädet hårt för
 * Server Actions, men vi skickar ett korrekt träd för listsidan som default.
 */
export const PAGAENDE_STATE_TREE =
  "%5B%22%22%2C%7B%22children%22%3A%5B%5B%22slug%22%2C%22auktioner%2Fpagaende-auktioner%22%2C%22c%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D";
