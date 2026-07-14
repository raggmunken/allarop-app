/**
 * Traderas toppkategorier (rot-id → namn), utvunna ur sajtens egen kategoriträdning
 * (homepage-flight, recon 2026-07-08). Crawlern startar från dessa och går djupare
 * ADAPTIVT via kategorifasetten (categoryTree) i varje svar när en nod överstiger
 * sökningens 500-träffs-tak - inga hårdkodade löv behövs.
 *
 * Kategorisidans URL: https://www.tradera.com/category/<id>
 */

export interface TraderaCategory {
  id: number;
  name: string;
}

export const TRADERA_ROOTS: TraderaCategory[] = [
  { id: 10, name: "Fordon" },
  { id: 11, name: "Böcker & Tidningar" },
  { id: 12, name: "Datorer & Tillbehör" },
  { id: 13, name: "DVD & Videofilmer" },
  { id: 14, name: "Foto, Kameror & Optik" },
  { id: 15, name: "Frimärken" },
  { id: 16, name: "Kläder" },
  { id: 17, name: "Hemelektronik" },
  { id: 18, name: "Hobby" },
  { id: 19, name: "Klockor" },
  { id: 20, name: "Antikt & Design" },
  { id: 21, name: "Musik" },
  { id: 22, name: "Mynt & Sedlar" },
  { id: 23, name: "Konst" },
  { id: 24, name: "Smycken & Ädelstenar" },
  { id: 25, name: "Sport & Fritid" },
  { id: 26, name: "Telefoni, Tablets & Wearables" },
  { id: 27, name: "Vykort & Bilder" },
  { id: 28, name: "Övrigt" },
  { id: 29, name: "Samlarsaker" },
  { id: 30, name: "TV-spel & Datorspel" },
  { id: 31, name: "Hem & Hushåll" },
  { id: 32, name: "Bygg & Verktyg" },
  { id: 33, name: "Barnkläder & Barnskor" },
  { id: 34, name: "Biljetter & Resor" },
  { id: 36, name: "Handgjort & Konsthantverk" },
  { id: 1605, name: "Trädgård & Växter" },
  { id: 1611, name: "Barnartiklar" },
  { id: 1612, name: "Accessoarer" },
  { id: 1623, name: "Skor" },
  { id: 302571, name: "Barnleksaker" },
  { id: 340736, name: "Skönhet" },
  { id: 1001386, name: "Fordonsdelar & tillbehör" },
];
