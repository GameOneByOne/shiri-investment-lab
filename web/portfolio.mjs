// A display market groups plans whose series already share one currency.
export function combinePlans(plans,displayMarket){
  const currencies=displayMarket&&plans.length?[displayMarket]:[...new Set(plans.map(p=>p.options.market))];
  return currencies.map(market=>{
    const members=displayMarket?plans:plans.filter(p=>p.options.market===market);
    const dates=[...new Set(members.flatMap(p=>[p.options.start,p.options.end,...p.result.series.map(d=>d.date)]))].sort();
    const cursors=members.map(()=>-1);
    let count=0;
    const series=dates.map(date=>{
      const row={date,contributed:0,assets:0,profit:0,benchmarkAssets:0,benchmarkProfit:0,purchases:0,events:[],values:{}};
      members.forEach((p,i)=>{
        const data=p.result.series;
        while(cursors[i]+1<data.length&&data[cursors[i]+1].date<=date)cursors[i]++;
        const value=cursors[i]<0?null:data[cursors[i]];
        row.values[p.id]=value;
        if(!value)return;
        for(const key of ['contributed','assets','profit','benchmarkAssets','benchmarkProfit'])row[key]+=value[key]||0;
        if(value.date===date){row.purchases+=value.purchases||0;row.events.push(...(value.events||[]).map(e=>({...e,planName:p.name})));}
      });
      count+=row.purchases;
      row.rate=row.contributed?row.profit/row.contributed:0;
      return row;
    });
    return {market,members,series,last:series.at(-1),count};
  });
}

export function combineCnyPlans(plans){
  return combinePlans(plans,'cn');
}
