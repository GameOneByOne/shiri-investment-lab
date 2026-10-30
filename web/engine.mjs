// A price-based simulation using virtual units, not executable stock orders.
const parse=s=>new Date(s+'T00:00:00Z');
const iso=d=>d.toISOString().slice(0,10);

export function scheduledDates({start,end,frequency,weekday=1,monthday=1},bars){
  if(frequency==='daily') return bars.filter(b=>b.date>=start&&b.date<=end).map(b=>b.date);
  const dates=[];
  if(frequency==='weekly'){
    const d=parse(start);
    d.setUTCDate(d.getUTCDate()+(Number(weekday)-d.getUTCDay()+7)%7);
    for(;iso(d)<=end;d.setUTCDate(d.getUTCDate()+7)) dates.push(iso(d));
  }else if(frequency==='monthly'){
    const d=parse(start);d.setUTCDate(1);
    for(;iso(d)<=end;d.setUTCMonth(d.getUTCMonth()+1)){
      const last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();
      const s=iso(new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),Math.min(Number(monthday),last))));
      if(s>=start&&s<=end) dates.push(s);
    }
  }else throw new Error('请选择有效的定投周期。');
  // Different scheduled orders may execute on the same following trading day.
  return dates;
}

export function simulate(options,bars,benchmarkBars=[],dividends=[]){
  const {start,end,amount}=options;
  if(!start||!end||start>end||!Number.isFinite(amount)||amount<=0) throw new Error('请检查日期和投入金额。');
  const usable=bars.filter(b=>b.date>=start&&b.date<=end);
  const listedFrom=options.stock?.firstDate??options.firstDate??start;
  if(!usable.length&&listedFrom<=end) throw new Error('所选日期内没有可用行情。');
  const dates=scheduledDates(options,usable);
  const purchases=new Map();
  let cursor=0;
  for(const planned of dates){
    // Orders before listing are skipped, never saved up and executed at IPO.
    if(planned<listedFrom)continue;
    while(cursor<usable.length&&usable[cursor].date<planned)cursor++;
    if(cursor<usable.length){
      const execution=usable[cursor].date;
      purchases.set(execution,(purchases.get(execution)||0)+1);
    }
  }
  const actions=dividends.filter(e=>e.status==='implemented'&&e.exDate>=start&&e.exDate<=end)
    .sort((a,b)=>a.exDate.localeCompare(b.exDate));
  const seen=new Set();
  for(const e of actions){
    const key=(e.source||'')+':'+e.id;
    if(seen.has(key)||!/^\d{4}-\d{2}-\d{2}$/.test(e.exDate)||e.recordDate&&e.recordDate>=e.exDate)throw new Error('分红记录的日期或标识异常。');
    seen.add(key);
    for(const value of [e.cashPer10,e.bonusSharesPer10,e.transferSharesPer10])
      if(value!=null&&(!Number.isFinite(value)||value<0))throw new Error('分红送转数值异常。');
  }
  let units=0,indexUnits=0,total=0,count=0,indexCursor=-1,cash=0,actionCursor=0;
  const holdings=[];
  const series=[];
  let firstPurchase=null;
  const zero=date=>({date,contributed:0,assets:0,profit:0,rate:0,cash:0,units:0,
    benchmarkAssets:benchmarkBars.length?0:null,benchmarkProfit:benchmarkBars.length?0:null,
    benchmarkRate:benchmarkBars.length?0:null,purchases:0});
  // Show the requested pre-listing interval as a flat zero line.
  for(const d=parse(start);iso(d)<=end&&(!usable.length||iso(d)<usable[0].date);d.setUTCDate(d.getUTCDate()+1))series.push(zero(iso(d)));
  for(const bar of usable){
    if(!(bar.close>0&&Number.isFinite(bar.close)))throw new Error('行情包含无效收盘价。');
    // Entitlement uses record-date closing holdings. Ex-date purchases are excluded.
    // Cash is a receivable from ex-date, then retained as cash (no reinvestment).
    const priorUnits=units;
    while(actionCursor<actions.length&&actions[actionCursor].exDate<=bar.date){
      const e=actions[actionCursor++];
      let entitled=priorUnits;
      if(e.recordDate){
        let lo=0,hi=holdings.length-1,found=-1;
        while(lo<=hi){const mid=(lo+hi)>>1;if(holdings[mid].date<=e.recordDate){found=mid;lo=mid+1;}else hi=mid-1;}
        entitled=found<0?0:holdings[found].units;
      }
      cash+=entitled*(e.cashPer10??0)/10;
      units+=entitled*((e.bonusSharesPer10??0)+(e.transferSharesPer10??0))/10;
    }
    while(indexCursor+1<benchmarkBars.length&&benchmarkBars[indexCursor+1].date<=bar.date)indexCursor++;
    const indexBar=benchmarkBars[indexCursor];
    const n=purchases.get(bar.date)||0;
    if(n){
      firstPurchase??=bar.date;
      units+=amount*n/bar.close;
      total+=amount*n;count+=n;
      if(benchmarkBars.length){
        if(!indexBar||indexBar.date!==bar.date)throw new Error(`上证指数缺少 ${bar.date} 的对比数据。`);
        indexUnits+=amount*n/indexBar.close;
      }
    }
    holdings.push({date:bar.date,units});
    const assets=units*bar.close+cash;
    const indexAssets=indexBar?indexUnits*indexBar.close:null;
    series.push({date:bar.date,contributed:total,assets,profit:assets-total,rate:total?(assets-total)/total:0,cash,units,
      benchmarkAssets:indexAssets,benchmarkProfit:indexAssets===null?null:indexAssets-total,
      benchmarkRate:indexAssets===null?null:total?(indexAssets-total)/total:0,purchases:n});
  }
  return {series,last:series.at(-1),count,firstPurchase,lastDate:series.at(-1).date};
}

export function sampleSeries(series,granularity){
  if(granularity==='day')return series;
  const groups=new Map();
  for(const row of series)groups.set(row.date.slice(0,granularity==='month'?7:4),row);
  return [...groups.values()];
}

