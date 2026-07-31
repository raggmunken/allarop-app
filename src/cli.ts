/**
 * Allarop CLI. Kommandon:
 *   db-init                 Skapa/uppdatera databasschemat.
 *   ingest-once [--bids]    En full ingest av Tovek till Postgres.
 *   poll                    Starta adaptiv schemaläggare (kör tills Ctrl-C).
 *   search <fras>           Fuzzy-sök bland sparade objekt.
 *   api                     Starta v0 läs-API.
 *   recon <origin> [paths]  Kör recon-harness mot en sajt (kräver cloakbrowser).
 *   refresh-session         Upptäck aktuella Tovek-hashar/deploy-id via HTTP.
 */

// Minimal .env-laddare (docker compose läser .env själv, men CLI-körningar utanför
// compose behöver den också - t.ex. OPENROUTER_API_KEY för llm-classify). Sätter
// bara variabler som inte redan finns i miljön.
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#") && process.env[m[1]!] == null) process.env[m[1]!] = m[2]!;
  }
} catch {
  /* ingen .env - ok */
}

import { TovekConnector, HOUSE } from "./connectors/tovek/index.ts";
import { AuctionetConnector, HOUSE as HOUSE_AUCTIONET } from "./connectors/auctionet/index.ts";
import { RiksauktionerConnector, HOUSE as HOUSE_RIKS } from "./connectors/riksauktioner/index.ts";
import { FabeoConnector, HOUSE as HOUSE_FABEO } from "./connectors/fabeo/index.ts";
import { BukowskisConnector, HOUSE as HOUSE_BUKOWSKIS } from "./connectors/bukowskis/index.ts";
import { BnaConnector, HOUSE as HOUSE_BNA } from "./connectors/bna/index.ts";
import { KlaravikConnector, HOUSE as HOUSE_KLARAVIK } from "./connectors/klaravik/index.ts";
import { BlintoConnector, HOUSE as HOUSE_BLINTO } from "./connectors/blinto/index.ts";
import { PSAuctionConnector, HOUSE as HOUSE_PSAUCTION } from "./connectors/psauction/index.ts";
import { RetradeConnector, HOUSE as HOUSE_RETRADE } from "./connectors/retrade/index.ts";
import { NetauktionConnector, HOUSE as HOUSE_NETAUKTION } from "./connectors/netauktion/index.ts";
import { KronofogdenConnector, HOUSE as HOUSE_KRONOFOGDEN } from "./connectors/kronofogden/index.ts";
import { JunoraConnector, HOUSE as HOUSE_JUNORA } from "./connectors/junora/index.ts";
import { BidflowConnector } from "./connectors/bidflow/index.ts";
import { BIDFLOW_HOUSES } from "./connectors/bidflow/houses.ts";
import { FrivioConnector, HOUSE as HOUSE_FRIVIO } from "./connectors/frivio/index.ts";
import { SikoConnector, HOUSE as HOUSE_SIKO } from "./connectors/siko/index.ts";
import { UpplandsConnector, HOUSE as HOUSE_UPPLANDS } from "./connectors/upplands/index.ts";
import { GakConnector } from "./connectors/gak/index.ts";
import { GAK_HOUSES } from "./connectors/gak/houses.ts";
import { MetropolConnector, HOUSE as HOUSE_METROPOL } from "./connectors/metropol/index.ts";
import { PantbankenConnector, HOUSE as HOUSE_PANTBANKEN } from "./connectors/pantbanken/index.ts";
import { BudiConnector, HOUSE as HOUSE_BUDI } from "./connectors/budi/index.ts";
import { VaxxaConnector, HOUSE as HOUSE_VAXXA } from "./connectors/vaxxa/index.ts";
import { AuktionaConnector, HOUSE as HOUSE_AUKTIONA } from "./connectors/auktiona/index.ts";
import { feeModelFor } from "./fees/rules.ts";
import { closePool, initSchema } from "./db/pool.ts";
import { enrichedItemIds, galleryEnrichedItemIds, loadRawItems, priceHistory, rawFieldSeed, searchItems, upsertHouse } from "./db/repo.ts";

/**
 * "Helt berikad" = beskrivning OCH galleri (>1 bild) finns i DB. Används som
 * loadEnriched-skip för hus där berikningen hämtar bådadera ur objektsidan:
 * objekt som tappat galleriet (t.ex. av en tidigare media-wipe) räknas INTE som
 * berikade → hämtas om igen och galleriet återställs av sig självt, medan objekt
 * med intakt galleri slipper om-hämtning.
 */
