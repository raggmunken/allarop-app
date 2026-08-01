# Attribut-justerad fynd-uppskattning (design)

Datum: 2026-08-01

## Problem

Fynd-motorn (`src/price/estimate.ts`, `src/db/similar.ts`) flaggar ett aktivt
objekt som "fynd" när dess pris ligger klart under medianen av jämförbara
sålda objekt. Jämförbarheten avgörs idag av `attrsCompatible()`, som bara
gatar på **kategoriska** attribut (märke/modell/designer/typ/epok) - och
**saknade** attribut gatar aldrig. Det ger två sorters fel:

1. **Kategorisk felmatchning som borde gatats men inte gjorde det.** Konkret
   observerat fall: "Oyster Perpetual katalog från Rolex, 2007" (en tryckt
   klockkatalog) klassades via nyckelordsregeln `/rolex/` som
   `smycken/klockor` och jämfördes mot 53 sålda **riktiga klockor** -> ett
   påstått "100 % under"-fynd på ett objekt som inte alls är en klocka.
   `attrs.t` (typsubstantiv) hade sannolikt inte extraherats för objektet,
   så gaten hade inget att gata på.
2. **Kontinuerliga attribut som borde JUSTERA priset men idag varken gatar
   eller justerar.** En bil med 100 000 mil och en med 10 000 mil, annars
   samma märke/modell/år, behandlas som lika jämförbara - ingen justering för
   miltal. Samma problem för elektronikens batterihälsa/lagring/originalkartong
   och möblers skick/ålder. Resultat: falska fynd-flaggor drivna av faktorer
   motorn inte känner till, snarare än av ett verkligt bra pris.

Dessutom: sök visar inte hur många objekt/källor som faktiskt genomsöktes,
och sökordsträffar är asymmetriska ("kyl" hittar "glas kyl" men "glas" gör
det inte) - **utanför scope för detta dokument**, hanteras som separata
spår (se "Relaterat, ej i scope" nedan).

## Mål

- Byt ut "gate eller inget" mot "gate på kategoriska attribut + **prisjustera**
  för kontinuerliga attribut" för tre kategorigrupper i v1:
  `fordon/personbilar`, `elektronik/mobil`, `mobler/mobler-sub`.
- Justeringsfaktorerna **lärs** periodiskt ur `price_history`, appliceras
  billigt (ingen extra AI-kostnad) vid uppskattning.
- Aldrig anta "genomsnitt" för ett attribut som saknas på målobjektet - falla
  tillbaka till dagens medianuppskattning och sänk träffsäkerheten synligt.
- Ramverket ska vara generellt (en pipeline, parametrisk per kategori) så fler
  kategorier kan läggas till senare utan omskrivning.

## Icke-mål (v1)

- Andra kategorier än de tre namngivna (TV, klockor, båtar, ...).
- Live-LLM-bedömning per prisjämförelse (för dyrt/långsamt vid denna skala,
  se avvägning nedan).
- Sökrelevans-buggen och saknade träff-räknare i sök-UI:t (separata spår).

## Arkitektur / dataflöde

```
Objekt ingestas
  -> LLM-klassning (classify-llm.ts, BEFINTLIGT anrop, utökad prompt)
     extraherar attrs (b/m/d/t/y/mat + NYA kategorispecifika fält)
  -> [endast fordon] biluppgifter.se-berikning fyller fuelType/drivetrain/
     firstRegYear auktoritativt via regnr (befintlig integration)
  -> attrs lagras på items.attrs (jsonb, utökat schema)

Periodisk tränings-pass (NYTT, src/price/learn-adjustments.ts)
  -> för varje kategorigrupp: gruppera price_history på märke+modell
     (fordon), enhetsmodell (elektronik) eller designer+modell (möbler,
     återanvänder quotedModels/modelMatch)
  -> där gruppen har tillräckligt underlag: OLS-regression
     log(pris) ~ intercept + kategorispecifika features
  -> för tunna grupper: bredare kategorinivå-regression med märke/modell
     som faktor, om ens det har underlag - annars ingen modell
  -> koefficienter + sample_n + r2 + trained_at lagras i ny tabell
     price_models

Uppskattningspass (BEFINTLIGT, price/estimate.ts, utökat)
  -> finns tränad modell för objektets grupp OCH är objektets egna
     relevanta attribut kända?
       JA  -> uppskatta värde direkt ur modellen (ersätter medianen)
       NEJ -> dagens beteende oförändrat (median av gate:ade jämförbara)
  -> lagras med est_basis ('model'|'median') så UI kan visa träffsäkerhet
```

## Datamodell

**`ItemAttrs`** (`src/db/similar.ts`) utökas per kategorigrupp (fält utelämnas
när de inte kan beläggas - aldrig gissade, samma princip som idag):

| Kategori | Nya fält |
|---|---|
| `fordon/personbilar` | `mileageKm`, `fuelType`, `drivetrain` |
| `elektronik/mobil` | `storageGb`, `batteryPct`, `conditionGrade`, `origBox` |
| `mobler/mobler-sub` | `conditionGrade` (delar skala med elektronik) |

`conditionGrade`: delad ordinalskala 1-5 (skadat/defekt -> slitet -> normalt
skick/begagnat -> mycket bra skick -> nyskick/oanvänt). Ersätter/utökar
dagens grova `ny`/`otestad`-regex i `repo.ts` (`COND_CASE`).

