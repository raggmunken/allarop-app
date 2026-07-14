/**
 * Avgiftsmodeller per auktionshus. Lagras här i kod för MVP; flyttas till
 * databasen (auction_houses.fee_model jsonb) när de blir många/ändras ofta.
 */

import { FeeModel, PercentageFeeModel } from "./engine.ts";
import { BIDFLOW_HOUSES } from "../connectors/bidflow/houses.ts";
import { GAK_HOUSES } from "../connectors/gak/houses.ts";

export const FEE_MODELS: Record<string, FeeModel> = {
  /**
   * Toveks faktiska modell (verifierad mot deras FAQ + objektdata 2026-06):
   *   - Slagavgift = en FAST avgift per objekt baserad på startpriset
   *     (= itemFeeValue, i kronor).
   *   - Moms = en procentsats per objekt (= itemVatValue, t.ex. 25 % eller
   *     0 % för momsbefriade lott som fastighet). FAQ: "på slagavgiften
   *     tillkommer alltid 25 % moms".
   *   - Dessutom: expeditionsavgift 30 kr exkl. moms PER FAKTURA (inte per
   *     objekt) — läggs inte på per objekt här.
   *
   * Två separata momssatser:
   *  - Objektet (budet): itemVatValue % (0 eller 25 — momsbefriat eller ej).
   *  - Slagavgiften (itemFeeValue, "exkl. moms"): ALLTID 25 % (momspliktig tjänst).
   * Ex 1 (skrivbord): bud 600 (25%) + slagavg 250 (25%) → 750 + 312,50 = 1 062,50.
   * Ex 2 (båt): bud 20 000 (0%) + slagavg 1 300 (25%) → 20 000 + 1 625 = 21 625.
   */
  tovek: {
    kind: "source",
    feeVatRate: 25,
  },

  /**
   * Auctionet: köparprovision (INKL moms) + fast slagavgift, per LAND. Verifierat
   * mot auctionet.com/sv/help/22-buyer-fees 2026-06. Modellen väljs per objekt via
   * valutan i `feeModelForItem` (se AUCTIONET_BY_CURRENCY). Detta är fallback (SE).
   * OBS: utländska objekt kan dessutom få införselmoms/tull vid import (ej fast).
   */
  auctionet: {
    kind: "percentage",
    premiumRate: 0.25,
    lotFeeKr: 80,
    vatRate: 0,
  },

  /**
   * Riksauktioner (verifierat mot deras FAQ 2026-06):
   *   - Klubbavgift = 10 % av köpeskillingen, MINST 100 kr, MAX 10 000 kr,
   *     exkl. moms → +25 % moms på avgiften.
   *   - Objektsmoms = 25 % på budet, men 0 % för momsbefriade (vissa fordon).
   *     Sätts per objekt via no_tax → NormalizedItem.vatRate (0 eller 25).
   * Ex: bud 100 (25 %) → avgift max(10,100)=100 → moms 25+25 → att betala 250.
   */
  riksauktioner: {
    kind: "percentage",
    premiumRate: 0.10,
    premiumMinKr: 100,
    premiumMaxKr: 10000,
    vatRate: 0.25,
    vatOnTotal: false,
  },

  /**
   * Fabeo (industri-/maskinauktioner) — samma struktur som Tovek (verifierat mot
   * objektsidornas avgiftstext 2026-06):
   *   - Slagavgift = ett FAST kronbelopp PER OBJEKT, satt av säljaren och olika
   *     mellan objekt (ex. 10 500 kr resp. 25 000 kr), anges "exkl. moms".
   *   - Objektsmoms = "25 % moms tillkommer på lagt bud" (kan vara 0 % för
   *     momsbefriade objekt). Sätts per objekt via NormalizedItem.vatRate.
   * Båda momssatserna separata: slagavgiften får ALLTID 25 % (momspliktig tjänst,
   * `feeVatRate`), budet får objektets egen sats. Avgiftsbeloppet (slagavgift)
   * hämtas per objekt ur objektsidan → NormalizedItem.feeValue.
   * Ex: bud 152 000 (25 %) + slagavgift 10 500 (25 %) → moms 38 000 + 2 625,
   * total 152 000 + 10 500 + 40 625 = 203 125 kr.
   */
  fabeo: {
    kind: "source",
    feeVatRate: 25,
  },

  /**
   * Bukowskis ONLINE-auktioner (verifierat mot bukowskis.com/help/buyer_terms +
   * websök 2026-06): köparprovision 25 % INKL moms på klubbat pris + fast
   * admin-avgift 50 SEK / 5,06 EUR INKL moms per objekt. Provisionen anges inkl.
   * moms → vatRate 0 (ingen extra avgiftsmoms). Objektsmoms: de flesta lotter är
   * marginalbeskattade (moms ingår i provisionen) → NormalizedItem.vatRate 0. Den
   * fasta avgiften väljs per objekt via valutan i `feeModelForItem`
   * (BUKOWSKIS_BY_CURRENCY). Ex (SEK): bud 4 200 → 4 200×1,25 + 50 = 5 300.
   * (Följerätt ≤5 % på viss konst kan tillkomma men kan ej fås per objekt ur listan.)
   */
  bukowskis: {
    kind: "percentage",
    premiumRate: 0.25,
    lotFeeKr: 50,
    vatRate: 0,
  },

  /**
   * BNA (bna.nu — konkurs-/dödsboauktioner) — verifierat mot objektsidornas
   * avgiftstext + totalexempel 2026-06:
   *   - Köpavgift = 12 % av budet, anges "exkl. moms" → +25 % moms PÅ avgiften.
   *   - Objektsmoms = 25 % på budet för momspliktiga objekt (konkursvaror), 0 %
   *     för momsfria (t.ex. fordon/marginalbeskattat). Sätts PER OBJEKT via
   *     objektsidans "Moms tillkommer med 25%"-text → NormalizedItem.vatRate.
   * Ex 1 (byggstaket, moms): bud 2 200 → 2 200 + 264 + 66 + 550 = 3 080.
   * Ex 2 (husbil, momsfri): bud 100 000 → 100 000 + 12 000 + 3 000 = 115 000.
   */
  bna: {
    kind: "percentage",
    premiumRate: 0.12,
    vatRate: 0.25,
  },

  /**
   * Klaravik (maskiner/fordon/lantbruk) - API:t ger den EXAKTA köpar-
   * förmedlingsavgiften per objekt (`auctionFee` i kr, en tiernivå), så vi
   * använder source-läget med avgiften direkt (likt Tovek). Avgiften anges inkl.
   * moms → feeVatRate 0. Objektsmoms på budet (0/25 %) varierar per objekt och
   * sätts via NormalizedItem.vatRate (Fordon = 0 %/VMB, maskinkategorier = 25 %;
   * exakt momssats hämtas för heta objekt via fetchItem). Ex (maskin, 25 %): bud
   * 3 000 000 + moms 750 000 + avgift 50 000 = 3 800 000.
   */
  klaravik: {
    kind: "source",
    feeVatRate: 0,
  },

  /**
   * Blinto (maskiner/fordon/verktyg) - samma struktur som Tovek/Fabeo (verifierat
   * mot objektsidans avgiftstext 2026-06): "25 % moms tillkommer på lagt bud, samt
   * slagavgift på X SEK (exkl. moms)". Slagavgift = fast kronbelopp per objekt
   * (exkl. moms → alltid +25 % på avgiften, feeVatRate 25). Objektsmoms 25 % på
   * budet, eller 0 % vid "Momsfri försäljning" (per objekt via NormalizedItem.vatRate).
   * Ex: bud 249 000 (25 %) + slagavgift 8 400 (25 %) → 311 250 + 10 500 = 321 750.
   */
  blinto: {
    kind: "source",
    feeVatRate: 25,
  },

  /**
   * PS Auction (nät-/konkursauktioner, maskiner/fordon/lösöre) - verifierat mot
   * objektsidans avgiftstext 2026-06: "SERVICEAVGIFT: 16% av vinnande bud" (samma
   * 16 % på alla kontrollerade auktioner) + "(EXKL 25% MOMS)" → +25 % moms PÅ
   * serviceavgiften. Objektsmoms varierar per objekt (25 % momspliktigt, eller 0 %
   * marginalbeskattat "inkl ej avlyftbar moms") → sätts via NormalizedItem.vatRate
   * ur /item/json (bid `vat` 25/0). Samma struktur som BNA (percentage + avgiftsmoms).
   * Ex (25 %): bud 100 → 100 + 25 (objektsmoms) + 16 (avgift) + 4 (moms på avgift) = 145.
   */
  psauction: {
    kind: "percentage",
    premiumRate: 0.16,
    vatRate: 0.25,
  },

  /**
   * Retrade (retrade.eu, nordisk industri-/B2B-auktion) - verifierat mot deras
   * terms (/sv/terms, "Kostnader och Avgifter") 2026-06: "Auktionsavgiften
   * varierar i storlek beroende på ditt bud och visas tydligt på bud-bekräftelsen,
   * när du lägger ditt bud" + betalningsavgift 250 SEK exkl moms. Avgiften är alltså
   * en GLIDANDE SKALA som bara avslöjas vid budläggning (bakom inloggning) - finns
   * INTE i publika API:t, och objektsmoms (0/25 %) saknas också. → external-läge:
   * vi visar budet och markerar "auktionsavgift + moms tillkommer", ingen fejkad total.
   */
  retrade: {
    kind: "external",
  },

  /**
   * Netauktion (netauktion.se = Netauctions) - verifierat mot objektsidans
   * avgiftstext 2026-06: "Slagavgift 12% exkl. moms tillkommer budet (min: 100 kr
   * - max: 50 000 kr exkl moms)" → percentage-läge: 12 % köpavgift, golv 100 kr,
   * tak 50 000 kr, + 25 % moms PÅ avgiften. Objektsmoms på budet 25 % (budet anges
   * "exkl moms") eller 0 % för momsfria, per objekt via NormalizedItem.vatRate.
   * Ex: bud 300 (25 %) → avgift max(36,100)=100 + moms 25 + objektsmoms 75 = total 500.
   */
  netauktion: {
    kind: "percentage",
    premiumRate: 0.12,
    premiumMinKr: 100,
    premiumMaxKr: 50000,
    vatRate: 0.25,
  },

  /**
   * Kronofogden (Sveriges exekutiva myndighet, säljer utmätt gods via Auction2000) -
   * verifierat mot objektsidan 2026-06: "Avgifter: Inga avgifter tillkommer!" → INGEN
   * köparavgift. Source-läge med feeValue 0 + vatRate 0 (sätts på objektet) → totalpris
   * = budet. (Ev. moms är redan inbakad i budet; inget LÄGGS till.)
   */
  kronofogden: {
    kind: "source",
  },

  /**
   * Junora (junora.se, .NET-auktionsmotor bakom Shopify). Slagavgiften publiceras inte
   * (bara synlig inloggad) MEN vi bevisade (inloggad harvest 2026-06-29) att den är
   * DETERMINISTISK på reservationspriset - som API:t läcker (reserve_price). Vi räknar
   * därför en UNGEFÄRLIG slagavgift ur en harvestad trapp-tabell (junora/fee.ts) +
   * bud-moms ur säljartyp (företag 25 / privat 0). → source-läge med approximate (UI
   * visar "≈"-total). feeVatRate 0: harvest-värdet är redan köparens slagavgift inkl
   * moms → läggs på rakt. Saknas reservpris (ej berikat/inget) → external ("+ avgift").
   */
  junora: {
    kind: "source",
    feeVatRate: 0,
    approximate: true,
    externalFallback: true,
  },

  /**
   * Frivio (frivio.se) - fritidsfordon (husvagn/husbil/båt). Slagavgift = hammer_fee %
   * (verifierat 5 % på samtliga, "läggs ovanpå vinnande budet, framgår på fakturan")
   * + 25 % moms PÅ avgiften (svensk standard, som Netauktion/PS). Objektsmoms på budet
   * per objekt (NormalizedItem.vatRate): privatperson 0 (momsfri/VMB, majoriteten),
   * företag 25 (ur detaljens `foretag`). Ex privat bud 100000 → 100000 + 5000 + 1250 = 106250.
   */
  frivio: {
    kind: "percentage",
    premiumRate: 0.05,
    vatRate: 0.25,
  },

  /**
   * Sikö Auktioner (sikoauktioner.se) - traditionellt konst-/kvalitetsauktionshus.
   * Avgift ur detalj-JS: `provisionKop = 18` (18 % köparprovision) + `slagavgiftKop = 28`
   * (28 kr fast slagavgift/lot). Provisionen är konsumentinriktad → INKL moms (vatRate 0,
   * som Bukowskis/Auctionet). Lotterna är mest privatsålt konst/lösöre → objektsmoms 0
   * (VMB/momsfri). Ex bud 1000 → 1000 + 180 + 28 = 1208.
   */
  siko: {
    kind: "percentage",
    premiumRate: 0.18,
    lotFeeKr: 28,
    vatRate: 0,
  },

  /**
   * Upplands Auktionsverk (upplandsauktionsverk.se, bbys/Next.js). Köparvillkoren ligger
   * PER AUKTION i öppna /api/auctions (upptäckt 2026-07-03): buyersPremium (% EXKL moms)
   * + hammerFees.buyer.total (slagavgift inkl moms). Verifierat mot auktionssidans
   * villkorstext ("provision på 25% inkl moms samt slagavgift på 30kr" = API:ts 20+24).
   * Connectorn räknar feeValue (inkl moms) per objekt → source; utan bud/villkor → external.
   */
  upplands: {
    kind: "source",
    feeVatRate: 0,
    externalFallback: true,
  },

  /**
   * Metropol Auktioner (metropol.se) - klassiskt konsthus. Verifierat mot objektsidans
   * budbekräftelse 2026-07-03: "Tänk på att det tillkommer 25% + 100 kronor på det
   * klubbade priset" → percentage 25 % + 100 kr fast (kundpris, inkl moms → vatRate 0).
   */
  metropol: {
    kind: "percentage",
    premiumRate: 0.25,
    lotFeeKr: 100,
    vatRate: 0,
  },

  /**
   * Pantbanken Sverige (pantbanken.se) - pantauktioner (klockor/smycken/guld/design).
   * Verifierat mot deras villkor 2026-06: "15 % i provision. På antaget bud tillkommer 15
   * procent i provision. Om du t.ex. bjudit 1000 kr ... får du betala 1150 kr." → percentage
   * 15 %, INKL moms (vatRate 0, som Bukowskis/Sikö). Ingen objektsmoms adderas (panter/
   * begagnat = VMB). Total = bud * 1,15. (Konstnärsavgift/BUS kan tillkomma på konst märkt
   * "omfattas av BUS-avgift" - item-specifikt, ej beräkningsbart ur listan → utelämnas.)
   */
  pantbanken: {
    kind: "percentage",
    premiumRate: 0.15,
    vatRate: 0,
  },

  /**
   * Budi Auktioner (budi.se) - konkurs-/B2B-nätauktioner. Serviceavgiftens PARAMETRAR
   * (fast belopp exkl moms ELLER procent-i-baspunkter + minimibelopp) ligger i objekt-
   * sidans data-budi-servicefee-*-attribut (upptäckt 2026-07-03) → feeValue räknas per
   * objekt (connector). ALLTID 25 % moms på avgiften (FAQ) → feeVatRate 25. Budets moms
   * (25/0) per objekt ur batch-API:t → sourceVatRate. Utan parametrar än → external
   * ("serviceavgift + moms tillkommer", ingen fejkad total).
   */
  budi: {
    kind: "source",
    feeVatRate: 25,
    externalFallback: true,
  },

  /**
   * Vaxxa (app.vaxxa.se) - konkurs-/självservice-nätauktioner. Serviceavgiften hämtas
   * per (objekt, aktuellt bud) via Server Action getProductFeeAction (upptäckt 2026-07-03;
   * hash auto-upptäcks ur JS-chunkar, se vaxxa/session.ts) → feeValue exkl moms; ALLTID
   * +25 % moms på avgiften (objektsidans FAQ) → feeVatRate 25. Budets moms styrs av
   * objektsidans is_taxable (1 → 25 %, 0 → momsfri) → sourceVatRate. Utan hämtad avgift →
   * external ("serviceavgift + moms tillkommer", ingen fejkad total).
   */
  vaxxa: {
    kind: "source",
    feeVatRate: 25,
    externalFallback: true,
  },

  /**
   * Auktiona (auktiona.se, gobid) - konkurs-/likvidation. Verifierat mot Firestore-settings
   * 2026-07-01: `serviceFee` är nästan alltid `type:"none"` (0 kr) och `vat.included=true`
   * (25 % moms INGÅR i budet). Köparen betalar alltså BUDET (+ ev. serviceavgift, per objekt
   * ur settings → NormalizedItem.feeValue). → source-läge, feeVatRate 0 (avgiften anges inkl
   * moms), och objektet får vatRate 0 (momsen ligger redan i budet). Total = bud + serviceavgift.
   */
  auktiona: {
    kind: "source",
    feeVatRate: 0,
  },

  /**
   * Tradera (tradera.se) - Sveriges största begagnatmarknad. Vi hämtar ENBART SÅLDA
   * objekt för prishistorik (recon 2026-07-08). Annonser mellan privatpersoner har
   * ingen köparprovision/moms: `price` ÄR vad varan gick för → source-läge utan
   * avgift, total = pris. (Företagssäljare kan ha moms inbakad i priset; vi lägger
   * aldrig på något. "Hellre inget än fel.")
   */
  tradera: {
    kind: "source",
  },

};

