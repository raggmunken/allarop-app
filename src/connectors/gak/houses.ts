/**
 * Hus på samma custom-PHP-plattform som Göteborgs Auktionskammare (identisk markup:
 * /auktion/objekt-översikt + data-item-id-kort + /auktion/objekt/{slug}/{id} + itemDescription).
 * EN config-driven connector räcker (som Bidflow). Lägg till nytt hus = en rad här
 * (verifiera att {baseUrl}/auktion/objekt-översikt ger data-item-id-kort).
 */

export interface GakHouseConfig {
  house: string;
  name: string;
  seller: string;
  baseUrl: string;
  domain: string;
}

export const GAK_HOUSES: GakHouseConfig[] = [
  {
    house: "gak",
    name: "Göteborgs Auktionskammare",
    seller: "Göteborgs Auktionskammare",
    baseUrl: "https://goteborgsauktionskammare.se",
    domain: "goteborgsauktionskammare.se",
  },
  {
    house: "auktionskammaren",
    name: "Auktionskammaren",
    seller: "Auktionskammaren",
    baseUrl: "https://auktionskammaren.se",
    domain: "auktionskammaren.se",
  },
];
