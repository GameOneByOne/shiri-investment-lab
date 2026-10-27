const source='https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get';

export function parseBars(payload,task){
  if(payload.code && payload.code!==0)throw new Error('Source returned an error');
  const key=task.security.kind==='指数'?'day':'qfqday';
  const values=payload.data?.[task.symbol]?.[key];
  if(!Array.isArray(values))throw new Error(`Missing ${key}; refusing mixed adjustment modes`);
  const dates=new Set();
  for(const row of values)if(!Array.isArray(row)||row.length<5)throw new Error('Invalid daily bar format');
  return values.filter(row=>row[0]>=`${task.year}-01-01`&&row[0]<=`${task.year}-12-31`&&row[0]>=task.security.start&&row[0]<=task.end_date).map(row=>{
    const [date,o,c,h,l]=row, [open,close,high,low]=[o,c,h,l].map(Number);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date).toISOString().slice(0,10)!==date||dates.has(date))throw new Error('Invalid or duplicate trading date');
    if(![open,close,high,low].every(n=>Number.isFinite(n)&&n>0&&n<1e9)||low>Math.min(open,close)||Math.max(open,close)>high)throw new Error('Invalid OHLC price');
    dates.add(date);
    return {date,open,close,high,low};
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
      let completed=0,failed=0;
      // Bounded work stays within Edge execution limits. Cron resumes leases.
      for(let i=0;i<3;i++){
        const task=await rpc('market_claim_task');
        if(!task)break;
        try{
          const adjust=task.symbol==='sh000001'?'':'qfq';
          const query=new URLSearchParams({param:`${task.symbol},day,${task.year}-01-01,${task.year}-12-31,640,${adjust}`});
          const response=await fetcher(source+'?'+query,{headers:{'User-Agent':'Mozilla/5.0'},signal:AbortSignal.timeout(18000)});
          if(!response.ok)throw new Error(`Market source HTTP ${response.status}`);
          const bars=parseBars(await response.json(),task);
          await rpc('market_complete_task',{p_id:task.id,p_attempt:task.attempts,p_bars:bars});
          completed++;
        }catch(error){
          await rpc('market_fail_task',{p_id:task.id,p_attempt:task.attempts,p_error:String(error.message).slice(0,300)});
          failed++;
        }
      }
      return Response.json({completed,failed});
    }catch(error){console.error(error.message);return Response.json({error:'Collection worker failed'},{status:502});}
  };
}