// GAK-plattformens hus (Göteborgs Auktionskammare, Auktionskammaren ...): avgiften ligger
// i detaljsidans priceInfo-attribut per objekt (data-purchase-fee % + data-auction-fee kr,
// INKL moms; GAK 20 %+50, Auktionskammaren 25 %+50 enl. villkor) → connectorn räknar
// feeValue; objektsmoms (data-item-vat) → vatRate. Verifierat mot sidans "Totalt med
// avgift och moms" 2026-07-03. Utan attribut → external ("avgift tillkommer").
for (const h of GAK_HOUSES) {
  FEE_MODELS[h.house] ??= { kind: "source", feeVatRate: 0, externalFallback: true };
}

// Alla Bidflow-hus (Sajab, Effecta, Effecta Maskin, Haraldssons ...): köparprovisionen
// varierar per auktion men exponeras av LotsApi/getProvisions → connectorn kalibrerar en
// linjär modell per auktion (2 prober) och sätter feeValue INKL moms (feeVatRate 0; ev.
// budmoms fångad i linjen → vatRate 0). Utan kalibrering (trapptabell/fel) → external
// ("köparprovision + ev. moms tillkommer", ingen fejkad total).
for (const h of BIDFLOW_HOUSES) {
  FEE_MODELS[h.house] ??= { kind: "source", feeVatRate: 0, externalFallback: true };
}

