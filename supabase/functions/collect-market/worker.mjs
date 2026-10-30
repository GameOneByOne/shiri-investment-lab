import {fetchDividends} from './dividends.mjs';
import {fetchCatalogue} from './catalog.mjs';

const source='https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get';

export function parseBars(payload,task){
  if(payload.code && payload.code!==0)throw new Error('Source returned an error');
  if(task.adjust && task.adjust!=='none')throw new Error('Invalid adjustment mode: raw prices only');
  const values=payload.data?.[task.symbol]?.day;
  if(!Array.isArray(values))throw new Error('Missing day; raw prices required');
  const dates=new Set();
  for(const row of values)if(!Array.isArray(row)||row.length<3)throw new Error('Invalid daily bar format');
  return values.filter(row=>row[0]>=`${task.year}-01-01`&&row[0]<=`${task.year}-12-31`&&row[0]>='2021-01-01'&&row[0]>=task.security.start&&row[0]<=task.end_date).map(row=>{
    const date=row[0],close=Number(row[2]);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date||dates.has(date))throw new Error('Invalid or duplicate trading date');
    if(!Number.isFinite(close)||close<=0||close>=1e9)throw new Error('Invalid close price');
    dates.add(date);
    return {date,close};
  }).sort((a,b)=>a.date.localeCompare(b.date));
}

export function createWorker(config,fetcher=globalThis.fetch){
  async function rpc(name,body={}){
    const response=await fetcher(`${config.url}/rest/v1/rpc/${name}`,{
      method:'POST',headers:{apikey:config.key,Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(25000)
    });
    if(!response.ok)throw new Error(`Database ${name} HTTP ${response.status}`);
    const text=await response.text();return text?JSON.parse(text):null;
  }
  return async request=>{
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    // Custom job authentication, not browser/public API authentication.
    const token=request.headers.get('x-job-token');
    if(!token||token.length>200)return new Response('Unauthorized',{status:401});
    try{
      if(!await rpc('market_authorize_job',{p_token:token}))return new Response('Unauthorized',{status:401});
      if(config.catalog){
        const catalogue=await rpc('market_bulk_catalog_claim');
        if(catalogue){
          try{
            const {total,stocks}=await fetchCatalogue(catalogue,fetcher);
            await rpc('market_bulk_catalog_complete',{p_page:catalogue.page,p_total:total,p_stocks:stocks});
            return Response.json({cataloguePage:catalogue.page,stocks:stocks.length});
          }catch(error){
            await rpc('market_bulk_catalog_fail',{p_page:catalogue.page,p_error:String(error.message).slice(0,300),p_restricted:/HTTP (403|429)/.test(error.message)});
            return Response.json({cataloguePage:catalogue.page,error:'Catalogue paused; checkpoint retained'});
          }
        }
      }
      let completed=0,failed=0;
      const deadline=Date.now()+80000;
      // Bounded work stays within Edge execution limits. Cron resumes leases.
      for(let i=0;i<(config.maxTasks??3)&&Date.now()<deadline;i++){
        const task=await rpc('market_claim_task');
        if(!task)break;
        try{
          let bars;
          if(task.dataset==='dividends'){
            bars=await fetchDividends(task,fetcher);
          }else{
            const mode=task.adjust??'none';
            const adjust=mode==='none'?'':mode;
            const query=new URLSearchParams({param:`${task.symbol},day,${task.year}-01-01,${task.year}-12-31,640,${adjust}`});
            const response=await fetcher(source+'?'+query,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(18000)});
            if(!response.ok)throw new Error(`Market source HTTP ${response.status}`);
            bars=parseBars(await response.json(),task);
          }
          await rpc('market_complete_task',{p_id:task.id,p_attempt:task.attempts,p_bars:bars});
          completed++;
        }catch(error){
          await rpc('market_fail_task',{p_id:task.id,p_attempt:task.attempts,p_error:String(error.message).slice(0,300)});
          failed++;
          break; // A failing provider is never retried inside the same invocation.
        }
        if(config.paced)await new Promise(resolve=>setTimeout(resolve,7000+Math.random()*1000));
      }
      return Response.json({completed,failed});
    }catch(error){console.error(error.message);return Response.json({error:'Collection worker failed'},{status:502});}
  };
}