**Ny tabell `price_models`**: `category`, `group_key` (t.ex. "volvo|v70" eller
"iphone 15" eller kategorinivå-fallback), `feature`, `coefficient`,
`sample_n`, `r2`, `trained_at`. En rad per (grupp, feature).

**`items`**: nytt fält `est_basis` (`'model' | 'median' | null`) bredvid
befintliga `est_value_sek/est_count/est_p25/est_p75/est_at`.

## Attributextraktion

Regel-först, LLM-fallback (samma mönster som kategorisystemets
text-regler-fore-LLM):

- **Fordon**: `mileageKm` via regex på vanliga svenska mil-/km-format i
  titel/beskrivning ("18 000 mil" = 180 000 km - **mil ≠ km, måste
  konverteras korrekt**), LLM som fallback för otydlig fras. `fuelType`/
  `drivetrain`/`firstRegYear` hämtas **auktoritativt** via befintlig
  biluppgifter.se-uppslagning på regnr - inte gissat ur text.
- **Elektronik/mobil**: `storageGb`/`batteryPct`/`origBox` via regex på
  vanliga format ("128GB", "89 % batterihälsa", "orginalkartong"/
  "originalförpackning"), LLM-fallback. `conditionGrade` klassas av LLM
  (samma anrop som idag, utökad prompt).
- **Möbler**: `conditionGrade` klassas av LLM ur beskrivning, ersätter
  `COND_CASE`-regexen med samma skala som elektronik.

Allt extraheras i **samma** LLM-anrop som dagens klassning
(`classify-llm.ts`) - ingen ny AI-kostnad, bara en utökad prompt/svar-schema
för de tre kategorigrupperna.

## Träningspipeline

`src/price/learn-adjustments.ts`, nytt periodiskt bakgrundspass (samma
kadens-mönster som schemaläggarens övriga pass, t.ex. dagligen):

1. Per kategorigrupp: hämta `price_history`-rader med relevanta attrs
   populerade.
2. Gruppera på grupperingsnyckeln (märke+modell / enhetsmodell /
   designer+modell).
3. Grupp med `sample_n >= MIN_GROUP_N` (default 30, env-styrbar): fitta OLS
   `log(pris) ~ intercept + features` för den gruppens features.
4. Grupp under tröskeln: försök en bredare kategorinivå-regression (märke/
   modell som faktor) om DEN har underlag - annars ingen modell för gruppen,
   `estimate.ts` faller tillbaka till median oförändrat.
5. Skriv/uppdatera `price_models`-rader. Ingen ny dependency - OLS
   (normalekvationer) är sluten form och några dussin rader; inget
   regressions-/ML-bibliotek finns redan i `package.json` och inget behövs.

## Applicering vid uppskattning

I `price/estimate.ts`, för objekt i en av de tre kategorigrupperna:

- Modell finns för objektets grupp **och** objektets egna relevanta attribut
  är kända -> `est_value_sek` = modellens prediktion, `est_basis='model'`.
- Annars -> dagens median-av-jämförbara, oförändrat, `est_basis='median'`.
- **Aldrig anta genomsnitt för ett okänt attribut.** Om modellen finns men
  t.ex. miltal saknas på just detta objekt: fall tillbaka till median (inte
  modellens genomsnittsprediktion) - annars återskapar vi exakt samma
  falska-säkerhet-problem som idag.

`FYND_PCT`-beräkningen i `repo.ts` behöver ingen strukturell ändring - den
konsumerar `est_value_sek` oavsett `est_basis`, men UI:t visar basis så
transparensen finns kvar (samma princip som avgiftsmotorns `basis`-fält).

## UI

- Återanvänd avgiftsmotorns transparensmönster (`basis`: source/percentage/
  external/estimate) för prisuppskattningar: visa om ett fynd är
  modell-justerat eller platt median.
- Visa extraherade attribut som chips bredvid prisjämförelsen ("18 000 mil,
  bensin, 4×4" / "128GB, 89% batteri, med kartong" / "mycket bra skick") så
  användaren kan syna uppskattningen.
- Fynd-badgens tooltip uppdateras för att nämna justeringen när `est_basis
  ='model'`.

## Testning

Vitest, en fil per ny modul (följer befintligt mönster: en fil per
connector/modul):

- `learn-adjustments.test.ts`: OLS-fit på syntetisk data med känd koefficient
  -> återfinns inom tolerans. Tröskel-fallback (för få rader -> ingen
  modell).
- Regex-extraktion (mil->km-konvertering, batteriprocent, lagringsstorlek,
  originalkartong) - fokus på mil/km-fällan.
- `estimate.test.ts`-utökning: modell-väg vs. median-fallback-väg, och att
  saknat målattribut ALDRIG leder till modell-prediktion.

## Relaterat, ej i scope (separata spår)

- **Kategoriklassning**: hur mycket husets egen kategori ska väga in
  (nuvarande hybrid: llm > learned > text > house > mixed > none). Hänger
  ihop med Rolex-katalog-fallet men är ett eget beslut.
- **Sök**: "kyl"/"glas"-asymmetrin (bugg, ej designfråga) och saknad
  träff-räknare per källa i sök-UI:t.

## Öppna frågor

- Exakt tröskelvärde `MIN_GROUP_N` (30 föreslaget) - kan behöva justeras per
  kategori när verklig datavolym är känd.
- Om ANPR-läsning av registreringsskylten ska trigga en biluppgifter.se-
  uppslagning proaktivt för alla fordonsannonser, eller bara vid
  fynd-uppskattning (kostnads-/frekvensavvägning, biluppgifter.se har
  sannolikt anrop-kostnad/gräns).
