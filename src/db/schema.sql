-- Allarop — schema för auktionsaggregatorn.
-- Idempotent: kan köras flera gånger.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Auktionshus (källor).
CREATE TABLE IF NOT EXISTS auction_houses (
  key        TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  domain     TEXT,
  fee_model  JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auktion (försäljningshändelse), t.ex. en konkurs.
CREATE TABLE IF NOT EXISTS auctions (
  id            BIGSERIAL PRIMARY KEY,
  house         TEXT NOT NULL REFERENCES auction_houses(key),
  external_id   TEXT NOT NULL,
  title         TEXT,
  description   TEXT,
  last_pay_date DATE,
  contact       TEXT,
  source_url    TEXT,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house, external_id)
);

-- Part (auktionssektion inom en auktion).
CREATE TABLE IF NOT EXISTS parts (
  id                  BIGSERIAL PRIMARY KEY,
  house               TEXT NOT NULL REFERENCES auction_houses(key),
  external_id         TEXT NOT NULL,
  auction_external_id TEXT,
  title               TEXT,
  description         TEXT,
  location            TEXT,
  category            TEXT,
  starts_at           TIMESTAMP,
  ends_at             TIMESTAMP,
  status              TEXT,
  source_url          TEXT,
  raw                 JSONB,            -- hela källobjektet ordagrant
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house, external_id)
);

-- Item / rop (det man faktiskt budar på).
CREATE TABLE IF NOT EXISTS items (
  id                  BIGSERIAL PRIMARY KEY,
  house               TEXT NOT NULL REFERENCES auction_houses(key),
  external_id         TEXT NOT NULL,
  part_external_id    TEXT,
  auction_external_id TEXT,
  title               TEXT,
  description         TEXT,
  location            TEXT,
  status              TEXT,
  ends_at             TIMESTAMP,
  min_bid             BIGINT,
  current_bid         BIGINT,
  bid_count           INTEGER,
  fee_value           BIGINT,
  vat_value           BIGINT,
  total_price         BIGINT,           -- beräknat faktiskt totalpris
  total_basis         TEXT,             -- "source" | "percentage"
  currency            TEXT,             -- "SEK" | "EUR" …
  seller              TEXT,             -- underliggande hus (Auctionet-medlem m.fl.)
  listed_at           TIMESTAMP,        -- när källan listade objektet (för "senast tillagda")
  leader_id           BIGINT,           -- budgivar-id för högsta budet
  leader_name         TEXT,             -- budgivarnamn för högsta budet
  sort_no             INTEGER,
  showing_starts      TIMESTAMP,        -- visning/besiktning
  showing_ends        TIMESTAMP,
  showing_address     TEXT,
  collect_starts      TIMESTAMP,        -- avhämtning
  collect_ends        TIMESTAMP,
  collect_address     TEXT,
  freight_help        TEXT,             -- "yes" | "no" | "custom"
  forklift_help       TEXT,
  youtube_link        TEXT,
  raw                 JSONB,            -- hela källobjektet ordagrant
  source_url          TEXT,
  first_seen          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house, external_id)
);

-- Fritext-/fuzzy-sök: trigram-index på titel, plats och beskrivning (sök i beskrivning
-- = nivå 2 i smarta sökningen).
CREATE INDEX IF NOT EXISTS items_title_trgm ON items USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_location_trgm ON items USING gin (location gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_desc_trgm ON items USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS items_status_idx ON items (status);
CREATE INDEX IF NOT EXISTS items_ends_at_idx ON items (ends_at);

-- Media (bilder/video) kopplat till part eller item.
CREATE TABLE IF NOT EXISTS media (
  id                BIGSERIAL PRIMARY KEY,
  house             TEXT NOT NULL,
  owner_type        TEXT NOT NULL,      -- 'part' | 'item'
  owner_external_id TEXT NOT NULL,
  kind              TEXT NOT NULL,      -- 'image' | 'video'
  url               TEXT NOT NULL,
  sort              INTEGER,
  local_path        TEXT,               -- satt när bilden speglats lokalt
  sha256            TEXT,
  downloaded_at     TIMESTAMPTZ,
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house, owner_type, owner_external_id, url)
);