export function feeModelFor(house: string): FeeModel {
  return FEE_MODELS[house] ?? { kind: "source" };
}

/**
 * Auctionets köparavgift per LAND (valutan = landsproxy), verifierat mot
 * auctionet.com/sv/help/22-buyer-fees 2026-06. Köparprovisionen anges INKL moms
 * (vatRate 0), plus en fast slagavgift i objektets valuta:
 *   SE 25 % + 80 SEK · DK 25 % + 70 DKK · UK 33,6 % + 5 GBP · EUR 25 % + 8 EUR.
 * Ex (SE): bud 1000 → 250 provision + 80 slagavgift = 1 330. Maxsatser; faktisk
 * köparprovision kan vara lägre per hus (ej publikt). Följerätt (≤5 % på viss
 * konst) och införselmoms/tull (utländsk import) tillkommer men kan ej fås ur API.
 */
const AUCTIONET_BY_CURRENCY: Record<string, PercentageFeeModel> = {
  SEK: { kind: "percentage", premiumRate: 0.25, lotFeeKr: 80, vatRate: 0 },
  DKK: { kind: "percentage", premiumRate: 0.25, lotFeeKr: 70, vatRate: 0 },
  GBP: { kind: "percentage", premiumRate: 0.336, lotFeeKr: 5, vatRate: 0 },
  EUR: { kind: "percentage", premiumRate: 0.25, lotFeeKr: 8, vatRate: 0 },
};
const AUCTIONET_DEFAULT: PercentageFeeModel = {
  kind: "percentage",
  premiumRate: 0.25,
  lotFeeKr: 0,
  vatRate: 0,
};

