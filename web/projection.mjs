const DAY=86400000;
const time=s=>Date.parse(s+'T00:00:00Z');
const iso=d=>new Date(d).toISOString().slice(0,10);
export function validDate(s){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(time(s))&&iso(time(s))===s;}
export function endDate(start,years){const d=new Date(time(start)),year=d.getUTCFullYear()+years,month=d.getUTCMonth();return iso(Date.UTC(year,month,Math.min(d.getUTCDate(),new Date(Date.UTC(year,month+1,0)).getUTCDate())));}
export function project(plan,records=[],today=iso(Date.now())){
  const {start,years,initial,amount,frequency,rate,rateUnit}=plan;
  if(!validDate(start)||!Number.isInteger(years)||years<1||years>30)throw Error('请选择有效开始日期和 1 至 30 年的期限。');
  if(!['daily','monthly','yearly'].includes(frequency)||!['daily','monthly','yearly'].includes(rateUnit))throw Error('请选择投入与收益率周期。');
  if(!Number.isFinite(initial)||initial<0||initial>1e9||!Number.isFinite(amount)||amount<=0||amount>1e8)throw Error('请检查初始资产和每次投入金额。');
  if(!Number.isFinite(rate)||rate<=-100||rate>1000)throw Error('预期收益率需大于 -100%，且不超过 1,000%。');
  const end=endDate(start,years),sd=new Date(time(start));
  const dailyFactor=(1+rate/100)**(1/({daily:1,monthly:365/12,yearly:365}[rateUnit]));
  const contribution=date=>{const d=new Date(time(date)),last=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,0)).getUTCDate();return frequency==='daily'||(d.getUTCDate()===Math.min(sd.getUTCDate(),last)&&(frequency==='monthly'||d.getUTCMonth()===sd.getUTCMonth()))?amount:0;};
  let assets=initial,invested=initial;
  const expected=[];
  for(let t=time(start);t<=time(end);t+=DAY){const date=iso(t),deposit=contribution(date);if(t>time(start))assets*=dailyFactor;assets+=deposit;invested+=deposit;if(!Number.isFinite(assets)||assets>1e15)throw Error('预期结果过大，请降低收益率或缩短期限。');expected.push({date,assets,invested,profit:assets-invested});}
  const sorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));
  let previous=start,actualAssets=expected[0].assets;
  const actual=sorted.length?[{...expected[0]}]:[];
  const seen=new Set();
  for(const record of sorted){
    if(!validDate(record.date)||record.date<start||record.date>end||record.date>today||seen.has(record.date))throw Error('记录日期不能早于计划开始日、不晚于今天与计划结束日，且不能重复。');
    seen.add(record.date);
    if(!['rate','assets'].includes(record.mode)||!Number.isFinite(record.value)||(record.mode==='rate'&&(record.value<=-100||record.value>1000))||(record.mode==='assets'&&(record.value<0||record.value>1e15)))throw Error('请填写有效的实际收益率或资产总值。');
    if(record.mode==='assets')actualAssets=record.value;
    else {const days=(time(record.date)-time(previous))/DAY;if(days<=0)throw Error('收益率记录需有至少一天的计算区间。');const factor=(1+record.value/100)**(1/days);for(let t=time(previous)+DAY;t<=time(record.date);t+=DAY)actualAssets=actualAssets*factor+contribution(iso(t));}
    if(!Number.isFinite(actualAssets)||actualAssets>1e15)throw Error('实际结果过大，请检查记录。');
    const target=expected[(time(record.date)-time(start))/DAY];
    const point={date:record.date,assets:actualAssets,invested:target.invested,profit:actualAssets-target.invested};
    if(actual.at(-1)?.date===record.date)actual[actual.length-1]=point;else actual.push(point);
    previous=record.date;
  }
  return {expected,actual,end,latest:actual.at(-1)||null};
}
