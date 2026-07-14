import { pool } from "../src/db/pool.ts";
import { priceStats } from "../src/db/repo.ts";
const { rows } = await pool.query<{house:string;external_id:string;title:string;cur:string|null}>(
  "SELECT house, external_id, title, COALESCE(current_bid,min_bid) cur FROM items WHERE status='active' AND title ILIKE ANY(ARRAY['%makita%','%iphone%','%rolex%','%volvo%','%stol%']) ORDER BY random() LIMIT 6");
for(const r of rows){
  const s=await priceStats(r.title,{exclHouse:r.house,exclId:r.external_id,current:r.cur?Number(r.cur):null});
  console.log(`\n"${r.title.slice(0,45)}"`);
  if(s) console.log(`  ${s.count} sålda · min ${s.min} · snitt ${s.avg} · median ${s.median} · max ${s.max} kr`);
  else console.log("  (för få jämförbara)");
}
await pool.end();