CREATE INDEX IF NOT EXISTS media_owner_idx ON media (house, owner_type, owner_external_id);

-- Bild-embedding (DINOv3 ViT-L/16, 1024-dim float32) på HUVUDBILDEN per objekt: visuell
-- jämförbarhetsgate för prisjämförelsen/fynd. Lagras som little-endian bytea (1024*4 =
-- 4096 B/rad; ingen pgvector - priceStats kapar vid 150 kandidater så cosinus i Node
-- räcker, och pgvector-image-byte skulle riskera collation på pg_trgm-indexet). NULL =
-- ej beräknad (driver kön); 0-längds bytea = försökt & misslyckats (terminerar kön).
ALTER TABLE media ADD COLUMN IF NOT EXISTS embedding   BYTEA;
ALTER TABLE media ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ;

-- Bud (utan budgivaridentitet — GDPR).
CREATE TABLE IF NOT EXISTS bids (
  id               BIGSERIAL PRIMARY KEY,
  house            TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  item_external_id TEXT NOT NULL,
  value            BIGINT NOT NULL,
  type             TEXT,
  bidder_id        BIGINT,
  bidder_name      TEXT,
  raw              JSONB,            -- hela källobjektet ordagrant
  created_at       TIMESTAMP,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house, external_id)
);

-- Migrering för redan existerande databaser (måste köras före index nedan).
ALTER TABLE bids  ADD COLUMN IF NOT EXISTS bidder_id   BIGINT;
ALTER TABLE bids  ADD COLUMN IF NOT EXISTS bidder_name TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS leader_id   BIGINT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS leader_name TEXT;
ALTER TABLE auctions ADD COLUMN IF NOT EXISTS contact     TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS sort_no         INTEGER;
ALTER TABLE items ADD COLUMN IF NOT EXISTS showing_starts  TIMESTAMP;
ALTER TABLE items ADD COLUMN IF NOT EXISTS showing_ends    TIMESTAMP;
ALTER TABLE items ADD COLUMN IF NOT EXISTS showing_address TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS collect_starts  TIMESTAMP;
ALTER TABLE items ADD COLUMN IF NOT EXISTS collect_ends    TIMESTAMP;
ALTER TABLE items ADD COLUMN IF NOT EXISTS collect_address TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS freight_help    TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS forklift_help   TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS youtube_link    TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS category_conflict BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS items_category_conflict_idx ON items (category_conflict) WHERE category_conflict;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS raw             JSONB;
ALTER TABLE items ADD COLUMN IF NOT EXISTS raw             JSONB;
ALTER TABLE bids  ADD COLUMN IF NOT EXISTS raw             JSONB;
ALTER TABLE items ADD COLUMN IF NOT EXISTS currency        TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS seller          TEXT;
CREATE INDEX IF NOT EXISTS items_seller_idx ON items (seller);
ALTER TABLE items ADD COLUMN IF NOT EXISTS listed_at       TIMESTAMP;
CREATE INDEX IF NOT EXISTS items_listed_at_idx ON items (listed_at);
CREATE INDEX IF NOT EXISTS items_total_price_idx ON items (total_price);
CREATE INDEX IF NOT EXISTS items_bid_count_idx ON items (bid_count);
-- Reservationspris: status (met/not_met/none) + ev. värde (bara Junora exponerar talet).
ALTER TABLE items ADD COLUMN IF NOT EXISTS reserve_status  TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS reserve_price   BIGINT;
CREATE INDEX IF NOT EXISTS items_reserve_status_idx ON items (reserve_status);
-- Normaliserad kategori "huvud/under" (taxonomy.ts) + konfidens (text/mixed/house/none/override).
ALTER TABLE items ADD COLUMN IF NOT EXISTS category      TEXT;
ALTER TABLE items ADD COLUMN IF NOT EXISTS category_conf TEXT;
-- Antal LIKADANA huvudföremål i lotten (4 stolar → 4), satt av AI-klassningen (vision
-- räknar i bilden + läser texten). Null = okänt. Prisjämförelsen kräver samma antal.
ALTER TABLE items ADD COLUMN IF NOT EXISTS lot_count     INTEGER;
-- AI-extraherade objektattribut ur SAMMA klassnings-anrop (b=märke, m=modell,
-- d=designer, t=typ-substantiv, y=år, mat=material; obelagda fält utelämnas).
-- Prisjämförelsen gatar på dem lokalt → färre AI-bildjämförelser. '{}' = extraherat
-- men inget belagt (skiljer från NULL = ej försökt, styr backfill-kön).
ALTER TABLE items ADD COLUMN IF NOT EXISTS attrs         JSONB;
-- Text avläst UR BILDEN med generell OCR (RapidOCR/PP-OCR i alpr-sidecaren): modellkoder,
-- skyltar, märken. BRUSIG (aldrig visad som fakta) → används som SÖKBAR signal + ledtråd
-- till modell-extraktionen. NULL = ej OCR:at, '' = OCR:at men ingen text (styr kön).
ALTER TABLE items ADD COLUMN IF NOT EXISTS ocr_text      TEXT;
CREATE INDEX IF NOT EXISTS items_ocr_trgm ON items USING gin (ocr_text gin_trgm_ops);
-- FYND-motorn: uppskattat slutvärde (median-slutpris i SEK ur jämförbara sålda, via
-- priceStats med kategori/attribut/antal-gate) + antal comparables + när det räknades.
-- Nuvarande bud jämförs mot est_value_sek → "fynd" (aktivt objekt under sitt marknadsvärde).
-- est_count=0 = beräknat men för få comparables (skiljer från NULL = ej beräknat, styr kön).
ALTER TABLE items ADD COLUMN IF NOT EXISTS est_value_sek BIGINT;   -- median-slutpris (SEK)
ALTER TABLE items ADD COLUMN IF NOT EXISTS est_count     INTEGER;  -- antal comparables
ALTER TABLE items ADD COLUMN IF NOT EXISTS est_p25       BIGINT;   -- 25:e percentilen (SEK)
ALTER TABLE items ADD COLUMN IF NOT EXISTS est_p75       BIGINT;   -- 75:e percentilen (SEK)
ALTER TABLE items ADD COLUMN IF NOT EXISTS est_at        TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS items_category_idx ON items (category);
-- TEXT-embedding (multilingual-e5-base, 768-dim float32) på titel+beskrivning: semantisk
-- sök ("ram minne" hittar "arbetsminne DDR4" via MENING, ej bokstäver). Lagras little-
-- endian bytea (768*4 = 3072 B/rad). Ingen pgvector - text-index.ts håller ett in-memory-
-- index över aktiva objekt (brute-force cosinus, trivialt för <100k) och fuserar med den
-- lexikala söken via RRF. NULL = ej beräknad (styr kön); 0-längds bytea = försökt & tomt.
ALTER TABLE items ADD COLUMN IF NOT EXISTS text_embedding  BYTEA;
ALTER TABLE items ADD COLUMN IF NOT EXISTS text_embedded_at TIMESTAMPTZ;
-- Konkurs-flagg: objektets auktion är en konkurs/likvidation (auktionens titel/kontakt ~
-- konkurs/advokat/likvidation). Härleds på AUKTIONS-nivå (per-objekt-text är för gles) via
-- periodisk recompute (konkursPass). NULL/false = ej flaggad. Driver filtret ?konkurs=1.
ALTER TABLE items ADD COLUMN IF NOT EXISTS is_konkurs    BOOLEAN;
CREATE INDEX IF NOT EXISTS items_konkurs_idx ON items (is_konkurs) WHERE is_konkurs;
-- "Nyinkommet"-sortering (startsidan): partiellt uttrycks-index på aktiva. listed_at är
-- timestamp UTAN tz → tolka som UTC (fast zon = IMMUTABLE, krävs för index). Måste matcha
-- orderByClause("newest"). Utan detta: seq/bitmap-scan + sort av ~57k rader (~10s kall cache).
CREATE INDEX IF NOT EXISTS items_active_newest_idx
  ON items ((COALESCE(listed_at AT TIME ZONE 'UTC', first_seen)) DESC NULLS LAST)
  WHERE status='active';
