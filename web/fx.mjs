const currencies={cn:'CNY',hk:'HKD',us:'USD'};
const datePattern=/^\d{4}-\d{2}-\d{2}$/;

export function validateRates(rows,currency){
  if(!Array.isArray(rows)||!rows.length)throw new Error('历史汇率暂无可用数据。');
  const seen=new Set();
  for(const row of rows){
    if(row.base!==currency||row.quote!=='CNY'||!datePattern.test(row.date)||!Number.isFinite(row.rate)||row.rate<=0||seen.has(row.date))throw new Error('历史汇率数据异常，无法完成人民币折算。');
    seen.add(row.date);
  }
  return [...rows].sort((a,b)=>a.date.localeCompare(b.date));
}

export function rateOn(rates,date){
  let lo=0,hi=rates.length-1,found=-1;
  while(lo<=hi){const mid=(lo+hi)>>1;if(rates[mid].date<=date){found=mid;lo=mid+1;}else hi=mid-1;}
  if(found<0||(Date.parse(date)-Date.parse(rates[found].date))/86400000>7)throw new Error(`${date} 缺少有效历史汇率，请稍后重试。`);
  return rates[found];
}

export function createFxApi(fetcher=globalThis.fetch){
  const cache=new Map();
  return async function loadRates(market,start,end){
    const currency=currencies[market];
    if(!currency)throw new Error('不支持的汇率币种。');
    if(currency==='CNY')return [];
    const key=[currency,start,end].join(':');
    if(!cache.has(key))cache.set(key,(async()=>{
      const from=new Date(start+'T00:00:00Z');from.setUTCDate(from.getUTCDate()-14);
      // Only currency and date bounds leave the browser, never plans or amounts.
      const params=new URLSearchParams({base:currency,quotes:'CNY',providers:'ECB',from:from.toISOString().slice(0,10),to:end});
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
      try{
        const response=await fetcher('https://api.frankfurter.dev/v2/rates?'+params,{signal:controller.signal});
        if(!response.ok)throw new Error('历史汇率读取失败，请稍后重试。');
        return validateRates(await response.json(),currency);
      }catch(e){if(e.name==='AbortError')throw new Error('历史汇率读取超时，请稍后重试。');throw e;}
      finally{clearTimeout(timer);}
    })().catch(e=>{cache.delete(key);throw e;}));
    return cache.get(key);
  };
}

export function convertPlanToCny(plan,rates){
  const {options,result}=plan;
  if(options.market==='cn')return {...plan,nativeResult:result};
  const checked=validateRates(rates,currencies[options.market]);
  const dates=[...new Set([options.start,options.end,...result.series.map(d=>d.date),...checked.filter(r=>r.date>=options.start&&r.date<=options.end).map(r=>r.date)])].sort();
  let cursor=-1,contributed=0,priorNative=0;
  const series=dates.map(date=>{
    while(cursor+1<result.series.length&&result.series[cursor+1].date<=date)cursor++;
    const native=cursor<0?{contributed:0,assets:0,profit:0,rate:0}:result.series[cursor];
    const fx=native.contributed||native.assets?rateOn(checked,date):null;
    const rate=fx?.rate||1;
    // Historical cost is a sum of converted deposits, never today's FX * total deposits.
    contributed+=(native.contributed-priorNative)*rate;priorNative=native.contributed;
    const assets=native.assets*rate,profit=assets-contributed;
    return {...native,date,contributed,assets,profit,rate:contributed?profit/contributed:0,
      purchases:native.date===date?native.purchases:0,
      events:native.date===date?(native.events||[]).map(e=>({...e,nativeCashAmount:e.cashAmount,cashAmount:(e.cashAmount||0)*rate})):[],
      fxRate:fx?.rate??null,fxDate:fx?.date??null,native};
  });
  return {...plan,nativeResult:result,fx:checked,result:{...result,series,last:series.at(-1),lastDate:series.at(-1).date}};
}
