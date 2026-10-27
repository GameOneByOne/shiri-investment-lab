// Generate a reviewable pool update. Apply through Supabase SQL editor/admin.
import {readFile} from 'node:fs/promises';
const pool=JSON.parse(await readFile(new URL('../backend/stock-pool.json',import.meta.url),'utf8'));
const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
if(!pool.length||pool.length>100||!pool.some(s=>s.symbol==='sh000001')||new Set(pool.map(s=>s.symbol)).size!==pool.length)throw new Error('股票池无效');
for(const s of pool)if(!/^(sh|sz|bj)\d{6}$/.test(s.symbol)||!['股票','ETF','指数'].includes(s.kind)||!/^\d{4}-\d{2}-\d{2}$/.test(s.start))throw new Error('股票池字段无效');
console.log('begin;\nupdate market.securities set enabled=false;');
console.log('insert into market.securities(symbol,name,kind,pinyin,start_date,adjust) values');
console.log(pool.map(s=>'('+[s.symbol,s.name,s.kind,s.pinyin||'',s.start,s.symbol==='sh000001'?'none':'qfq'].map(quote).join(',')+')').join(',\n'));
console.log('on conflict(symbol) do update set name=excluded.name,kind=excluded.kind,pinyin=excluded.pinyin,start_date=excluded.start_date,enabled=true;\ncommit;');
