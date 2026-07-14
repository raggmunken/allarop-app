import { classifyByText } from "../src/categories/classify.ts";
import { CAT_LABELS } from "../src/categories/taxonomy.ts";
const cases = [
  "Skruv & bult parti - blandade dimensioner, insex och sexkant",
  "Blandat parti tallrikar, glas, kannor och husgeråd",
  "Parti Belysning 8st",
  "Blandade smycken guld och silver",
  "Blandlåda: porslin, verktyg, böcker och leksaker",
  "Dödsbo - diverse föremål",
  "Diverse prylar från garage",
  "Blandlåda med verktyg",
  "TV, soffa och matbord",
];
for (const c of cases) {
  const k = classifyByText(c);
  const l = k ? CAT_LABELS[k] : null;
  console.log(`  [${(l ? l.main + " > " + l.sub : k || "oklassad").padEnd(32)}] ${c}`);
}
