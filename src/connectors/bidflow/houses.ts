/**
 * Bidflow-hus: alla kör samma plattform → en config-driven connector räcker. Listan
 * kommer ur bidflow.com/api/ITenantsApi/getTenants (svenska tenants med fungerande API).
 * Lägg till nya Bidflow-hus genom att lägga till en rad här (verifiera att
 * {baseUrl}/api/IHomeInfoApi/getActiveAndHistoryAuctionsCatalog svarar 200).
 */

export interface BidflowHouseConfig {
  /** Husnyckel i DB (gemener, a-z). */
  house: string;
  /** Visningsnamn (frontend-label + auction_houses). */
  name: string;
  /** Säljarnamn per objekt (seller-kolumnen). */
  seller: string;
  /** Bidflow-plattformens domän (där /api/ ligger) - OBS ej alltid marknadssajten. */
  baseUrl: string;
  /** Domän för frontend/avgift-registrering. */
  domain: string;
  /** True om tenanten bot-skyddar API:t (TLS-fingerprint) → route via CloakBrowser. */
  useBrowser?: boolean;
}

export const BIDFLOW_HOUSES: BidflowHouseConfig[] = [
  // Sajab - lantbruk/maskin/veteran (marknadssajt sajab.se/sajablantbruk.com → plattform .se).
  { house: "sajab", name: "Sajab", seller: "Sajab", baseUrl: "https://sajablantbruk.se", domain: "sajablantbruk.se" },
  // Auktionsbyrån Effecta (tenant +1) - bot-skyddat API → CloakBrowser.
  { house: "effecta", name: "Auktionsbyrån Effecta", seller: "Auktionsbyrån Effecta", baseUrl: "https://www.byraneffecta.se", domain: "byraneffecta.se", useBrowser: true },
  // Effecta Maskin (tenant +100) - maskin/entreprenad (egen Bidflow-instans, oskyddad).
  { house: "effectamaskin", name: "Effecta Maskin", seller: "Auktionsbyrån Effecta", baseUrl: "https://maskin.byraneffecta.se", domain: "maskin.byraneffecta.se" },
  // Haraldssons Auktioner (tenant +3) - bot-skyddat API → CloakBrowser.
  { house: "haraldssons", name: "Haraldssons Auktioner", seller: "Haraldssons Auktioner", baseUrl: "https://www.haraldssonsauktioner.se", domain: "haraldssonsauktioner.se", useBrowser: true },
];