const fullyEnriched = (house: string) => async (): Promise<Set<string>> => {
  const [desc, gal] = await Promise.all([enrichedItemIds(house), galleryEnrichedItemIds(house)]);
  return new Set([...desc].filter((id) => gal.has(id)));
};
import { llmClassifyPass, visionClassifyBulk } from "./ai/classify-llm.ts";
import { ingestAll, ingestFlat } from "./scheduler/pipeline.ts";
import { backfillEndedBatch } from "./scheduler/backfill.ts";
import { runScheduler } from "./scheduler/poll.ts";
import { startApi } from "./api/server.ts";
import { reconSite, summarizeProfile } from "./recon/capture.ts";
import { crawlTraderaSold, crawlTraderaActiveTrain, crawlTraderaActiveSweep } from "./connectors/tradera/index.ts";
import { closeBrowser } from "./browser/cloak.ts";

const args = process.argv.slice(2);
const cmd = args[0];

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}

async function ensureHouse(): Promise<void> {
  await upsertHouse(HOUSE, "Tovek Auktioner", "tovek.se", feeModelFor(HOUSE));
}

async function ensureAuctionetHouse(): Promise<void> {
  await upsertHouse(
    HOUSE_AUCTIONET,
    "Auctionet",
    "auctionet.com",
    feeModelFor(HOUSE_AUCTIONET),
  );
}

async function ensureRiksHouse(): Promise<void> {
  await upsertHouse(
    HOUSE_RIKS,
    "Riksauktioner",
    "riksauktioner.se",
    feeModelFor(HOUSE_RIKS),
  );
}

async function ensureFabeoHouse(): Promise<void> {
  await upsertHouse(HOUSE_FABEO, "Fabeo", "fabeo.se", feeModelFor(HOUSE_FABEO));
}

async function ensureBukowskisHouse(): Promise<void> {
  await upsertHouse(
    HOUSE_BUKOWSKIS,
    "Bukowskis",
    "bukowskis.com",
    feeModelFor(HOUSE_BUKOWSKIS),
  );
}

async function ensureBnaHouse(): Promise<void> {
  await upsertHouse(HOUSE_BNA, "BNA", "bna.nu", feeModelFor(HOUSE_BNA));
}

async function ensureKlaravikHouse(): Promise<void> {
  await upsertHouse(HOUSE_KLARAVIK, "Klaravik", "klaravik.se", feeModelFor(HOUSE_KLARAVIK));
}

async function ensureBlintoHouse(): Promise<void> {
  await upsertHouse(HOUSE_BLINTO, "Blinto", "blinto.se", feeModelFor(HOUSE_BLINTO));
}

async function ensurePSAuctionHouse(): Promise<void> {
  await upsertHouse(HOUSE_PSAUCTION, "PS Auction", "psauction.se", feeModelFor(HOUSE_PSAUCTION));
}

async function ensureRetradeHouse(): Promise<void> {
  await upsertHouse(HOUSE_RETRADE, "Retrade", "retrade.eu", feeModelFor(HOUSE_RETRADE));
}

async function ensureNetauktionHouse(): Promise<void> {
  await upsertHouse(HOUSE_NETAUKTION, "Netauktion", "netauktion.se", feeModelFor(HOUSE_NETAUKTION));
}

async function ensureKronofogdenHouse(): Promise<void> {
  await upsertHouse(
    HOUSE_KRONOFOGDEN,
    "Kronofogden",
    "auktion.kronofogden.se",
    feeModelFor(HOUSE_KRONOFOGDEN),
  );
}

async function ensureJunoraHouse(): Promise<void> {
  await upsertHouse(HOUSE_JUNORA, "Junora", "junora.se", feeModelFor(HOUSE_JUNORA));
}

/** Registrera alla Bidflow-hus (Sajab, Effecta, Effecta Maskin, Haraldssons ...). */
async function ensureBidflowHouses(): Promise<void> {
  for (const h of BIDFLOW_HOUSES) {
    await upsertHouse(h.house, h.name, h.domain, feeModelFor(h.house));
  }
}

async function ensureFrivioHouse(): Promise<void> {
  await upsertHouse(HOUSE_FRIVIO, "Frivio", "frivio.se", feeModelFor(HOUSE_FRIVIO));
}

async function ensureSikoHouse(): Promise<void> {
  await upsertHouse(HOUSE_SIKO, "Sikö Auktioner", "sikoauktioner.se", feeModelFor(HOUSE_SIKO));
}

