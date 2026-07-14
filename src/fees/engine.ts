/**
 * Avgiftsmotor — beräknar faktiskt totalpris (det användaren faktiskt betalar)
 * utifrån nuvarande bud + inrops-/slagavgift + moms.
 *
 * Två lägen, valbart per auktionshus:
 *   - "source": använd avgift/moms som källan redan anger per objekt
 *     (Tovek levererar itemFeeValue + itemVatValue → vi litar på dem).
 *   - "percentage": procentbaserad köpavgift med minsta kronbelopp, plus moms.
 *     Används för hus som inte exponerar färdiga belopp.
 *
 * Alla belopp i hela kronor om inget annat anges.
 */

export interface SourceFeeModel {
  kind: "source";
  /**
   * Momssats i PROCENT på SLAGAVGIFTEN — separat från objektets moms.
   * Toveks slagavgift anges "exkl. moms" och är en momspliktig tjänst, så den
   * får ALLTID 25 % moms även när objektet är momsbefriat (t.ex. båt: objekt 0 %
   * men slagavgift 1 300 kr → +25 % = 1 625 kr). Om utelämnad används objektets
   * momssats (sourceVatRate) även på avgiften.
   */
  feeVatRate?: number;
  /** Om källans avgift saknas, fall tillbaka på denna procentmodell. */
  fallback?: PercentageFeeModel;
  /**
   * Avgiften är en UNGEFÄRLIG uppskattning (t.ex. Junoras harvestade slagavgifts-
   * tabell) → basis blir "estimate" så UI:t kan markera totalen med "≈".
   */
  approximate?: boolean;
  /**
   * Saknas avgiftsvärde helt (inget reservpris berikat än) → returnera basis
   * "external" ("+ avgift") i stället för en avgiftslös total = budet.
   */
  externalFallback?: boolean;
}

export interface PercentageFeeModel {
  kind: "percentage";
  /** Köp-/inropsavgift i procent av budet, t.ex. 0.18 för 18 %. */
  premiumRate: number;
  /** Minsta avgift i kronor (golv). */
  premiumMinKr?: number;
  /** Högsta avgift i kronor (tak), t.ex. Riksauktioners 10 000 kr. */
  premiumMaxKr?: number;
  /**
   * Fast slagavgift som ADDERAS (i objektets valuta), t.ex. Auctionets
   * slagavgift (SE 80, DK 70, UK 5 GBP, EUR 8). Läggs ovanpå procentavgiften.
   */
  lotFeeKr?: number;
  /**
   * Momssats PÅ AVGIFTEN, t.ex. 0.25. Sätt 0 om avgiften redan anges INKL moms
   * (Auctionets köparprovision är inkl. moms → vatRate 0, ingen extra moms).
   */
  vatRate?: number;
  /** Om true läggs avgiftsmomsen på (bud + avgift) i stället för bara avgiften. */
  vatOnTotal?: boolean;
}

/**
 * "external": köparen betalar en avgift OVANPÅ budet, men den går INTE att
 * beräkna ur publik data (t.ex. Retrade: auktionsavgiften är en glidande skala
 * som bara visas vid budläggning). Vi hittar INTE på ett totalpris - visar budet
 * och markerar i UI att avgift + moms tillkommer (basis "external").
 */
export interface ExternalFeeModel {
  kind: "external";
}

export type FeeModel = SourceFeeModel | PercentageFeeModel | ExternalFeeModel;

export interface FeeInputs {
  /** Nuvarande/vinnande bud i kronor. */
  bid: number;
  /** Källans angivna avgift i kronor (Toveks itemFeeValue), om känd. */
  sourceFeeValue?: number | null;
  /** Källans momssats i PROCENT (Toveks itemVatValue, t.ex. 25 eller 0). */
  sourceVatRate?: number | null;
}

export interface FeeBreakdown {
  bid: number;
  fee: number;
  vat: number;
  total: number;
  /** Förklarar hur beloppen togs fram (för transparens i UI). "estimate" = ungefärlig. */
  basis: "source" | "percentage" | "external" | "estimate";
}

function round(n: number): number {
  return Math.round(n);
}

function computePercentage(
  bid: number,
  m: PercentageFeeModel,
  objectVatRate?: number | null,
): FeeBreakdown {
  let premium = Math.max(bid * m.premiumRate, m.premiumMinKr ?? 0);
  if (m.premiumMaxKr != null) premium = Math.min(premium, m.premiumMaxKr);
  const lotFee = m.lotFeeKr ?? 0; // fast slagavgift (Auctionet)
  // Moms på avgiften (0 om avgiften redan anges inkl. moms, t.ex. Auctionet) …
  const vatBase = m.vatOnTotal ? bid + premium : premium;
  const feeVat = (m.vatRate ?? 0) * vatBase;
  // … plus objektets egen moms på budet (per objekt, t.ex. Riks no_tax 0/25 %).
  const objVat = bid * ((objectVatRate ?? 0) / 100);
  const vat = feeVat + objVat;
  return {
    bid: round(bid),
    fee: round(premium + lotFee),
    vat: round(vat),
    total: round(bid + premium + lotFee + vat),
    basis: "percentage",
  };
}

/** Beräkna totalpris för ett objekt. */
export function computeTotal(inputs: FeeInputs, model: FeeModel): FeeBreakdown {
  const bid = inputs.bid || 0;

  if (model.kind === "external") {
    // Avgiften går ej att beräkna → visa budet, markera basis (UI: "avgift tillkommer").
    return { bid: round(bid), fee: 0, vat: 0, total: round(bid), basis: "external" };
  }

  if (model.kind === "source") {
    // externalFallback = "avgiften är kärnan": saknas avgiftsVÄRDET blir varje total
    // avgiftslös och vilseledande, även om momsen råkar vara känd → external direkt.
    if (model.externalFallback && inputs.sourceFeeValue == null)
      return { bid: round(bid), fee: 0, vat: 0, total: round(bid), basis: "external" };
    const hasSource =
      inputs.sourceFeeValue != null || inputs.sourceVatRate != null;
    if (hasSource) {
      const fee = inputs.sourceFeeValue ?? 0;
      // Objektets moms (på budet) och slagavgiftens moms hanteras SEPARAT.
      const objRate = (inputs.sourceVatRate ?? 0) / 100;
      const feeRate = (model.feeVatRate ?? inputs.sourceVatRate ?? 0) / 100;
      const vat = bid * objRate + fee * feeRate;
      return {
        bid: round(bid),
        fee: round(fee),
        vat: round(vat),
        total: round(bid + fee + vat),
        // Ungefärlig avgift (Junora) → "estimate" så UI:t visar "≈"; annars exakt "source".
        basis: model.approximate ? "estimate" : "source",
      };
    }
    if (model.fallback)
      return computePercentage(bid, model.fallback, inputs.sourceVatRate);
    // Saknas avgiftsvärde och modellen vill ha external-fallback → "+ avgift" (ej en
    // vilseledande avgiftslös total = budet).
    if (model.externalFallback)
      return { bid: round(bid), fee: 0, vat: 0, total: round(bid), basis: "external" };
    // Ingen avgiftsinfo alls — visa enbart budet, men markera basis.
    return { bid: round(bid), fee: 0, vat: 0, total: round(bid), basis: "source" };
  }

  return computePercentage(bid, model, inputs.sourceVatRate);
}