-- Geokodning: ortnamn (normaliserat) → lat/lon via Nominatim (OSM), permanent cache - ETT
-- uppslag per ort någonsin. lat/lon NULL = ej hittad (sentinel, retryas ej). Driver kartan.
CREATE TABLE IF NOT EXISTS geocode (
  query       TEXT PRIMARY KEY,
  lat         DOUBLE PRECISION,
  lon         DOUBLE PRECISION,
  resolved_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bevakning (enanvändar-app, ingen auth): sparade sökningar matchas mot NYA objekt
-- (first_seen > last_checked_at) av schemaläggaren → notiser. params = filter-JSON
-- ({q, house[], category, ort, pris_min, pris_max, konkurs}).
CREATE TABLE IF NOT EXISTS saved_searches (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL,
  params          JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bevakade objekt: notis när det slutar snart / reservpris uppnås / avslutas.
-- notified_* förhindrar dubbelnotiser (sätts vid skapande om läget redan gäller).
CREATE TABLE IF NOT EXISTS watches (
  house            TEXT NOT NULL,
  external_id      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  notified_ending  BOOLEAN NOT NULL DEFAULT FALSE,
  notified_reserve BOOLEAN NOT NULL DEFAULT FALSE,
  notified_ended   BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (house, external_id)
);
-- Notiser (in-app-klockan). dedup_key gör varje händelse engångs (ON CONFLICT DO NOTHING).
CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  kind        TEXT NOT NULL,          -- search_match | ending_soon | reserve_met | ended
  title       TEXT NOT NULL,
  body        TEXT,
  house       TEXT,
  external_id TEXT,
  dedup_key   TEXT UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (created_at DESC) WHERE read_at IS NULL;
-- Web Push-prenumerationer (enanvändar-app, men flera enheter kan prenumerera). Notiser
-- levereras av webbläsarens push-tjänst även när sidan/Chrome inte är i fokus.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Körtidsinställningar (key/value) - t.ex. max_speed=1 (schemaläggaren maxar embedding-takten
-- med datorns fulla kraft). Sätts via /status, läses av schemaläggaren varje svep.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Fordonsdata per regnr (biluppgifter.se, Transportstyrelsen-data): permanent cache -
-- ETT uppslag per regnr någonsin. data = VehicleData-JSON; {"notFound":true} = slaget
-- gjort men fordonet finns ej (terminerar om-försök).
CREATE TABLE IF NOT EXISTS vehicle_data (
  regnr      TEXT PRIMARY KEY,
  data       JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Manuella kategori-rättningar (består över ingest): matcha på hus+id ELLER titel-mönster.
CREATE TABLE IF NOT EXISTS category_overrides (
  id            BIGSERIAL PRIMARY KEY,
  house         TEXT,            -- valfritt: gäller bara detta hus
  external_id   TEXT,            -- valfritt: exakt objekt (house+external_id)
  title_pattern TEXT,            -- valfritt: regex (case-insensitivt) mot titeln
  category      TEXT NOT NULL,   -- tvingad taxonomi-nyckel
  note          TEXT,
  created_at    TIMESTAMP NOT NULL DEFAULT now()
);

-- Trigram-index på prishistorikens titlar → snabb "liknande sålda"-sökning (priceStats).
CREATE INDEX IF NOT EXISTS ph_title_trgm ON price_history USING gin (item_title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS bids_item_idx ON bids (house, item_external_id);
CREATE INDEX IF NOT EXISTS bids_bidder_idx ON bids (house, bidder_id);

-- Prishistorik: en rad per avslutat objekt (för trend/jämförelse).
CREATE TABLE IF NOT EXISTS price_history (
  id               BIGSERIAL PRIMARY KEY,
  house            TEXT NOT NULL,
  item_external_id TEXT NOT NULL,
  item_title       TEXT,
  category         TEXT,
  final_bid        BIGINT,           -- slutbud (0 = osålt)
  final_total      BIGINT,           -- inkl. avgift + moms
  winner_name      TEXT,             -- vinnande budgivare (alias)
  sold             BOOLEAN,          -- final_bid > 0
  ended_at         TIMESTAMP,
  recorded_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (house, item_external_id)
);
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS winner_name TEXT;
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS sold        BOOLEAN;
-- HELA råpayloaden vid avslut (bud-historik, skick, märke/modell m.m.) - "spara allt,
-- raw" - för senare prisanalys/slutpris-förutsägelse. Kopieras ur items.raw vid final.
ALTER TABLE price_history ADD COLUMN IF NOT EXISTS raw         JSONB;
CREATE INDEX IF NOT EXISTS price_history_title_trgm ON price_history USING gin (item_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS price_history_ended_idx ON price_history (ended_at);

-- Självlärande klassningslexikon: token → kategori-statistik, LÄRD av LLM-klassningarna
-- (LLM = lärare, lexikonet = elev). Ju fler LLM-beslut, desto fler objekt klassas direkt
-- ur lexikonet utan API-anrop. seen = antal LLM-klassade titlar där token → kategori.
CREATE TABLE IF NOT EXISTS learned_tokens (
  token    TEXT NOT NULL,
  category TEXT NOT NULL,          -- taxonominyckel "huvud/under"
  seen     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token, category)
);

-- Konfidens-rang för kategori-klassningar: högre rang skriver aldrig över med lägre.
-- human (6, facit) > llm (5) > learned (4, LLM-lärt lexikon) > text (3, nyckelord) > house (2) >
-- mixed (1) > none (0).
CREATE OR REPLACE FUNCTION cat_conf_rank(conf TEXT) RETURNS int
IMMUTABLE LANGUAGE sql AS $$
  SELECT CASE conf
    WHEN 'human' THEN 6 WHEN 'llm' THEN 5 WHEN 'learned' THEN 4 WHEN 'text' THEN 3
    WHEN 'house' THEN 2 WHEN 'mixed' THEN 1 ELSE 0 END
$$;

-- Smart sök: LLM-expanderade sökfrågor (synonymer + relaterade föremål + kategorier),
-- cachas PERMANENT - en unik sökfråga expanderas EN gång någonsin (~$0,0001), sen gratis.
-- "diskho" → synonyms: ho/vask/diskbänk; "dykning" → related: våtdräkt/cyklop/regulator.
CREATE TABLE IF NOT EXISTS search_expansions (
  query      TEXT PRIMARY KEY,     -- normaliserad (gemener, trimmad)
  synonyms   TEXT[] NOT NULL,      -- andra ord för SAMMA sak
  related    TEXT[] NOT NULL,      -- nära relaterade föremål/tillbehör
  categories TEXT[] NOT NULL,      -- relevanta taxonominycklar
  model      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- AI-verdikt för prisjämförelser: är objekt A och B samma typ av föremål? Bedömt av en
-- vision-modell (OpenRouter) på bild + titel. Cachas permanent - ett par bedöms EN gång.
CREATE TABLE IF NOT EXISTS match_verdicts (
  house            TEXT NOT NULL,           -- målet
  item_external_id TEXT NOT NULL,
  cmp_house        TEXT NOT NULL,           -- jämförelsen (price_history-objektet)
  cmp_external_id  TEXT NOT NULL,
  same             BOOLEAN NOT NULL,        -- samma typ av föremål?
  reason           TEXT,                    -- modellens korta motivering
  model            TEXT,                    -- vilken modell som dömde
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (house, item_external_id, cmp_house, cmp_external_id)
);
ALTER TABLE match_verdicts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ai';

-- Cursor-state för återupptagbara jobb (t.ex. backfill av avslutade auktioner).
CREATE TABLE IF NOT EXISTS job_state (
  job          TEXT PRIMARY KEY,     -- t.ex. "tovek:ended-backfill"
  cursor_offset INTEGER NOT NULL DEFAULT 0,
  total        INTEGER,
  done         BOOLEAN NOT NULL DEFAULT false,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
