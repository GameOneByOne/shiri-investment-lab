import {simulate,sampleSeries} from './engine.mjs';
import config from './config.mjs';
import {createDataApi} from './data.mjs';

const market=createDataApi(config);

const $=s=>document.querySelector(s);
const money=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2,minimumFractionDigits:2});
const compact=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const state={selected:{symbol:'sh600519',name:'贵州茅台',kind:'股票'},config:null,result:null,options:null,bars:null,benchmark:null,metric:'profit',granularity:'month',busy:false,searchVersion:0};
const displayCode=s=>`${s.slice(2)}.${s.slice(0,2).toUpperCase()}`;
const percent=n=>`${n>=0?'+':''}${(n*100).toFixed(2)}%`;
const signed=n=>`${n>=0?'+':'−'}${money.format(Math.abs(n))}`;

function updateSchedule(){
  const frequency=$('#frequency').value;
  const input=$('#schedule-value');
  const previous=input.value;
  input.replaceChildren();
  input.hidden=frequency==='daily';
  const values=frequency==='weekly'?['周一','周二','周三','周四','周五']:Array.from({length:31},(_,i)=>`${i+1} 号`);
  values.forEach((label,i)=>input.add(new Option(label,i+1)));
  input.value=frequency==='monthly'&&Number(previous)<=31&&Number(previous)>0?previous:'1';
  input.setAttribute('aria-label',frequency==='weekly'?'每周几':'每月几号');
}
$('#frequency').addEventListener('change',updateSchedule);updateSchedule();

function hideSearch(){ $('#stock-results').hidden=true;$('#stock-search').setAttribute('aria-expanded','false'); }
function renderSearch(results){
  const box=$('#stock-results');box.replaceChildren();box.hidden=false;$('#stock-search').setAttribute('aria-expanded','true');
  if(!results.length){const p=document.createElement('div');p.className='search-empty';p.textContent='未找到标的，请尝试名称、拼音或代码。';box.append(p);return;}
  for(const item of results){
    const button=document.createElement('button');button.type='button';button.role='option';
    const name=document.createElement('span');name.textContent=item.name;
    const code=document.createElement('small');code.textContent=displayCode(item.symbol);
    button.append(name,code);
    button.addEventListener('click',()=>{
      clearTimeout(searchTimer);state.searchVersion++;
      state.selected=item;$('#stock-search').value=item.name;$('#stock-code').textContent=displayCode(item.symbol);
      $('#stock-kind').textContent=item.kind==='ETF'?' ETF':item.kind==='指数'?'指数':'股票';hideSearch();
    });box.append(button);
  }
}
let searchTimer;
$('#stock-search').addEventListener('focus',()=>{if(state.config)renderSearch(state.config.popular);});
$('#stock-search').addEventListener('input',()=>{
  clearTimeout(searchTimer);
  const version=++state.searchVersion;
  $('#stock-code').textContent='输入名称或代码后，从列表选择';
  searchTimer=setTimeout(async()=>{
    try{const data=await market.search($('#stock-search').value);if(version===state.searchVersion)renderSearch(data.results);}
    catch{if(version===state.searchVersion)renderSearch([]);}
  },280);
});
$('#stock-search').addEventListener('keydown',e=>{
  if(e.key==='Escape')hideSearch();
  if(e.key==='ArrowDown'){e.preventDefault();$('#stock-results button')?.focus();}
});
$('#stock-results').addEventListener('keydown',e=>{
  const buttons=[...$('#stock-results').querySelectorAll('button')];const index=buttons.indexOf(document.activeElement);
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();buttons[(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length]?.focus();}
  if(e.key==='Escape'){hideSearch();$('#stock-search').focus();hideSearch();}
});
document.addEventListener('click',e=>{if(!e.target.closest('.stock-wrap'))hideSearch();});

