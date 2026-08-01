# Kategoriklassning: konflikt-eskalering, backfill, bild-prioritet + mänsklig granskning (design)

Datum: 2026-08-01

## Problem

`classifyByText()` (text-lager) körs och vinner ofta INNAN husets egen
kategori ens konsulteras (`houseCategory.ts`: "LAGER 2 - används BARA som
fallback när textklassningen inte hittar något"). En bred nyckelordsregel
(t.ex. märkesnamn: `/rolex/`) kan träffa fel objekt (en tryckt klockkatalog,
inte en klocka) - konkret observerat fall: "Oyster Perpetual katalog från
Rolex, 2007" klassades `smycken/klockor` istället för att husets egen
kategori (som sannolikt hade rätt) någonsin konsulterades.

`llmClassifyPass`/vision-passet BORDE kunna rätta detta, men processar
**sämst konfidens först** (`ORDER BY cat_conf_rank ASC`) - `text` rankas
över `none`/`house`/`mixed`. Med Traderas miljontals aktiva objekt i de
lägre lagren hamnar ett felklassat `text`-objekt permanent längst bak i en
enorm kö - i praktiken omprövas det aldrig. Dessutom: rank-guarden
(`cat_conf_rank`) hindrar en `text`-klassning från att NÅGONSIN skrivas
över av en svagare, men den skyddar inte mot att den ALDRIG når fram till
en starkare omprövning heller.

## Mål

1. **Konflikt-eskalering vid inflöde**: text- och hus-kategori jämförs vid
   varje ingest; oense (på HUVUDKATEGORI-nivå) → flaggas för prioriterad
   granskning istället för att tyst lita på texten.
2. **Backfill**: samma jämförelse körs periodiskt över REDAN lagrade aktiva
   `text`-objekt (inte bara nyinkomna) - annars läks aldrig det befintliga
   beståndet.
3. **Bild-prioritet**: flaggade objekt prioriteras i BÅDA klassnings-köerna
   (text-LLM och vision) - eftersom ~99,9 % av objekten har bild och en
   bild ofta otvetydigt avgör "är detta föremålet, eller en avbildning/
   katalog/tillbehör av det".
4. **Mänsklig granskning** (`/swipe`): ett Tinder-liknande admin-verktyg för
   fall AI:n inte kan avgöra själv - swipe höger = korrekt (låses,
   skrivs aldrig över igen), swipe vänster = fel (omprövas). Flera lägen:
   `categorization` (denna spec) och `comparison` (återanvänder den
   redan existerande `match_verdicts`-mekanismen i `imageverify.ts`, se
   nedan) - byggt så fler lägen kan läggas till senare.

## Konflikt-flagga

Ny kolumn `items.category_conflict BOOLEAN NOT NULL DEFAULT false`.

Sätts (vid ingest i `repo.ts`, OCH i backfill-passet nedan) när:
- `classify()` returnerar `confidence='text'` (INTE `mixed` - en äkta
  blandlåda är inte en konflikt bara för att huset lagt den i en
  enskild kategori), OCH
- `houseCategoryKey()` returnerar ett icke-null `key`, OCH
- huvudkategorin (delen före `/`) i text-resultatet ≠ huvudkategorin i
  hus-resultatet.

Guardas mot att skriva över ett redan mänskligt/LLM-bekräftat beslut:
`category_conflict` sätts bara om `cat_conf_rank(category_conf) <
cat_conf_rank('learned')` (dvs. objektet är inte redan `learned`/`llm`/
`human`) - annars ingen ändring. Detta förhindrar att en vanlig
poll-uppdatering flaggar om ett redan löst objekt.

## Backfill-pass

Nytt periodiskt pass (samma mönster som övriga bakgrundspass, resumable
cursor via `job_state`, t.ex. `"categorize:conflict-backfill"`):

- Sveper `items WHERE status='active' AND category_conf='text'` i batchar,
  räknar om `classifyByText`/`houseCategoryKey` (ren JS/regex - INGEN
  AI-kostnad) och sätter `category_conflict=true` vid oense, enligt samma
  regler som ovan.
- Body kör tills hela det aktiva `text`-beståndet är genomgånget en gång,
  cursorn sparas så passet kan avbrytas/återupptas.
- Efter första fullständiga svepet behövs den bara köras sällan (nya
  objekt fångas redan vid ingest) - schemaläggs glest (t.ex. var 6:e
  timme) som en säkerhetsnät-omkörning.

## Bild-prioritet i klassnings-köerna

Både `llmClassifyPass`s urvalsfråga (`classify-llm.ts:284`) och
`selectVisionCandidates` (`classify-llm.ts:444`) får
`ORDER BY category_conflict DESC, cat_conf_rank(category_conf) ASC, ...`
istället för dagens `ORDER BY cat_conf_rank(...) ASC, ...`.

Ingen annan ändring behövs: `selectVisionCandidates` filtrerar redan till
objekt MED bild, och `classifyVisionBatch` faller redan tillbaka på
textklassning om bilden inte går att hämta. Flaggade objekt får alltså
automatiskt den starkaste tillgängliga signalen (bild när den finns) utan
ny logik.

Varje löst beslut (vision ELLER text) tränar redan lexikonet
(`toLearn`/`writeVerdict`) - så en korrekt "katalog"-lösning smittar av sig
på framtida liknande titlar via `learned`-laget, helt utan nya AI-anrop.
Detta är en självförstärkande loop: kostnaden för att fånga den här
felklassen sjunker över tid, den försvinner inte bara punktvis.

## `human`-konfidenstier

`cat_conf_rank()` (schema.sql) får en ny toppnivå:

```sql
WHEN 'human' THEN 6 WHEN 'llm' THEN 5 WHEN 'learned' THEN 4 WHEN 'text' THEN 3
WHEN 'house' THEN 2 WHEN 'mixed' THEN 1 ELSE 0
```

Ett `human`-märkt beslut skrivs ALDRIG över av någon automatisk pass -
rank-guarden som redan finns överallt (`repo.ts`, `classify-llm.ts`)
fungerar oförändrat, bara med en ny topp.

## `/swipe`: mänsklig granskning

**Auth**: återanvänder BEFINTLIG admin-cookie-auth (`src/api/auth.ts`) -
ingen ny lösenordsmekanism. `/swipe` läggs till i listan gatade endpoints
(samma `ADMIN_PASSWORD`-skydd som `/status` m.fl.). Lösenordet sätts i
`.env` på driftmiljön (INTE i git) - jag sätter inte in det faktiska
lösenordet i kod eller commits.

**Läge `categorization`**:
- Kö: `items WHERE category_conflict=true ORDER BY ends_at`, med fallback
  till lägst `cat_conf_rank` när kön är tom (så verktyget alltid har
  något att visa om admin vill beta av mer än bara konflikter).
- Kort visar: bild, titel, nuvarande kategori + varifrån den kom
  (text/hus/llm/lexikon), husets egen kategori-etikett bredvid.
- **Swipe höger** ("korrekt"): `category_conf='human'`,
  `category_conflict=false`. Låst permanent.
- **Swipe vänster** ("fel, pröva igen"): `category=NULL, category_conf=NULL,
  category_conflict=true` - objektet faller ur `human`/`llm`-filtret och
  hamnar överst i BÅDA klassnings-köerna igen (samma flagga som
  konflikt-eskaleringen, återanvänds som "hög prioritet, klassa om").

**Läge `comparison`** (återanvänder `imageverify.ts`/`match_verdicts`,
redan byggd AI-verifieringsmekanism för prisjämförelsens par):
- Kö: kandidatpar (mål-objekt + jämförelse-sålt-objekt) utan ett
  `match_verdicts`-facit ännu, eller där AI-verdikten har låg
  konfidens/är oprövad av människa.
- Kort visar: de två objekten sida vid sida (bild + titel + pris) - "är
  detta samma typ av föremål?".
- **Swipe höger** ("ja, jämförbara"): `match_verdicts` upsert med
  `same=true, source='human'`.
- **Swipe vänster** ("nej"): `same=false, source='human'`.
- `match_verdicts` får en ny kolumn `source TEXT NOT NULL DEFAULT 'ai'`
  (`'ai'|'human'`) - ett `human`-facit skrivs aldrig över av ett senare
  AI-anrop (prisjämförelsens kod kollar/skippar AI-verifiering om ett
  `human`-facit redan finns för paret).

**Frontend**: en ny sida `web/swipe.html` (egen fil, inte inbakad i
`index.html` - admin-only verktyg, ingen anledning att buntas med den
publika bundlen), vanilla JS, samma designspråk (Schibsted Grotesk,
koboltblå accent). Kortstapel, drag/swipe via pointer events + tangentbords-
genvägar (höger-/vänsterpil) för snabb genomgång utan mus. Lägesväljare
högst upp (`categorization`/`comparison`).

**API**: `GET /swipe/next?mode=` 🔒 (nästa kort), `POST /swipe/decide` 🔒
(`{mode, house, external_id, decision: 'approve'|'reject', ...}` - för
`comparison` även `cmp_house`/`cmp_external_id`).

## Icke-mål (v1)

- Fler `/swipe`-lägen än `categorization`/`comparison` (ramverket byggs
  generellt - `mode`-parametern + separata kö-/beslut-funktioner per läge -
  men bara dessa två implementeras nu).
- Statistik/dashboard över granskningstakt - kan läggas till senare, inte
  kritiskt för v1.

## Testning

- `houseCategory`/`classify`-konflikttestet: given text- och hus-resultat
  på olika huvudkategori → `category_conflict` sätts; samma huvudkategori
  (olika underkategori) → INTE flaggat; `mixed` → INTE flaggat.
- Backfill-passets cursor: resumable, hoppar inte över eller dubbel-
  processar rader vid omstart (samma test-mönster som andra
  cursor-baserade backfills).
- `cat_conf_rank('human') > cat_conf_rank('llm')`.
- `/swipe/decide`: höger på categorization → conf='human', konflikt-flagga
  false; vänster → conf/category NULL, konflikt-flagga true (requeue).
  Höger/vänster på comparison → `match_verdicts` upsert med rätt
  `same`/`source`.

## Driftsättning

- `ADMIN_PASSWORD` sätts i `.env` på driftservern (inte i detta repo) -
  används redan för alla admin-endpoints, `/swipe` läggs bara till i samma
  gate.