async function ensureUpplandsHouse(): Promise<void> {
  await upsertHouse(HOUSE_UPPLANDS, "Upplands Auktionsverk", "upplandsauktionsverk.se", feeModelFor(HOUSE_UPPLANDS));
}

async function ensureMetropolHouse(): Promise<void> {
  await upsertHouse(HOUSE_METROPOL, "Metropol Auktioner", "metropol.se", feeModelFor(HOUSE_METROPOL));
}

async function ensurePantbankenHouse(): Promise<void> {
  await upsertHouse(HOUSE_PANTBANKEN, "Pantbanken Sverige", "pantbanken.se", feeModelFor(HOUSE_PANTBANKEN));
}

async function ensureBudiHouse(): Promise<void> {
  await upsertHouse(HOUSE_BUDI, "Budi Auktioner", "budi.se", feeModelFor(HOUSE_BUDI));
}

async function ensureVaxxaHouse(): Promise<void> {
  await upsertHouse(HOUSE_VAXXA, "Vaxxa", "vaxxa.se", feeModelFor(HOUSE_VAXXA));
}

async function ensureAuktionaHouse(): Promise<void> {
  await upsertHouse(HOUSE_AUKTIONA, "Auktiona", "auktiona.se", feeModelFor(HOUSE_AUKTIONA));
}

async function ensureTraderaHouse(): Promise<void> {
  await upsertHouse("tradera", "Tradera", "tradera.com", feeModelFor("tradera"));
}

/** Registrera alla hus på GAK-plattformen (Göteborgs Auktionskammare, Auktionskammaren ...). */
async function ensureGakHouses(): Promise<void> {
  for (const h of GAK_HOUSES) {
    await upsertHouse(h.house, h.name, h.domain, feeModelFor(h.house));
  }
}