function setBusy(busy){
  state.busy=busy;$('#run-button').disabled=busy;$('#run-label').textContent=busy?'正在寻找历史的答案…':'看看历史的答案';
  $('#export-button').disabled=busy||!state.result;$('#benchmark-toggle').disabled=busy;
  $('#chart-container').setAttribute('aria-busy',String(busy));
}
function showMessage(text,error=false){
  const box=$('#chart-state');box.hidden=false;box.className=`chart-state${error?' error':''}`;box.replaceChildren();
  if(!error){const spin=document.createElement('span');spin.className='loader';box.append(spin);}
  const title=document.createElement('strong');title.textContent=error?'这次没能找到答案':'正在翻阅历史';box.append(title);
  const p=document.createElement('p');p.textContent=text;box.append(p);
  if(error){const button=document.createElement('button');button.className='retry-button';button.type='button';button.textContent='重新计算';button.addEventListener('click',()=>state.config?.lastCompleteDate?$('#investment-form').requestSubmit():location.reload());box.append(button);}
}
function getOptions(){
  if($('#stock-search').value!==state.selected.name)throw new Error('请从搜索列表选择要回测的证券。');
  const start=$('#start-date').value,end=$('#end-date').value,amount=Number($('#amount').value);
  if(!start||!end||start>end)throw new Error('开始日期需要早于或等于结束日期。');
  if(end>state.config.lastCompleteDate)throw new Error('请使用已经收盘的日期。');
  if(!Number.isFinite(amount)||amount<1||amount>100000000)throw new Error('每次投入金额需在 1 元至 1 亿元之间。');
  return {start,end,amount,frequency:$('#frequency').value,weekday:Number($('#schedule-value').value),monthday:Number($('#schedule-value').value),stock:{...state.selected}};
}
const history=(symbol,o)=>market.history(symbol,o);

async function run(){
  if(state.busy)return;
  let options;
  try{options=getOptions();}catch(e){showMessage(e.message,true);return;}
  setBusy(true);hideSearch();showMessage('正在读取已采集行情，收益曲线将在你的浏览器中计算。');
  try{
    const compare=$('#benchmark-toggle').checked;
    const [stock,index]=await Promise.all([history(options.stock.symbol,options),compare?history('sh000001',options):Promise.resolve(null)]);
    const result=simulate(options,stock.bars,index?.bars||[]);
    state.options=options;state.bars=stock;state.benchmark=index;state.result=result;
    $('#chart-state').hidden=true;renderResult();
  }catch(e){showMessage(e.message,true);}
  finally{setBusy(false);}
}
$('#investment-form').addEventListener('submit',e=>{e.preventDefault();run();});

$('#benchmark-toggle').addEventListener('change',async()=>{
  if(!state.result||state.busy)return;
  const wanted=$('#benchmark-toggle').checked;
  setBusy(true);
  try{
    if(wanted&&!state.benchmark){showMessage('正在补齐上证指数历史，用相同投入日期进行对比。');state.benchmark=await history('sh000001',state.options);}
    state.result=simulate(state.options,state.bars.bars,wanted?state.benchmark.bars:[]);
    $('#chart-state').hidden=true;renderResult();
  }catch(e){$('#benchmark-toggle').checked=!wanted;showMessage(e.message,true);}
  finally{setBusy(false);}
});

function renderResult(){
  const {last,count,firstPurchase,lastDate}=state.result;
  const o=state.options;
  const hero=$('#hero-value');hero.replaceChildren(document.createTextNode(signed(last.profit)));const unit=document.createElement('span');unit.textContent='元';hero.append(unit);hero.classList.toggle('negative',last.profit<0);
  const frequency=o.frequency==='daily'?'每个交易日':o.frequency==='weekly'?`每周${['','一','二','三','四','五'][o.weekday]}`:`每月 ${o.monthday} 号`;
  $('#hero-description').textContent=`${frequency}投入 ${compact.format(o.amount)} 元，累计 ${count} 次，模拟收益率 ${percent(last.rate)}`;
  $('#period-years').textContent=`${firstPurchase.slice(0,4)} — ${lastDate.slice(0,4)}`;
  $('#legend-stock').textContent=o.stock.name;
  $('#benchmark-legend').hidden=!$('#benchmark-toggle').checked;
  $('#stat-invested').textContent='¥ '+compact.format(last.contributed);
  $('#stat-assets').textContent='¥ '+compact.format(last.assets);
  $('#stat-rate').textContent=percent(last.rate);
  $('#stat-count').textContent=`${count} 次`;
  const collected=state.bars.fetchedAt?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(state.bars.fetchedAt)):'';
  const stale=state.bars.fetchedAt&&Date.now()-new Date(state.bars.fetchedAt).getTime()>48*3600000;
  $('#data-status').textContent=`腾讯财经 · ${state.bars.adjust==='qfq'?'前复权价格模拟':'指数点位模拟'} · Supabase 行情 · 截至 ${lastDate}${collected?' · 采集于 '+collected:''}${stale?' · 采集已超过 48 小时，请留意更新状态':''}`;
  $('#actual-range').textContent=`实际行情区间：${state.bars.firstDate} 至 ${state.bars.lastDate}；首笔执行日期：${firstPurchase}。${state.bars.lastDate<o.end?'结束日无更新行情，按最后一个可用交易日估值。':''}`;
  drawChart();
}

