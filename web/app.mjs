import {simulate,sampleSeries} from './engine.mjs?v=raw-close-v1';
import config from './config.mjs';
import {createDataApi} from './data.mjs?v=raw-close-v1';
import {firstHistoryDate,currentMarketDate,validateDateRange} from './dates.mjs?v=raw-close-v1';

const market=createDataApi(config);

const $=s=>document.querySelector(s);
const money=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2,minimumFractionDigits:2});
const compact=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
const state={selected:{symbol:'sh600519',name:'贵州茅台',kind:'股票'},config:null,result:null,options:null,bars:null,benchmark:null,metric:'profit',granularity:'month',busy:false,searchVersion:0};
const displayCode=s=>`${s.slice(2)}.${s.slice(0,2).toUpperCase()}`;
const percent=n=>`${n>=0?'+':''}${(n*100).toFixed(2)}%`;
const signed=n=>`${n>=0?'+':'−'}${money.format(Math.abs(n))}`;

function refreshDateBounds(){
  const today=currentMarketDate();
  for(const id of ['start-date','end-date']){const input=$('#'+id);input.min=firstHistoryDate;input.max=today;}
}
refreshDateBounds();
$('#end-date').value=currentMarketDate();
for(const id of ['start-date','end-date'])$('#'+id).addEventListener('focus',refreshDateBounds);
window.addEventListener('focus',refreshDateBounds);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshDateBounds();});
setInterval(refreshDateBounds,60000);

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

function hideSearch(){ clearTimeout(searchTimer);state.searchVersion++;$('#stock-results').hidden=true;$('#stock-search').setAttribute('aria-expanded','false'); }
let searchPage={query:'',results:[],nextCursor:null,total:0};
function renderSearch(results){
  const box=$('#stock-results');box.replaceChildren();box.hidden=false;$('#stock-search').setAttribute('aria-expanded','true');
  const summary=document.createElement('div');summary.className='search-summary';summary.textContent=`已入库可用 ${searchPage.total} 个标的 · 当前显示 ${results.length} 个`;box.append(summary);
  if(!results.length){const p=document.createElement('div');p.className='search-empty';p.textContent='未找到标的，请尝试名称、拼音或代码。';box.append(p);return;}
  for(const item of results){
    …2795 tokens truncated…p-color="#91b179" stop-opacity=".015"/></linearGradient><clipPath id="plot-clip"><rect x="${L}" y="${T-4}" width="${pw+1}" height="${ph+8}"/></clipPath></defs>`;
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
  refreshDateBounds();
  await run();
}catch(e){showMessage(e.message||'行情服务暂时不可用，请稍后再试。',true);}