/**
 * Bukowskis fasta admin-avgift per objekt anges i objektets valuta (50 SEK /
 * 5,06 EUR INKL moms). Köparprovision 25 % inkl moms (vatRate 0). Väljs per objekt
 * via valutan (Bukowskis listar både SEK- och EUR-lotter).
 */
const BUKOWSKIS_BY_CURRENCY: Record<string, PercentageFeeModel> = {
  SEK: { kind: "percentage", premiumRate: 0.25, lotFeeKr: 50, vatRate: 0 },
  EUR: { kind: "percentage", premiumRate: 0.25, lotFeeKr: 5.06, vatRate: 0 },
};
const BUKOWSKIS_DEFAULT: PercentageFeeModel = {
  kind: "percentage",
  premiumRate: 0.25,
  lotFeeKr: 50,
  vatRate: 0,
};

/** Avgiftsmodell för ETT objekt — Auctionet/Bukowskis väljs per land/valuta. */
export function feeModelForItem(house: string, currency?: string | null): FeeModel {
  const cur = (currency ?? "SEK").toUpperCase();
  if (house === "auctionet") {
    return AUCTIONET_BY_CURRENCY[cur] ?? AUCTIONET_DEFAULT;
  }
  if (house === "bukowskis") {
    return BUKOWSKIS_BY_CURRENCY[cur] ?? BUKOWSKIS_DEFAULT;
  }
  return feeModelFor(house);
}
