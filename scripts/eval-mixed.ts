import { pool } from "../src/db/pool.ts";
import { classifyByText, PARTIER } from "../src/categories/classify.ts";
import { CAT_LABELS } from "../src/categories/taxonomy.ts";
const { rows } = await pool.query<{title:string;description:string|null}>("SELECT title,description FROM items WHERE status='active' AND title IS NOT NULL");
let partier=0, text=0, none=0;
for(const r of rows){const k=classifyByText(r.title,r.description); if(k===PARTIER)partier++; else if(k)text++; else none++;}
console.log(`totalt ${rows.length}: text-klassade ${text} (${(text/rows.length*100).toFixed(1)}%), BLANDAT/partier ${partier} (${(partier/rows.length*100).toFixed(1)}%), oklassade ${none} (${(none/rows.length*100).toFixed(1)}%)`);
console.log("\n=== objekt med blandlåde-ord → hamnar de i Blandat? ===");
const mix=rows.filter(r=>/blandl|d[öo]dsbo|diverse f|\bparti\b|blandade|blandat/i.test(r.title)).slice(0,12);
for(const r of mix){const k=classifyByText(r.title,r.description); const l=k?CAT_LABELS[k]:null; console.log(`  [${(l?l.main+">"+l.sub:k||"oklassad").padEnd(26)}] ${r.title.slice(0,55)}`);}
console.log("\n=== falska positiva? homogena 'parti/samling' som borde vara specifika ===");
const homo=rows.filter(r=>/\bparti\b|\bsamling\b/i.test(r.title) && !/blandl|d[öo]dsbo|diverse/i.test(r.title)).slice(0,8);
for(const r of homo){const k=classifyByText(r.title,r.description); const l=k?CAT_LABELS[k]:null; console.log(`  [${(l?l.main+">"+l.sub:k||"oklassad").padEnd(26)}] ${r.title.slice(0,55)}`);}
await pool.end();