for(const button of document.querySelectorAll('[data-metric]'))button.addEventListener('click',()=>{
  state.metric=button.dataset.metric;for(const b of document.querySelectorAll('[data-metric]')){const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}drawChart();
});
for(const button of document.querySelectorAll('[data-granularity]'))button.addEventListener('click',()=>{
  state.granularity=button.dataset.granularity;for(const b of document.querySelectorAll('[data-granularity]')){const active=b===button;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}drawChart();
});

function drawChart(){
  if(!state.result)return;
  const data=sampleSeries(state.result.series,state.granularity),metric=state.metric;
  const benchmark=$('#benchmark-toggle').checked;
  const other={profit:'benchmarkProfit',rate:'benchmarkRate',assets:'benchmarkAssets'}[metric];
  const svg=$('#chart'),W=Math.max(320,svg.clientWidth||840),H=Math.max(230,svg.clientHeight||390);
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  const L=W<500?57:74,R=17,T=24,B=43,pw=W-L-R,ph=H-T-B;
  let values=data.flatMap(d=>benchmark?[d[metric],d[other]]:[d[metric]]).filter(Number.isFinite);
  let lo=Math.min(0,...values),hi=Math.max(0,...values);
  if(hi===lo){hi+=1;lo-=1;}
  const padding=(hi-lo)*.12;hi+=padding;lo=lo<0?lo-padding:0;
  const x=i=>L+(data.length===1?pw/2:i/(data.length-1)*pw);
  const y=v=>T+(hi-v)/(hi-lo)*ph;
  const points=key=>data.map((d,i)=>`${i?'L':'M'}${x(i).toFixed(2)},${y(d[key]).toFixed(2)}`).join(' ');
  const path=points(metric);
  const tick=v=>metric==='rate'?`${(v*100).toFixed(0)}%`:Math.abs(v)>=1e8?`${(v/1e8).toFixed(1)}亿`:Math.abs(v)>=10000?`${(v/10000).toFixed(1)}万`:compact.format(v);
  let html=`<title>历史定投${metric==='rate'?'收益率':metric==='assets'?'资产':'收益'}曲线</title><defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#91b179" stop-opacity=".25"/><stop offset="100%" stop-color="#91b179" stop-opacity=".015"/></linearGradient><clipPath id="plot-clip"><rect x="${L}" y="${T-4}" width="${pw+1}" height="${ph+8}"/></clipPath></defs>`;
  for(let i=0;i<=4;i++){
    const v=lo+(hi-lo)*i/4,yy=y(v);
    html+=`<line x1="${L}" x2="${W-R}" y1="${yy}" y2="${yy}" stroke="#e1e6d9" stroke-dasharray="3 5"/><text x="${L-13}" y="${yy+4}" text-anchor="end" fill="#9ba58e" font-size="11" font-family="Arial,sans-serif">${tick(v)}</text>`;
  }
  if(lo<0&&hi>0)html+=`<line x1="${L}" x2="${W-R}" y1="${y(0)}" y2="${y(0)}" stroke="#aebd9d" stroke-dasharray="4 5"/>`;
  const ticks=[...new Set(Array.from({length:Math.min(5,data.length)},(_,i)=>Math.round(i*(data.length-1)/Math.max(1,Math.min(5,data.length)-1))))];
  for(const i of ticks){const label=state.granularity==='year'?data[i].date.slice(0,4):data[i].date.slice(0,7).replace('-','.');html+=`<text x="${x(i)}" y="${H-12}" text-anchor="middle" fill="#9ba58e" font-size="11" font-family="Arial,sans-serif">${label}</text>`;}
  html+=`<g clip-path="url(#plot-clip)"><path d="${path} L${x(data.length-1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#chart-fill)"/>`;
  if(benchmark)html+=`<path d="${points(other)}" fill="none" stroke="#b68d62" stroke-width="1.8" stroke-dasharray="6 5" stroke-linecap="round" stroke-linejoin="round"/>`;
  html+=`<path d="${path}" fill="none" stroke="#48734a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  if(data.length===1)html+=`<circle cx="${x(0)}" cy="${y(data[0][metric])}" r="4" fill="#48734a"/>`;
  html+=`</g><g id="chart-crosshair" visibility="hidden"><line id="crosshair-line" y1="${T}" y2="${H-B}" stroke="#b2c0a0" stroke-dasharray="3 4"/><circle id="crosshair-point" r="4" fill="#48734a" stroke="#f7f8f2" stroke-width="2"/></g><rect id="chart-hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" tabindex="0" role="slider" aria-label="浏览曲线日期，使用左右方向键" aria-valuemin="0" aria-valuemax="${data.length-1}" aria-valuenow="0"/>`;
  svg.innerHTML=html;
  $('#sampling-note').textContent=state.granularity==='day'?'按交易日显示':state.granularity==='month'?'按月显示期末值':'按年显示期末值';
  let selected=0;
  const tip=$('#chart-tooltip');tip.hidden=true;
  function hover(i){
    selected=Math.max(0,Math.min(data.length-1,i));const d=data[selected],xx=x(selected);
    $('#chart-crosshair').setAttribute('visibility','visible');$('#crosshair-line').setAttribute('x1',xx);$('#crosshair-line').setAttribute('x2',xx);$('#crosshair-point').setAttribute('cx',xx);$('#crosshair-point').setAttribute('cy',y(d[metric]));
    $('#chart-hit').setAttribute('aria-valuenow',selected);$('#chart-hit').setAttribute('aria-valuetext',`${d.date}，${metric==='rate'?percent(d[metric]):signed(d[metric])}`);
    tip.replaceChildren();const date=document.createElement('strong');date.textContent=d.date;tip.append(date);
    function line(name,value,className=''){const div=document.createElement('div');div.className='tooltip-line '+className;const a=document.createElement('span');a.textContent=name;const b=document.createElement('span');b.textContent=value;div.append(a,b);tip.append(div);}
    line(state.options.stock.name,metric==='rate'?percent(d[metric]):'¥ '+signed(d[metric]));
    if(benchmark)line('上证指数',metric==='rate'?percent(d[other]):'¥ '+signed(d[other]),'benchmark');
    line('累计投入','¥ '+compact.format(d.contributed),'tooltip-invested');tip.hidden=false;
    const container=$('#chart-container'),left=xx/W*container.clientWidth;
    tip.style.left=Math.max(0,Math.min(container.clientWidth-tip.offsetWidth,left+12))+'px';
    tip.style.top='16px';
  }
  $('#chart-hit').addEventListener('pointermove',e=>{const rect=svg.getBoundingClientRect();const xx=(e.clientX-rect.left)/rect.width*W;hover(Math.round((xx-L)/pw*(data.length-1)));});
  $('#chart-hit').addEventListener('pointerleave',()=>{tip.hidden=true;$('#chart-crosshair').setAttribute('visibility','hidden');});
  $('#chart-hit').addEventListener('focus',()=>hover(selected));
  $('#chart-hit').addEventListener('blur',()=>{tip.hidden=true;$('#chart-crosshair').setAttribute('visibility','hidden');});
  $('#chart-hit').addEventListener('keydown',e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){e.preventDefault();hover(selected+(e.key==='ArrowRight'?1:-1));}});
}

$('#export-button').addEventListener('click',()=>{
  if(!state.result)return;
  const headers=['日期','累计投入_元','模拟总资产_元','模拟收益_元','累计收益率','上证对比总资产_元','上证对比收益_元','上证对比收益率'];
  const rows=state.result.series.map(d=>[d.date,d.contributed,d.assets,d.profit,d.rate,d.benchmarkAssets,d.benchmarkProfit,d.benchmarkRate].map(x=>typeof x==='number'?x.toFixed(6):x??'').join(','));
  const blob=new Blob(['\uFEFF'+[headers.join(','),...rows].join('\r\n')],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`拾日_${state.options.stock.symbol}_${state.options.start}_${state.options.end}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('#about-open').addEventListener('click',()=>$('#about-dialog').showModal());
for(const id of ['about-close','about-done'])$('#'+id).addEventListener('click',()=>$('#about-dialog').close());
$('#about-dialog').addEventListener('click',e=>{if(e.target===$('#about-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
let resizeTimer;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(drawChart,100);});

try{
  state.config=await market.config();
  if(!state.config.lastCompleteDate)throw new Error('行情库尚未完成首次采集，请稍后再试。');
  if(!state.config.popular.some(item=>item.symbol===state.selected.symbol)){
    const item=state.config.popular.find(item=>item.kind!=='指数')||state.config.popular[0];
    if(!item)throw new Error('股票池尚未配置。');
    state.selected=item;$('#stock-search').value=item.name;$('#stock-code').textContent=displayCode(item.symbol);$('#stock-kind').textContent=item.kind;
  }
  $('#start-date').max=state.config.lastCompleteDate;$('#end-date').max=state.config.lastCompleteDate;$('#end-date').value=state.config.lastCompleteDate;
  await run();
}catch(e){showMessage(e.message||'行情服务暂时不可用，请稍后再试。',true);}

