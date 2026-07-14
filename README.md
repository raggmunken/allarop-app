# Allarop - aggregator för svenska nätauktioner

Allarop samlar Sveriges nätauktioner på ett ställe: sök, bläddra, jämför priser,
bevaka objekt och planera avhämtningsrutter - med det **verkliga totalpriset**
(bud + inrops-/slagavgift + moms) uträknat per objekt, inte bara budet.

Allarop är en **aggregator/mellanhand**. Vi listar och länkar vidare; all
budgivning och betalning sker hos respektive auktionssajt. Se
[web/juridik.html](web/juridik.html) för Om/Villkor/Integritet/Kontakt.

Detta är en **enanvändar-app** (byggs och drivs av en enda person för eget
bruk), förberedd för valfri publik/delad drift bakom ett admin-lösenord (se
[Publik drift och säkerhet](#publik-drift-och-säkerhet)).

---

## Innehåll

- [Snabbstart](#snabbstart)
- [Arkitektur](#arkitektur)
- [Datamodell](#datamodell)
- [Auktionshus (connectors)](#auktionshus-connectors)
- [Avgiftsmotor](#avgiftsmotor-verkligt-totalpris)
- [Realtid: den adaptiva schemaläggaren](#realtid-den-adaptiva-schemaläggaren)
- [AI-lager](#ai-lager)
- [Sök](#sök)
- [Prishistorik, prisuppslag och fynd-motorn](#prishistorik-prisuppslag-och-fynd-motorn)
- [Kategorisystem](#kategorisystem)
- [Karta och ruttoptimering](#karta-och-ruttoptimering)
- [Bevakning och notiser](#bevakning-och-notiser)
- [Publik drift och säkerhet](#publik-drift-och-säkerhet)
- [Frontend](#frontend)
- [API-referens](#api-referens)
- [CLI-kommandon](#cli-kommandon)
- [Miljövariabler](#miljövariabler)
- [Docker / deploy](#docker--deploy)
- [Tester och typkontroll](#tester-och-typkontroll)
- [Juridik och GDPR](#juridik-och-gdpr)
- [Kända begränsningar och öppna punkter](#kända-begränsningar-och-öppna-punkter)

---

## Snabbstart

Förutsättningar: Node ≥ 22, Docker.

```bash
npm install
cp .env.example .env      # fyll i nycklar (se Miljövariabler)

npm run db:up              # startar Postgres
npm run db:init             # skapar schema + registrerar alla auktionshus

npm run cli -- poll         # adaptiv schemaläggare (realtid, alla hus, kör tills Ctrl-C)
npm run cli -- api          # läs-API + frontend → http://localhost:3000
```

Eller hela stacken via Docker Compose (rekommenderat, se [Docker / deploy](#docker--deploy)):

```bash
docker compose up -d --build
docker compose logs -f scheduler
```

Sök från kommandoraden:

```bash
npm run cli -- search "grävmaskin"
MY_BIDDER="dittalias" npm run cli -- search "grävmaskin"   # markerar dina ledningar
```

---

## Arkitektur

```
                     ┌────────────────────────────────────────────┐
                     │           24 connectors (src/connectors)    │
                     │  Tovek · Auctionet · Riksauktioner · Fabeo  │
                     │  Bukowskis · BNA · Klaravik · Blinto · ...  │
                     │  → normaliserade typer (Connector/FlatSource)│
                     └───────────────────┬──────────────────────────┘
                                         │
                     ┌───────────────────▼──────────────────────────┐
                     │     Adaptiv schemaläggare (src/scheduler)     │
                     │  full refresh · hot-poll · soft-close ·        │
                     │  arkiv-backfill · bildspegling · Tradera-crawl │
                     └───────────────────┬──────────────────────────┘
                                         │
       ┌─────────────────────────────────▼─────────────────────────────────┐
       │                    Postgres (src/db, schema.sql)                   │
       │  items · auctions · parts · bids · media · price_history ·         │
       │  watches · notifications · settings · vehicle_data · geocode …     │
       └───┬──────────────────────┬──────────────────────┬────────────────┘
           │                      │                      │
┌──────────▼─────────┐  ┌─────────▼──────────┐  ┌─────────▼──────────────┐
│  AI-lager (src/ai)  │  │ Avgiftsmotor         │  │  Berikning              │
│  klassning ·         │  │ (src/fees)           │  │  fordon (regnr) ·       │
│  embeddings (bild+   │  │ verkligt totalpris    │  │  OCR · geokodning ·     │
│  text) · sökexpansion│  │ per hus               │  │  konkurs-flagg          │
└──────────┬──────────┘  └─────────┬──────────────┘  └─────────┬──────────────┘
           │                      │                            │
           └──────────────────────▼────────────────────────────┘
                     ┌────────────────────────────────────────────┐
                     │        Läs-API (src/api/server.ts)          │
                     │  sök · prisstatistik · bevakning · rutt ·   │
                     │  admin-auth · rate limiting                 │
                     └───────────────────┬──────────────────────────┘
                                         │
                     ┌───────────────────▼──────────────────────────┐
                     │      Frontend (web/index.html, vanilla JS)    │
                     │  / · /priser · /rutt · /status · /om osv.     │
                     └────────────────────────────────────────────┘
```

### Mappstruktur

```
src/
  connectors/          En mapp per hus/plattform (24 st: 23 auktionshus-
                        connectors + Tradera sold-only) + types.ts
                        (Connector/FlatSource-kontraktet alla implementerar)
  fees/                 engine.ts (beräkningslogik) + rules.ts (regler per hus)
  db/                    schema.sql, pool.ts, repo.ts (upserts/sök/prisstatistik),
                          watch.ts, push.ts, settings.ts, konkurs.ts, similar.ts
  scheduler/             pipeline.ts (ingest), poll.ts (adaptiv loop), backfill.ts
  ai/                    classify-llm, embed(-text), search-expand, imageverify,
                          text-index, visual-index, ocr-enrich, budget
  price/estimate.ts      Fynd-motorn (uppskattat slutvärde per aktivt objekt)
  categories/             taxonomy.ts, klassningsregler, Tradera-lärande lexikon
  vehicle/                biluppgifter.se-berikning + ANPR-plåtläsning
  geo/geocode.ts          Nominatim-geokodning (cachead)
  route/optimize.ts       Ruttoptimering (VROOM/ORS eller lokal 2-opt)
  storage/images.ts       Bildspegling (SHA-256-dedup)
  browser/cloak.ts        CloakBrowser (stealth-Chromium) för bot-skyddade hus
  recon/                  Automatiserad nätverks-recon för nya sajter
  api/                    server.ts (HTTP-API), auth.ts (admin-inloggning),
                          ratelimit.ts
  cli.ts                 Alla kommandon (db-init, poll, ingest-*, api, recon …)
web/
  index.html             Hela frontend (sök, kort, detaljvy, /priser, /rutt, /status)
  juridik.html            Om/Villkor/Integritet/Kontakt
  sw.js                   Service worker (Web Push)
test/                    Vitest - 28 filer, 222 tester (en per connector + fees/sök)
docs/recon/sites.md       Recon-anteckningar per sajt
```

---

## Datamodell

Kärnhierarkin (`schema.sql`), gemensam för alla hus oavsett källstruktur:

```
auction_houses → auctions → parts → items (rop) → bids
                                       │
                                       ├─ media (bilder, med bild-embedding)
                                       └─ price_history (en rad per avslutat objekt)
```

De viktigaste tabellerna:

| Tabell | Innehåll |
| --- | --- |
| `items` | Ett rop/objekt. Bud, totalpris, kategori, AI-attribut, embeddings, fynd-uppskattning, reservpris - allt normaliserat, plus `raw` (hela källobjektet ordagrant). |
| `bids` | Bud **utan budgivaridentitet** (GDPR - se [Juridik](#juridik-och-gdpr)), utom `bidder_name`/`bidder_id` som lagras för egen ledningskontroll (`MY_BIDDER`). |
| `media` | Bilder/video per objekt + valfri `embedding` (DINOv3 ViT-L, 1024-dim) för visuell jämförbarhet. |
| `price_history` | En rad per avslutat objekt (slutbud, total, `sold`, `raw`) - grunden för prisjämförelse, fynd-motorn och `/priser`. |
| `learned_tokens` | Självlärande klassningslexikon (token → kategori), tränat av LLM-klassningen och Traderas miljontals sålda titlar. |
| `watches` / `saved_searches` / `notifications` | Bevakning och in-app-notiser. |
| `push_subscriptions` | Web Push-prenumerationer (VAPID). |
| `vehicle_data` / `geocode` | Permanenta cachar (regnr → fordonsdata, ort → lat/lon). |
| `job_state` | Cursor-state för återupptagbara bakgrundsjobb (backfill, Tradera-crawl). |
| `settings` | Körtidsflaggor, t.ex. `max_speed` (maxa embedding-takten via `/status`). |

Index: trigram (`pg_trgm`) på titel/plats/beskrivning/OCR-text/prishistorik-titel
för fuzzy-sök, plus riktade index för statusfilter, sluttid, kategori,
"nyinkommet"-sortering och reservpris.

---

## Auktionshus (connectors)

**23 connector-implementationer** täcker **27 registrerade auktionshus** (två
connectors är config-drivna och betjänar flera hus på samma plattform:
Bidflow → Sajab/Effecta/Effecta Maskin/Haraldssons, GAK-plattformen →
Göteborgs Auktionskammare/Auktionskammaren). Utöver dessa hämtas **Tradera**
separat (28:e källan), enbart för sålda priser - ingen aktiv-objektlistning,
ingen köp-/säljaridentitet.

| Hus | Typ av åtkomst | Avgiftsmodell |
| --- | --- | --- |
| Tovek | Next.js Server Actions (RSC/Flight) | `source` (itemFeeValue/itemVatValue) |
| Auctionet | JSON-API, sharded (kringgår pagineringstak) | `percentage`, per valuta (SE/DK/UK/EUR) |
| Riksauktioner | REST, per-objekt hot-fetch | `percentage` (10 %, min 100/max 10 000 kr) |
| Fabeo | SSR | `source` |
| Bukowskis | SSR | `percentage`, per valuta (SEK/EUR) |
| BNA | SSR | `percentage` (12 %) |
| Klaravik | API med exakt avgift per objekt | `source` |
| Blinto | Browser-XHR-batch (4MaxBid/getAuctionData) | `source` |
| PS Auction | JSON | `percentage` (16 %) |
| Retrade | REST | `external` (avgift ej publik) |
| Netauktion | SSR | `percentage` (12 %, min/max) |
| Kronofogden | Auction2000 | `source` (ingen avgift) |
| Junora | Shopify-baserad, harvestad avgiftstrappa | `source` (approximate) |
| Sajab / Effecta / Effecta Maskin / Haraldssons | Bidflow-plattform (LotsApi) | `source`, kalibrerad per auktion |
| Frivio | Öppet REST-API | `percentage` (5 %) |
| Sikö | Id-enumerering | `percentage` (18 % + 28 kr) |
| Upplands Auktionsverk | bbys/Next.js, öppen `/api/auctions` | `source` |
| Göteborgs Auktionskammare / Auktionskammaren | Custom PHP-plattform | `source` |
| Metropol | ASP | `percentage` (25 % + 100 kr) |
| Pantbanken | SSR, offset/length | `percentage` (15 %) |
| Budi | SSR + batch-API + data-attribut | `source` |
| Vaxxa | Typesense-index + Server Action-avgift | `source` |
| Auktiona | Öppet Firestore REST (gobid) | `source` |
| Tradera *(endast sålt)* | Next.js Flight, sold-only sökslice | `source` (inget påslag) |

Varje connector implementerar antingen **`Connector`** (part-baserad hierarki,
t.ex. Tovek) eller **`FlatSource`** (platt objektlista med inbäddade bud, t.ex.
Auctionet) - se det fulla kontraktet i
[`src/connectors/types.ts`](src/connectors/types.ts). Connectorer kan valfritt
stödja `fetchItem`/`fetchItems` (billig per-objekt-hämtning för hot-poll),
`pollItems` (soft-close-medveten: fångar förlängd sluttid), `listShards`
(kringgå pagineringstak) och `hasEndedArchive` (historik-backfill).

**Bot-skydd:** hus bakom Cloudflare/TLS-fingeravtryck (Blinto, Effecta,
Haraldssons m.fl.) routas via [`CloakBrowser`](src/browser/cloak.ts) - en
delad, lat-startad stealth-Chromium-instans (`browserFetch` för sidladdning,
`browserApi` för batchade in-page `fetch`-anrop utan att rendera en sida per
objekt).

**Ny sajt:** kör recon-harnessen (`npm run cli -- recon <url>`), som spelar in
all nätverkstrafik automatiskt (aldrig manuella HAR-filer), klassificera
endpoints, och skriv en connector mot `Connector`/`FlatSource`-kontraktet. Se
[`docs/recon/sites.md`](docs/recon/sites.md) för anteckningar per sajt.

---

## Avgiftsmotor (verkligt totalpris)

[`src/fees/engine.ts`](src/fees/engine.ts) beräknar det faktiska totalpriset -
kärnvärdet i Allarop är att aldrig visa bara budet när en avgift tillkommer.
Tre lägen, valda per hus i [`src/fees/rules.ts`](src/fees/rules.ts) (varje regel
är verifierad mot husets egna villkor/objektdata, med källhänvisning i
kommentaren):

- **`source`** - avgift och moms kommer direkt från källan per objekt (Tovek,
  Klaravik, Blinto, Budi, Vaxxa …). Kan märkas `approximate` (Junora: en
  harvestad avgiftstrappa, UI visar "≈").
- **`percentage`** - köpavgift i procent av budet + ev. golv/tak + fast
  slagavgift + momsregler, för hus som inte exponerar en färdig avgift
  (Auctionet, Riksauktioner, BNA, PS Auction, Pantbanken, Sikö, Metropol …).
- **`external`** - avgiften går inte att räkna ur publik data (t.ex. Retrade:
  en glidande skala som bara syns vid budläggning). Vi **hittar aldrig på** en
  total - visar budet och markerar att avgift tillkommer. Princip: *hellre
  inget än fel.*

Objekt- och avgiftsmoms hanteras separat (t.ex. Tovek: slagavgiften är alltid
momspliktig med 25 % även när objektet är momsbefriat). `basis`-fältet
(`source`/`percentage`/`external`/`estimate`) följer med till UI:t så
osäkerhet aldrig göms.

---

## Realtid: den adaptiva schemaläggaren

[`src/scheduler/poll.ts`](src/scheduler/poll.ts) kör en enda lång loop
(`runScheduler`) med flera samtidiga bakgrundspass, alla frikopplade så att
inget blockerar den tidskritiska pollningen:

- **Full katalog-refresh** (var `FULL_REFRESH_MS`, default 30 min): bud för
  alla aktiva objekt, rullande svep av platta källors kataloger, arkiv-backfill,
  bildspegling.
- **Hot-poll** (grundtakt `BASE_TICK_MS`, default 10 s): trappar upp
  pollfrekvensen ju närmare sluttiden ett objekt är - var 10:e sekund sista
  minuten, varje minut under 5 minuter kvar, var 3:e minut under 15 minuter kvar.
  Fångar sena bud **och** soft-close-förlängningar (`pollItems`), finaliserar
  objekt till `price_history` så fort de verkligt avslutats.
- **Backstop-finalisering**: objekt som passerat sluttiden med marginal
  finaliseras även utan explicit "avslutad"-signal (skydd mot refresh-lag).
- **Arkiv-backfill** (separat cursor per hus, återupptagbar): betar av
  avslutade auktioner bakåt i tiden → fyller `price_history`.
- **Tradera-crawl** (tre parallella pass): *färskhet* (sida 1, roterande
  kategorier, fångar nysålt kontinuerligt), *djup backfill* (multi-dimensionell
  slicing - pris × län × objektstyp × säljartyp - som kringgår Traderas
  500-träffars sökgräns per kategori) och *lexikon-träning* (Traderas
  miljontals `titel → kategori`-par matas in i klassningslexikonet).
- **AI-pass**: textklassning, bildklassning, text- och bildembedding,
  sökexpansion-cache-uppvärmning, fynd-uppskattning - alla på egna intervall,
  budget-vaktade (se [AI-lager](#ai-lager)).
- **Berikningspass**: fordonsdata (regnr → biluppgifter.se), ANPR-plåtläsning,
  OCR på bilder, geokodning av nya orter, konkurs-flaggning.
- **Bevakningspass**: matchar nya objekt mot sparade sökningar, upptäcker
  status-övergångar på bevakade objekt (slutar snart / reservpris uppnått /
  avslutad) → notiser + Web Push.

Alla pass loggar bara vid faktisk aktivitet, körs med överlapps-guards (ett
pass i taget per typ) och exponentiell backoff vid fel.

---

## AI-lager

Allt AI-arbete går via **OpenRouter** och är **budget-vaktat**
([`src/ai/budget.ts`](src/ai/budget.ts)): en billig betalmodell
(`google/gemini-2.5-flash-lite` som default) används under ett kronologiskt
USD-tak (`AI_USAGE_MAX_USD`, kontrollerat mot kontots faktiska `total_usage`
var 5:e minut); över taket faller allt tillbaka till gratismodeller. Utan
`OPENROUTER_API_KEY` stängs AI-passen av tyst (ingen krasch).

- **Textklassning** ([`classify-llm.ts`](src/ai/classify-llm.ts)): objekt utan
  nyckelordsträff klassas av LLM mot [taxonomin](#kategorisystem), extraherar
  samtidigt strukturerade attribut (märke/modell/typ/år/material) för lokal
  prisjämförelse. Varje LLM-beslut **lär** det självlärande lexikonet
  (`learned_tokens`) - fler beslut → fler objekt klassas direkt utan API-anrop.
- **Bildklassning**: objekt där texten inte räckte ("diverse") skickas till en
  vision-modell tillsammans med annonsbilden.
- **Embeddings**: bild (DINOv3 ViT-L/16, 1024-dim, via en lokal ONNX-sidecar
  - GPU eller CPU) för visuell jämförbarhets-gate i prisjämförelsen, och text
  (multilingual-e5-base, 768-dim) för semantisk sök. Sidecaren delas mellan
  bakgrundsembedding och interaktiv sökning; en kort timeout på query-embedding
  gör att sök alltid är snabb - semantik är en bonus, aldrig en blockering.
- **Sökexpansion** ([`search-expand.ts`](src/ai/search-expand.ts)): en
  sökfråga expanderas EN gång någonsin till synonymer + relaterade föremål +
  troliga kategorier, cachas permanent (`search_expansions`).
- **Bildverifiering** ([`imageverify.ts`](src/ai/imageverify.ts)): admin-verktyg
  som ber en vision-modell avgöra om två objekt (mål + jämförelsekandidat) är
  samma typ av föremål - förfinar prisjämförelsen bortom kategori/attribut-gaten.
  Verdikt cachas permanent (`match_verdicts`).
- **OCR** ([`ocr-enrich.ts`](src/ai/ocr-enrich.ts)) och **ANPR-plåtläsning**
  ([`vehicle/alpr.ts`](src/vehicle/alpr.ts)): läser text/registreringsskyltar
  ur bilder via samma lokala ONNX-sidecar (RapidOCR/fast-alpr) - gratis, ingen
  rate-limit, körs helt lokalt.

---

## Sök

Hybrid mellan **lexikalt** och **semantiskt**:

1. **Lexikal bas**: trigram-likhet (`pg_trgm`) på titel/plats/beskrivning +
   OCR-text, med multi-ords precisionsfilter (index-vänlig SQL-del + JS-side
   overlap-kontroll) så vanliga ord inte tvingar fram en dyr sekventiell scan.
2. **LLM-expansion** (cachad): breddar frågan med synonymer/relaterade
   ord/kategorier innan sökningen körs.
3. **Semantisk hybrid**: query-text embeddas (e5) och matchas mot ett
   in-memory brute-force-index över aktiva objekts textembeddings, fuserat med
   den lexikala rankningen via **Reciprocal Rank Fusion (RRF)**. En adaptiv
   z-score-tröskel gör att frågor utan äkta semantisk träff ger ett tomt
   bidrag i stället för brus.
4. **Nivårankning**: exakta träffar och titel-träffar rankas före
   beskrivnings-/relaterade träffar.

Filter: källa (flerval), kategori, ort (med kart-rita-område), prisintervall,
"slutar inom", konkurs/likvidation, "ny/oanvänd", reservpris-status, fynd (≥15 %
under uppskattat värde) - alla API-drivna, kombinerbara.

---

## Prishistorik, prisuppslag och fynd-motorn

- **`price_history`**: en rad per avslutat objekt (alla 27 hus), fylld
  löpande av schemaläggarens finalisering + separat arkiv-backfill.
  **Tradera** bidrar miljontals rader (endast sålt, ingen köp-/säljaridentitet
  sparas - se [Juridik](#juridik-och-gdpr)).
- **"Vad har liknande gått för?"** (på varje objekts detaljvy): kategori-gate
  → attribut-gate (märke/modell/typ) → antal-gate (samma antal i lotten) →
  trigram/ord-overlap på titel → visuell embedding-gate (cosine-likhet på
  huvudbilden) → valfri AI-bildgranskning. Visar min/median/snitt/max +
  jämförbara sålda med bild. Publikt visas bara aggregatet - **källorna
  (vilka sålda objekt, vilka hus) döljs för icke-admin** (se
  [Publik drift](#publik-drift-och-säkerhet)).
- **Fynd-motorn** ([`price/estimate.ts`](src/price/estimate.ts)): samma
  jämförelsemaskineri körs periodiskt för **aktiva** objekt och lagrar ett
  uppskattat medianslutvärde (`est_value_sek`, `est_count`, `est_p25/p75`) -
  driver 🔥 fynd-badgen och `sort=fynd`. `est_count=0` sparas explicit (räknat,
  för få jämförbara) skilt från "aldrig beräknat" - fynd flaggas aldrig på
  tunt underlag.
- **`/priser`** (admin-verktyg): fritt prisuppslag över hela `price_history`
  med periodväljare, typiskt spann (p25-p75), trend/median-graf och
  CSV-export.

---

## Kategorisystem

Tvånivå-taxonomi ([`src/categories/taxonomy.ts`](src/categories/taxonomy.ts)),
20 huvudkategorier (Fordon, Konst & Antikt, Möbler & Inredning, Samla & Hobby,
Skönhet & Hälsa, Musik/Film/Spel, Böcker & Tidningar, …), stabila nycklar
(`fordon/personbilar`) lagrade på `items.category`.

**Hybrid-klassning** i rangordning (högre skriver aldrig över lägre):
`llm` (5, facit) → `learned` (4, självlärt lexikon) → `text` (3, nyckelord) →
`house` (2, husets egen kategori som fallback) → `mixed` (1) → `none` (0).
Lexikonet tränas kontinuerligt både av LLM-klassningens egna beslut **och** av
Traderas miljontals redan kategoriserade sålda/aktiva titlar (mappade till
Allarops taxonomi via [`tradera-map.ts`](src/categories/)), vilket gör att fler
och fler objekt klassas korrekt helt utan API-anrop över tid.

---

## Karta och ruttoptimering

- **Karta**: rita ett fritt område på kartan (Leaflet) som geografiskt filter,
  ovanpå ort-textfiltret. Orter geokodas lat/lon en gång (Nominatim, permanent
  cache) och styr en punktmatchning mot det ritade polygonet.
- **Ruttoptimering** (admin, `/rutt`): fyll i startpunkt + stopp
  (adress/koordinat, servicetid, ev. tidsfönster) → bästa ordning + tidslinje +
  faktisk väggeometri. Två motorer: **OpenRouteService/VROOM** (om
  `ORS_API_KEY` finns - äkta tidsfönster-VRP, optimeraren väljer starttid) eller
  en **lokal fallback** (OSRM-avståndsmatris + nearest-neighbor + 2-opt).
  Källan (`source`) rapporteras alltid till UI:t - aldrig fejkad precision.
  Bevakade/sparade objekt kan skickas direkt till ruttplaneraren.

---

## Bevakning och notiser

- **Sparade sökningar**: valfritt filter sparas, matchas mot nya objekt
  (`first_seen`-baserat) av bevakningspasset → in-app-notis.
- **Bevakade enskilda objekt**: notis vid statusövergångar - slutar snart,
  reservpris uppnått, avslutat. Dedup-skyddat (`notified_*`-flaggor).
- **In-app-klocka**: notislista med läst/oläst.
- **Web Push**: riktiga push-notiser (VAPID) som visas **även när sidan eller
  webbläsaren inte är i fokus** (men aldrig i fullskärmsläge), nere i högra
  hörnet. Ett klick markerar notisen läst automatiskt och fokuserar/öppnar
  fönstret ([`web/sw.js`](web/sw.js)).

---

## Publik drift och säkerhet

Modellen: sajten är **publik för läsning** (sök/bläddra/detaljvy/länka ut).
**Personliga funktioner kräver admin-inloggning**:

- **Admin-auth** ([`src/api/auth.ts`](src/api/auth.ts)): `ADMIN_PASSWORD` +
  HMAC-signerad httpOnly-cookie (`SameSite=Lax`, `Secure` i produktion). Utan
  lösenord = allt öppet (lokal utveckling, med varning i loggen). Med
  `NODE_ENV=production` **vägrar API:t starta** utan ett satt lösenord.
- **Gatade endpoints**: `/status`, `/hus`, `/settings`, `/watchlist`,
  `/searches`, `/notifications`, `/push/*`, `/route/optimize`,
  `/geocode/suggest`, `/price-lookup`, `/price-history` - alla 401 utan
  admin-cookie.
- **Priskällor döljs publikt**: `/price-stats` returnerar bara aggregatet
  (median/spann/count) till en icke-admin - **aldrig** vilka sålda objekt
  eller hus statistiken bygger på. AI-bildgranskning (kostar) är admin-only.
- **Rate limiting** ([`src/api/ratelimit.ts`](src/api/ratelimit.ts)): global
  gräns per IP + hårdare gränser på sök (LLM-kostnad), prisstatistik, rutt och
  geokodning. Inloggningsförsök strypt (10/5 min) mot lösenordsgissning.
  `TRUST_PROXY=1` läser klientens riktiga IP ur `X-Forwarded-For` bakom en
  reverse-proxy.
- **Säkerhetsheaders**: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy` på alla HTML-svar.
- **Bilder**: publikt hotlänkas alltid källans egen bild-URL - Allarops
  eventuella lokala bildspegling (`media.local_path`, för AI/embedding)
  exponeras aldrig i API-svar.
- **GDPR**: budgivaridentitet lagras aldrig (utom `MY_BIDDER`-matchning för
  egen ledningskontroll, en lokal funktion). Tradera-data sparar aldrig
  säljaralias/medlems-id. En enda nödvändig cookie (admin-sessionen), ingen
  spårning/analytics.

Kvar för faktisk publik lansering (operativt, inte kodmässigt): sätt
`NODE_ENV=production` + starkt `ADMIN_PASSWORD` + `TRUST_PROXY=1`, en
reverse-proxy med HTTPS (Let's Encrypt), och ett beslut om var
bild-/text-embedding körs (dagens GPU-embedding är lokal).

---

## Frontend

Ren HTML/CSS/vanilla JS ([`web/index.html`](web/index.html), en fil, ingen
bundlare) - koboltblå accent på en mjuk neutral bakgrund, Schibsted Grotesk.
Klientroutade sidor (samma HTML, olika vy via `location.pathname`):

| Sida | Innehåll |
| --- | --- |
| `/` | Sök, filter, kortrutnät, "Upptäck"-karuseller (fynd/konkurs/nyinkommet) på startsidan utan aktivt filter. |
| Objektdetalj (modal) | Bildgalleri, avgiftsuppdelning, budhistorik, prisjämförelse, fordonsdata, "visa liknande". |
| `/priser` | Fritt prisuppslag (admin). |
| `/rutt` | Ruttplanerare (admin). |
| `/status` | Driftstatus: embedding-progress, husstatus (färskhet/täckning), prishistorik-räkning, Tradera-crawlens läge (admin). |
| `/om` `/villkor` `/integritet` `/kontakt` | Juridiska sidor ([`web/juridik.html`](web/juridik.html)), publika. |

Prestanda/tillgänglighet: `loading="lazy"` + `decoding="async"` på bilder,
`fetchpriority="high"` + `eager` på de första synliga korten, `preconnect`/
`dns-prefetch` till de vanligaste bild-CDN:erna, hover-förladdning av
objektdetaljer, `:focus-visible`-ringar, `prefers-reduced-motion` respekteras,
responsiv ner till mobil (375 px) utan sidöverflöd.

---

## API-referens

Alla svar JSON om inget annat anges. Publika endpoints kräver ingen cookie;
🔒 = admin-only (401 utan giltig session).

| Endpoint | Beskrivning |
| --- | --- |
| `GET /items?q=&house=&category=&sort=&...` | Huvudsök/lista, alla filter, sida 1 av N. |
| `GET /items/:house/:externalId` | Objektdetalj: media, bud, fordonsdata, `leader`/`youLead`. |
| `GET /price-stats?house=&id=` | Prisjämförelse för ett objekt (publikt: aggregat utan källor). |
| `GET /price-lookup?q=&months=` 🔒 | Fritt prisuppslag, `format=csv` för export. |
| `GET /price-history?q=` 🔒 | Rå prishistorik-sökning. |
| `GET /similar-visual?house=&id=` | Visuellt lika aktiva objekt (DINOv3-embedding). |
| `GET /categories` / `GET /locations` / `GET /houses` | Facetter med räknare för filter-UI. |
| `GET /rates` | Växelkurser (SEK per utländsk valuta). |
| `GET /geocode/suggest?q=` 🔒 | Adressförslag (ruttplaneraren). |
| `POST /route/optimize` 🔒 | Ruttoptimering. |
| `GET/POST /watchlist` 🔒 | Bevakade objekt. |
| `GET/POST /searches`, `POST /searches/delete` 🔒 | Sparade sökningar. |
| `GET /notifications`, `POST /notifications/read` 🔒 | In-app-notiser. |
| `GET /push/vapid`, `POST /push/subscribe`/`unsubscribe` 🔒 | Web Push. |
| `GET /status`, `GET /hus` 🔒 | Driftstatus (HTML eller `?json=1`). |
| `POST /settings/max-speed` 🔒 | Toggla embedding-hastighet. |
| `POST /admin/login`, `POST /admin/logout`, `GET /admin/session` | Inloggning. |
| `GET /health` | Health-check. |

---

## CLI-kommandon

```
db-init                       Skapa/uppdatera schema + registrera alla hus
poll                           Adaptiv schemaläggare (realtid, alla hus)
api                             Starta läs-API + frontend
search <fras>                   Fuzzy-sök bland sparade objekt
ingest-once [--bids]            En engångs full ingest av Tovek
ingest-<hus> [--pages N] […]     Manuell engångs-ingest per hus (auctionet,
                                  riksauktioner, fabeo, bukowskis, bna, klaravik,
                                  blinto, psauction, retrade, netauktion,
                                  kronofogden, junora, bidflow, frivio, siko,
                                  upplands, gak, metropol, pantbanken, budi,
                                  vaxxa, auktiona)
tradera-sold [--root ID] [--max-depth N] [--max-fetches N] [--fresh]
                                  Crawla Traderas sålda → price_history
tradera-active-train [--pages N]  Träna lexikonet på Traderas aktiva titlar
ingest-ended [--batch N] [--max N]  Backfill Tovek-arkivet → price_history
price-history [fras]             Visa/sök prishistorik
llm-classify / vision-classify   Bulk-ikappkörning av AI-klassningen
refresh-session                  Tvinga fram Tovek-sessionsuppdatering
recon <origin> [paths...]        Kartlägg en ny sajts nätverkstrafik
```

---

## Miljövariabler

| Variabel | Syfte |
| --- | --- |
| `DATABASE_URL` | Postgres-anslutning. |
| `OPENROUTER_API_KEY` | Krävs för allt AI (klassning, embeddings-styrning, sökexpansion, bildgranskning). Utan den: AI-passen stängs av tyst. |
| `OPENROUTER_PAID_MODEL` / `AI_USAGE_MAX_USD` | Betalmodell + kronologiskt utgiftstak. |
| `AI_CLASSIFY_INTERVAL_MS` / `AI_IMAGE_CLASSIFY_*` | Takt på klassningspassen. |
| `MY_BIDDER` | Ditt alias - markerar dina ledande bud i sök/API. |
| `ADMIN_PASSWORD` / `ADMIN_SECRET` / `TRUST_PROXY` / `NODE_ENV` | Se [Publik drift](#publik-drift-och-säkerhet). |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | Web Push. |
| `ORS_API_KEY` / `OSRM_URL` / `ROUTE_AVG_KMH` | Ruttoptimering. |
| `ALPR_URL` | ONNX-sidecarens URL (bild-embedding, OCR, plåtläsning). |
| `EMBED_DIM` / `EMBED_TEXT_DIM` | Embedding-dimensioner (måste matcha sidecar-modellen). |
| `TRADERA_ENABLED` / `TRADERA_*_MS` | Tradera-crawlens tre bakgrundspass. |
| `FULL_REFRESH_MS` / `BASE_TICK_MS` / `FLAT_SWEEP_PAGES` | Schemaläggarens grundtakter. |
| `MIRROR_IMAGES` | Spegla bilder lokalt (för AI) - publika API-svar visar alltid källänken. |
| `SEARCH_SEM_Z` / `SEARCH_SEM_WEIGHT` | Semantisk sök: tröskel resp. RRF-vikt. |
| `FYND_MIN_PCT` | Tröskel för fynd-badgen (default 15 %). |

Fullständig, kommenterad lista i `.env` (lokal) / `docker-compose.yml`
(container-miljö per tjänst).

---

## Docker / deploy

`docker-compose.yml` definierar:

- **`db`** - Postgres 16.
- **`migrate`** - engångsjobb, kör `db-init`.
- **`scheduler`** - `poll` (allt bakgrundsarbete: ingest, AI, berikning, Tradera).
- **`alpr`** - lokal ONNX-sidecar (bild-embedding/OCR/plåtläsning), Nvidia-GPU
  om tillgänglig (`ORT_USE_GPU=0` tvingar CPU), health-checkad.
- **`autoheal`** - watchdog som startar om containrar taggade `autoheal=true`
  som blir `unhealthy` (Dockers `restart:unless-stopped` reagerar bara på
  krasch, inte på unhealthy - löser en observerad GPU-sidecar-hängning efter
  lång drifttid).
- **`api`** - läs-API + frontend, port `API_PORT` (default 3000).

Volymer: `allarop-pgdata` (databasen), `allarop-images` (bildspegling, delad
mellan `scheduler` och `api`).

```bash
docker compose up -d --build
docker compose logs -f scheduler
```

---

## Tester och typkontroll

```bash
npm run typecheck    # tsc, strikt
npm test              # vitest - 28 filer, 222 tester
```

En testfil per connector (verifierar normalisering mot inspelad exempel-data),
plus `fees.test.ts` (avgiftsmotorn), `search-expand*.test.ts`, `learned.test.ts`,
`classify-llm.test.ts`, `similar.test.ts`, `biluppgifter.test.ts`.

---

## Juridik och GDPR

- **Ingen budgivaridentitet lagras** (utom lokal `MY_BIDDER`-matchning).
  Tradera-integrationen sparar **aldrig** säljaralias eller medlems-id.
- **Upphovsrätt**: objektbilder/beskrivningar tillhör auktionshusen. Publika
  API-svar hotlänkar alltid källans egen bild-URL - Allarop serverar aldrig en
  egen publik spegling. En eventuell lokal bildspegling (`MIRROR_IMAGES=1`)
  används enbart internt för AI/embedding.
- **En enda cookie** (admin-session), ingen spårning/analytics/tredjepartscookies.
- Fullständig text: [`web/juridik.html`](web/juridik.html) (`/om`, `/villkor`,
  `/integritet`, `/kontakt` - takedown-rutin för rättighetsinnehavare).

---

## Kända begränsningar och öppna punkter

- **Reservpris** exponeras inte publikt av Sikö/Bukowskis (kräver djupare recon).
- **Visuell comparable-sökning + cross-house-dedup** väntar på bättre
  embedding-täckning över hela beståndet.
- **`/status`-aggregaten** kan bli tunga (sekunder) när `price_history` växer
  mot flera miljoner rader (Tradera-crawlen) - ett rent
  frågeprestanda-/cache-arbete, inte en korrekthetsbugg.
- **GPU-embedding** körs idag lokalt; en molnserver utan GPU kräver antingen
  CPU-inferens (långsammare) eller att embedding körs separat och synkas.
- Traderas "sålt"-vy är ett **rullande fönster** (senast sålda), inte ett fast
  arkiv - täckning byggs upp både via bred slicing (ett komplett ögonblick per
  varv) och upprepade varv (fångar omsättning över tid).