async function main(): Promise<void> {
  switch (cmd) {
    case "db-init": {
      await initSchema();
      await ensureHouse();
      await ensureAuctionetHouse();
      await ensureRiksHouse();
      await ensureFabeoHouse();
      await ensureBukowskisHouse();
      await ensureBnaHouse();
      await ensureKlaravikHouse();
      await ensureBlintoHouse();
      await ensurePSAuctionHouse();
      await ensureRetradeHouse();
      await ensureNetauktionHouse();
      await ensureKronofogdenHouse();
      await ensureJunoraHouse();
      await ensureBidflowHouses();
      await ensureFrivioHouse();
      await ensureSikoHouse();
      await ensureUpplandsHouse();
      await ensureGakHouses();
      await ensureMetropolHouse();
      await ensurePantbankenHouse();
      await ensureBudiHouse();
      await ensureVaxxaHouse();
      await ensureAuktionaHouse();
      console.log(
        "Schema initierat och hus registrerade (Tovek, Auctionet, Riksauktioner, Fabeo, Bukowskis, BNA, Klaravik, Blinto, PS Auction, Retrade, Netauktion, Kronofogden, Junora, Frivio, Sikö, Upplands, GAK, Auktionskammaren, Metropol, Pantbanken, Budi, Vaxxa, Auktiona + Bidflow: Sajab, Effecta, Effecta Maskin, Haraldssons).",
      );
      break;
    }

    case "ingest-once": {
      await initSchema();
      await ensureHouse();
      const connector = new TovekConnector();
      if (await connector.ensureFresh())
        console.log("Ny Tovek-deploy upptäckt — hashar uppdaterade.");
      const stats = await ingestAll(connector, {
        fetchBids: flag("bids"),
        maxBidFetch: 50,
      });
      console.log("Ingest klar:", JSON.stringify(stats));
      break;
    }

    case "poll": {
      await initSchema();
      await ensureHouse();
      await ensureAuctionetHouse();
      await ensureRiksHouse();
      await ensureFabeoHouse();
      await ensureBukowskisHouse();
      await ensureBnaHouse();
      await ensureKlaravikHouse();
      await ensureBlintoHouse();
      await ensurePSAuctionHouse();
      await ensureRetradeHouse();
      await ensureNetauktionHouse();
      await ensureKronofogdenHouse();
      await ensureJunoraHouse();
      await ensureBidflowHouses();
      await ensureFrivioHouse();
      await ensureSikoHouse();
      await ensureUpplandsHouse();
      await ensureGakHouses();
      await ensureMetropolHouse();
      await ensurePantbankenHouse();
      await ensureBudiHouse();
      await ensureVaxxaHouse();
      await ensureAuktionaHouse();
      await ensureTraderaHouse();
      const connector = new TovekConnector();
      const flatSources = [
        new AuctionetConnector(),
        new RiksauktionerConnector(),
        new FabeoConnector(),
        new BukowskisConnector({ loadEnriched: () => enrichedItemIds(HOUSE_BUKOWSKIS) }),
        new BnaConnector(),
        // Seed:a redan-berikade objekt ur DB → hoppa över om-hämtning av objektsidor
        // efter omstart (list-/live-data uppdateras ändå varje svep). Berikning =
        // beskrivning + galleri ur objektsidan → "berikad" = beskrivning OCH galleri
        // (fullyEnriched; objekt som tappat galleriet hämtas om → självläkande).
        new KlaravikConnector({
          loadEnriched: fullyEnriched(HOUSE_KLARAVIK),
          loadCache: () => loadRawItems(HOUSE_KLARAVIK),
        }),
        new BlintoConnector({ loadEnriched: fullyEnriched(HOUSE_BLINTO) }),
        new PSAuctionConnector({
          loadEnriched: fullyEnriched(HOUSE_PSAUCTION),
          loadCache: () => loadRawItems(HOUSE_PSAUCTION, "item"),
        }),
        new RetradeConnector({ loadEnriched: fullyEnriched(HOUSE_RETRADE) }),
        new NetauktionConnector({ loadEnriched: fullyEnriched(HOUSE_NETAUKTION) }),
        // Kronofogden: en list-render täcker alla objekt → ingen loadCache behövs.
        new KronofogdenConnector({ loadEnriched: fullyEnriched(HOUSE_KRONOFOGDEN) }),
        new JunoraConnector({ loadEnriched: fullyEnriched(HOUSE_JUNORA) }),
        // Bidflow-hus (Sajab, Effecta, Effecta Maskin, Haraldssons ...): event-hus, en
        // connector per hus. Aktiva auktioners objekt varje svep + historik backfillas.
        // Beskrivning + skick berikas gradvis via lotInfo (loadEnriched-skip).
        ...BIDFLOW_HOUSES.map((h) => new BidflowConnector(h, {
          loadEnriched: () => enrichedItemIds(h.house),
        })),
        // Frivio: fritidsfordon, öppet REST-API. ~36 aktiva + ~500 avslutade (backfill).
        new FrivioConnector(),
        // Sikö: timad konstauktion, id-enumerering. Seed:a detaljcachen ur DB efter omstart.
        new SikoConnector({ loadCache: () => loadRawItems(HOUSE_SIKO) }),
        // Upplands Auktionsverk: event-hus (bbys/Next.js). Aktiva/kommande + historik-backfill.
        new UpplandsConnector(),
        // GAK-plattformen (Göteborgs Auktionskammare, Auktionskammaren): SSR-PHP, config-driven.
        // Avgiftsattribut (priceInfo) ur detaljsidan, persisterade via raw → seed över omstart.
        ...GAK_HOUSES.map((h) => new GakConnector(h, {
          loadEnriched: fullyEnriched(h.house),
          loadFees: () => rawFieldSeed(h.house, ["detail", "fee"]),
        })),
        // Metropol: ASP-sajt, katalog per kategori (product-cards.html), kort bär allt.
        // Galleri (imagebank) berikas gradvis per objektsida. Skip-signalen är
        // galleri-baserad (korten bär redan beskrivning → enrichedItemIds täcker allt).
        new MetropolConnector({ loadEnriched: () => galleryEnrichedItemIds(HOUSE_METROPOL) }),
        // Pantbanken: pantauktioner (SSR), offset/length-paginering. Kort bär bud + budledare.
        // Beskrivning (Objektinformation-tabellen) berikas gradvis per objektsida.
        new PantbankenConnector({ loadEnriched: fullyEnriched(HOUSE_PANTBANKEN) }),
        // Budi: konkurs/B2B (SSR-lista + batch bidinfo-API + meta-beskrivning). Avgifts-
        // parametrar ur objektsidan, persisterade via raw → seed över omstart.
        new BudiConnector({
          loadEnriched: fullyEnriched(HOUSE_BUDI),
          loadFeeParams: () => rawFieldSeed(HOUSE_BUDI, ["item", "feeParams"]),
        }),
        // Vaxxa: konkurs/självservice (Typesense-index + objektsids-berikning: galleri+text+
        // momsstatus). Serviceavgift via getProductFeeAction per (objekt, bud).
        new VaxxaConnector({
          loadEnriched: fullyEnriched(HOUSE_VAXXA),
          loadTaxable: async () => {
            const raw = await rawFieldSeed<boolean>(HOUSE_VAXXA, ["item", "isTaxable"]);
            return new Map([...raw].filter(([, v]) => typeof v === "boolean"));
          },
        }),
        // Auktiona: konkurs/likvidation (gobid), öppet Firestore REST. External-läge.
        new AuktionaConnector(),
      ];
      const controller = new AbortController();
      process.on("SIGINT", () => {
        console.log("\nStoppar…");
        controller.abort();
      });
      await runScheduler(connector, controller.signal, flatSources);
      break;
    }

    case "search": {
      const q = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!q) {
        console.error("Användning: search <fras>");
        process.exitCode = 1;
        break;
      }
      const rows = await searchItems(q, { limit: 25 });
      const me = process.env.MY_BIDDER?.toLowerCase();
      console.log(`${rows.length} träffar för "${q}":`);
      for (const r of rows) {
        const lead = r.leader_name
          ? `| ledare ${r.leader_name}${me && r.leader_name.toLowerCase() === me ? " (DU LEDER)" : ""}`
          : "";
        console.log(
          `  [${r.house}/${r.external_id}] ${r.title} ` +
            `| bud ${r.current_bid ?? "-"} | total ${r.total_price ?? "-"} ${lead} | ${r.location ?? ""}`,
        );
      }
      break;
    }

    case "api": {
      startApi();
      return; // håll processen vid liv
    }

    case "recon": {
      const origin = args[1];
      if (!origin) {
        console.error("Användning: recon <origin> [path1 path2 ...]");
        process.exitCode = 1;
        break;
      }
      const paths = args.slice(2).filter((a) => !a.startsWith("--"));
      const profile = await reconSite(origin, {
        paths: paths.length ? paths : ["/"],
      });
      console.log("Sammanfattning (endpoint → antal):");
      for (const [k, n] of Object.entries(summarizeProfile(profile))) {
        console.log(`  ${n}\t${k}`);
      }
      break;
    }

    case "tradera-sold": {
      // Crawla Traderas SÅLDA objekt → price_history (endast pris; ingen säljaridentitet).
      await initSchema();
      const rootArg = args.indexOf("--root");
      const depthArg = args.indexOf("--max-depth");
      const fetchArg = args.indexOf("--max-fetches");
      const stats = await crawlTraderaSold({
        rootId: rootArg > -1 ? Number(args[rootArg + 1]) : undefined,
        maxDepth: depthArg > -1 ? Number(args[depthArg + 1]) : undefined,
        maxFetches: fetchArg > -1 ? Number(args[fetchArg + 1]) : undefined,
        resume: !flag("fresh"),
        log: (m) => console.log(m),
      });
      console.log(`Tradera sålt klart: ${JSON.stringify(stats)}`);
      break;
    }

    case "tradera-active-train": {
      // Träna lexikonet på AKTIVA Tradera-titlar (bred snabb täckning; lagrar inget).
      await initSchema();
      const depthArg = args.indexOf("--max-depth");
      const fetchArg = args.indexOf("--max-fetches");
      const pagesArg = args.indexOf("--pages");
      const stats = await crawlTraderaActiveTrain({
        maxDepth: depthArg > -1 ? Number(args[depthArg + 1]) : undefined,
        maxFetches: fetchArg > -1 ? Number(args[fetchArg + 1]) : undefined,
        trainPages: pagesArg > -1 ? Number(args[pagesArg + 1]) : undefined,
        resume: !flag("fresh"),
        log: (m) => console.log(m),
      });
      console.log(`Tradera aktiv-träning klar: ${JSON.stringify(stats)}`);
      break;
    }

    case "tradera-active": {
      // Engångs-backfill av AKTIVA Tradera-objekt → items (syns i sök/listor).
      // Slutar-snart-först per rot-kategori. GDPR: ingen säljaridentitet.
      await initSchema();
      await ensureTraderaHouse();
      const rootsArg = args.indexOf("--roots");
      const pagesArg = args.indexOf("--pages");
      const stats = await crawlTraderaActiveSweep({
        rootsPerCycle: rootsArg > -1 ? Number(args[rootsArg + 1]) : undefined,
        pagesPerRoot: pagesArg > -1 ? Number(args[pagesArg + 1]) : undefined,
        log: (m) => console.log(m),
      });
      console.log(`Tradera aktiv-backfill klar: ${JSON.stringify(stats)}`);
      break;
    }

    case "ingest-auctionet": {
      await initSchema();
      await ensureAuctionetHouse();
      const connector = new AuctionetConnector();
      const ended = flag("ended");
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 3;
      const compArg = args.indexOf("--company");
      const companyId = compArg > -1 ? Number(args[compArg + 1]) : undefined;
      const stats = await ingestFlat(connector, {
        ended,
        maxPages,
        perPage: 100,
        companyId,
      });
      console.log(
        `Auctionet ingest (${ended ? "avslutade" : "aktiva"}): ` +
          JSON.stringify(stats),
      );
      break;
    }

    case "ingest-riksauktioner": {
      await initSchema();
      await ensureRiksHouse();
      const connector = new RiksauktionerConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 3;
      const stats = await ingestFlat(connector, { maxPages, perPage: 100 });
      console.log("Riksauktioner ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-fabeo": {
      await initSchema();
      await ensureFabeoHouse();
      const connector = new FabeoConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 1;
      const stats = await ingestFlat(connector, { maxPages, perPage: 100 });
      console.log("Fabeo ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-bukowskis": {
      await initSchema();
      await ensureBukowskisHouse();
      const connector = new BukowskisConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 3;
      const stats = await ingestFlat(connector, { maxPages, perPage: 100 });
      console.log("Bukowskis ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-bna": {
      await initSchema();
      await ensureBnaHouse();
      const connector = new BnaConnector();
      const stats = await ingestFlat(connector, { maxPages: 1 });
      console.log("BNA ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-klaravik": {
      await initSchema();
      await ensureKlaravikHouse();
      const connector = new KlaravikConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 3;
      const stats = await ingestFlat(connector, { maxPages, perPage: 60 });
      console.log("Klaravik ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-blinto": {
      await initSchema();
      await ensureBlintoHouse();
      const connector = new BlintoConnector();
      const stats = await ingestFlat(connector, { maxPages: 1 });
      console.log("Blinto ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-psauction": {
      await initSchema();
      await ensurePSAuctionHouse();
      const connector = new PSAuctionConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 3;
      const stats = await ingestFlat(connector, { maxPages, perPage: 20 });
      console.log("PS Auction ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-retrade": {
      await initSchema();
      await ensureRetradeHouse();
      const connector = new RetradeConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 12;
      const stats = await ingestFlat(connector, { maxPages, perPage: 50 });
      console.log("Retrade ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-netauktion": {
      await initSchema();
      await ensureNetauktionHouse();
      const connector = new NetauktionConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 15;
      const stats = await ingestFlat(connector, { maxPages, perPage: 20 });
      console.log("Netauktion ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-kronofogden": {
      await initSchema();
      await ensureKronofogdenHouse();
      const connector = new KronofogdenConnector();
      const stats = await ingestFlat(connector, { maxPages: 1 });
      console.log("Kronofogden ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-junora": {
      await initSchema();
      await ensureJunoraHouse();
      const connector = new JunoraConnector();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 8;
      const stats = await ingestFlat(connector, {
        maxPages,
        perPage: 50,
        ended: flag("ended"),
      });
      console.log("Junora ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-frivio": {
      await initSchema();
      await ensureFrivioHouse();
      const connector = new FrivioConnector();
      // Aktiva auktioner (berikade) + historik-backfill (~500 avslutade) → prishistorik.
      const active = await ingestFlat(connector, { maxPages: 1 });
      const ended = await ingestFlat(connector, { ended: true, maxPages: 1 });
      console.log("Frivio ingest:", JSON.stringify({ active, ended }));
      break;
    }

    case "ingest-siko": {
      await initSchema();
      await ensureSikoHouse();
      const connector = new SikoConnector({ loadCache: () => loadRawItems(HOUSE_SIKO) });
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 30;
      const stats = await ingestFlat(connector, { maxPages, perPage: 100 });
      console.log("Sikö ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-upplands": {
      await initSchema();
      await ensureUpplandsHouse();
      const connector = new UpplandsConnector();
      // Aktiva/kommande auktioner + historik-backfill (~38 avslutade) → prishistorik.
      const active = await ingestFlat(connector, { maxPages: 1 });
      const ended = await ingestFlat(connector, { ended: true, maxPages: 60 });
      console.log("Upplands ingest:", JSON.stringify({ active, ended }));
      break;
    }

    case "ingest-gak": {
      await initSchema();
      await ensureGakHouses();
      const pagesArg = args.indexOf("--pages");
      const maxPages = pagesArg > -1 ? Number(args[pagesArg + 1]) : 20;
      const only = args.slice(1).find((a) => !a.startsWith("--"));
      const houses = only ? GAK_HOUSES.filter((h) => h.house === only) : GAK_HOUSES;
      for (const h of houses) {
        const connector = new GakConnector(h);
        // Aktiva objekt + historik-backfill (showEnded=yes) → prishistorik.
        const active = await ingestFlat(connector, { maxPages, perPage: 44 });
        const ended = await ingestFlat(connector, { ended: true, maxPages });
        console.log(`${h.name} ingest:`, JSON.stringify({ active, ended }));
      }
      break;
    }

    case "ingest-metropol": {
      await initSchema();
      await ensureMetropolHouse();
      const stats = await ingestFlat(new MetropolConnector(), { maxPages: 1 });
      console.log("Metropol ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-pantbanken": {
      await initSchema();
      await ensurePantbankenHouse();
      const stats = await ingestFlat(new PantbankenConnector(), { perPage: 500 });
      console.log("Pantbanken ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-budi": {
      await initSchema();
      await ensureBudiHouse();
      const stats = await ingestFlat(new BudiConnector());
      console.log("Budi ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-vaxxa": {
      await initSchema();
      await ensureVaxxaHouse();
      const stats = await ingestFlat(new VaxxaConnector());
      console.log("Vaxxa ingest:", JSON.stringify(stats));
      break;
    }

    case "ingest-auktiona": {
      await initSchema();
      await ensureAuktionaHouse();
      const stats = await ingestFlat(new AuktionaConnector());
      console.log("Auktiona ingest:", JSON.stringify(stats));
      break;
    }

    // Bulk-ikappkörning av BILD+TEXT-klassningen (betald billig vision-modell, parallella
    // disjunkta batchar, budgetvakt). Kör tills allt aktivt är LLM-facit eller taket nås.
    case "vision-classify": {
      if (!process.env.OPENROUTER_API_KEY) {
        console.error("OPENROUTER_API_KEY saknas (lägg i .env).");
        process.exit(1);
      }
      await visionClassifyBulk({ workers: 4, onProgress: (m) => console.log(`[${new Date().toISOString()}] ${m}`) });
      console.log("vision-classify klart.");
      break;
    }

    // Bulk-ikappkörning av LLM-klassningen (schemaläggaren tar sedan nytillkomna
    // löpande). Kör tills eftersläpet är tomt eller modellerna slutar svara.
    case "llm-classify": {
      if (!process.env.OPENROUTER_API_KEY) {
        console.error("OPENROUTER_API_KEY saknas (lägg i .env).");
        process.exit(1);
      }
      for (;;) {
        const r = await llmClassifyPass();
        if (r == null) {
          console.log("alla modeller svarade fel (rate-limit?) - avbryter, kör igen senare");
          break;
        }
        console.log(
          `llm-klassning: ${r.classified}/${r.sent} via LLM, ${r.learned} ur lexikonet ` +
            `(${r.lexiconSize} tokens), ${r.remaining} kvar`,
        );
        if (r.sent === 0 && r.learned === 0) break;
        await new Promise((res) => setTimeout(res, 4000)); // snäll takt mot gratisnivån
      }
      break;
    }

    case "ingest-bidflow": {
      await initSchema();
      await ensureBidflowHouses();
      // Ett valfritt hus-filter: ingest-bidflow [husnyckel]. args[0] är kommandot.
      const only = args.slice(1).find((a) => !a.startsWith("--"));
      const houses = only ? BIDFLOW_HOUSES.filter((h) => h.house === only) : BIDFLOW_HOUSES;
      for (const h of houses) {
        const connector = new BidflowConnector(h);
        // Aktiva auktioners objekt + historik-backfill → prishistorik.
        const active = await ingestFlat(connector, { maxPages: 1 });
        const ended = await ingestFlat(connector, { ended: true, maxPages: 30 });
        console.log(`Bidflow ${h.house} ingest:`, JSON.stringify({ active, ended }));
      }
      break;
    }

    case "ingest-ended": {
      await initSchema();
      await ensureHouse();
      const connector = new TovekConnector();
      await connector.ensureFresh();
      const batch = Number(args[args.indexOf("--batch") + 1]) || 5;
      const maxArg = args.indexOf("--max");
      const maxParts = maxArg > -1 ? Number(args[maxArg + 1]) : Infinity;
      let done = 0;
      // Kör tills arkivet är slut eller --max parts nåtts.
      for (;;) {
        const r = await backfillEndedBatch(connector, batch);
        done += r.processedParts;
        console.log(
          `backfill: ${r.offset}${r.total != null ? "/" + r.total : ""} parts` +
            ` (+${r.processedParts}, ${r.items} objekt)${r.doneAll ? " — KLART" : ""}`,
        );
        if (r.doneAll || r.processedParts === 0 || done >= maxParts) break;
      }
      break;
    }

    case "price-history": {
      const q = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      const rows = await priceHistory(q, 25);
      console.log(`Prishistorik (${rows.length})${q ? ` för "${q}"` : ""}:`);
      for (const r of rows) {
        console.log(
          `  ${r.ended_at?.toISOString?.().slice(0, 10) ?? "-"} | ${r.item_title} ` +
            `| slutbud ${r.final_bid} | total ${r.final_total} | ${r.sold ? "såld" : "osåld"}`,
        );
      }
      break;
    }

    case "refresh-session": {
      const connector = new TovekConnector();
      const { session } = connector.client;
      const updated = await session.discoverViaHttp();
      console.log(
        `Discovery klar (HTTP, ingen browser): ${updated} hashar uppdaterade, ` +
          `deploymentId=${session.getDeploymentId()}`,
      );
      break;
    }

    default:
      console.log(
        [
          "Allarop CLI",
          "  db-init                 Skapa/uppdatera schema",
          "  ingest-once [--bids]    Full ingest av Tovek",
          "  ingest-auctionet [--pages N] [--company ID]  Ingest av Auctionet",
          "  ingest-riksauktioner [--pages N]             Ingest av Riksauktioner",
          "  ingest-fabeo [--pages N]                     Ingest av Fabeo",
          "  ingest-bukowskis [--pages N]                 Ingest av Bukowskis",
          "  ingest-bna                                   Ingest av BNA",
          "  ingest-klaravik [--pages N]                  Ingest av Klaravik",
          "  ingest-blinto                                Ingest av Blinto",
          "  ingest-psauction [--pages N]                 Ingest av PS Auction",
          "  ingest-retrade [--pages N]                   Ingest av Retrade",
          "  ingest-netauktion [--pages N]                Ingest av Netauktion",
          "  ingest-kronofogden                           Ingest av Kronofogden",
          "  ingest-junora [--pages N] [--ended]          Ingest av Junora",
          "  ingest-bidflow [hus]                         Ingest + historik-backfill av Bidflow-hus (Sajab/Effecta/Haraldssons ...)",
          "  ingest-frivio                                Ingest + historik-backfill av Frivio (fritidsfordon)",
          "  ingest-siko [--pages N]                      Ingest av Sikö (id-enumerering)",
          "  ingest-upplands                              Ingest + historik-backfill av Upplands Auktionsverk",
          "  ingest-gak [--pages N]                       Ingest av Göteborgs Auktionskammare",
          "  tradera-sold [--root ID] [--max-depth N] [--max-fetches N] [--fresh]  Crawla Traderas sålda → prishistorik",
          "  tradera-active [--roots N] [--pages N]       Backfill av aktiva Tradera-objekt → items (slutar-snart-först)",
          "  ingest-metropol                              Ingest av Metropol Auktioner",
          "  ingest-pantbanken                            Ingest av Pantbanken (pantauktioner)",
          "  ingest-budi                                  Ingest av Budi Auktioner (konkurs/B2B)",
          "  ingest-vaxxa                                 Ingest av Vaxxa (konkurs/självservice)",
          "  ingest-auktiona                              Ingest av Auktiona (konkurs/likvidation)",
          "  poll                    Adaptiv schemaläggare",
          "  search <fras>           Fuzzy-sök objekt",
          "  ingest-ended [--batch N] [--max N]  Backfill avslutade → prishistorik",
          "  price-history [fras]    Visa/sök prishistorik",
          "  api                     Starta läs-API",
          "  recon <origin> [paths]  Kartlägg en sajt (kräver cloakbrowser)",
          "  refresh-session         Uppdatera Tovek-session",
        ].join("\n"),
      );
  }

  await closeBrowser();
  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  void closeBrowser();
  void closePool();
});
