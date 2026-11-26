import {t} from './i18n.mjs?v=chart-currency-v1';
import {simulate,chartSeries} from './engine.mjs';
import {combinePlans} from './portfolio.mjs?v=chart-currency-v1';
import {createFxApi,convertPlanCurrency} from './fx.mjs?v=chart-currency-v1';
import config from './config.mjs';
import {chartScale} from './chart-scale.mjs';
import {createDataApi} from './data.mjs';
import {firstHistoryDate,currentMarketDate,validateDateRange} from './dates.mjs';
import {enhanceDateInput} from './pixel-date.mjs?v=1';

const api=createDataApi(config),$=s=>document.querySelector(s);
const money=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2,minimumFractionDigits:2});
const markets={cn:{name:'A股',unit:'元',sign:'¥',code:'CNY',currency:'人民币'},hk:{name:'港股',unit:'港币',sign:'HK$',code:'HKD',currency:'港币'},us:{name:'美股',unit:'美元',sign:'US$',code:'USD',currency:'美元'}};
const colors=['#527348','#b47741','#4f7997','#8f6899','#3d8d7e','#bd6176','#8b822e','#6864a1'];
const state={plans:[],results:[],groups:[],currency:'cn',valuations:new Map(),metric:'profit',granularity:'month',busy:false,next:1};
const cache=new Map(),loadRates=createFxApi();
const currencySelect=$('#chart-currency'),currencyStatus=$('#chart-currency-status');
const signed=n=>(n>=0?'+':'−')+money.format(Math.abs(n));
const percent=n=>(n>=0?'+':'')+(n*100).toFixed(2)+'%';
function message(text,error=false){
 const box=$('#chart-state');box.hidden=false;box.className='chart-state'+(error?' error':'');box.replaceChildren();
 const title=document.createElement('strong');title.textContent=error?'请检查定投计划':state.busy?'正在读取行情':'添加你的定投计划';
 if(!state.busy&&!error&&state.results.length)title.textContent='选择要查看的计划';
 const p=document.createElement('p');p.textContent=text;box.append(title,p);
}
function refreshDateBounds(){for(const input of document.querySelectorAll('.plan-row input[type=date]')){input.min=firstHistoryDate;input.max=currentMarketDate();}}
window.addEventListener('focus',refreshDateBounds);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshDateBounds();});
setInterval(refreshDateBounds,60000);
function field(row,name){return row.querySelector('[data-field="'+name+'"]');}
function schedule(row){
 const frequency=field(row,'frequency').value,select=field(row,'schedule'),previous=select.value;
 select.hidden=frequency==='daily';select.replaceChildren();
 const labels=frequency==='weekly'?['周一','周二','周三','周四','周五']:Array.from({length:31},(_,i)=>(i+1)+' 号');
 labels.forEach((label,i)=>select.add(new Option(label,i+1)));
 select.value=Number(previous)>0&&Number(previous)<=labels.length?previous:'1';
 select.setAttribute('aria-label',frequency==='weekly'?'每周几':'每月几号');
}
async function stockOptions(plan){
 const market=field(plan.row,'market').value,select=field(plan.row,'stock'),version=++plan.version;
 plan.selected=null;plan.loading=true;select.disabled=true;select.replaceChildren(new Option('正在加载…',''));
 try{
  if(!cache.has(market))cache.set(market,api.stockOptions(market).catch(e=>{cache.delete(market);throw e;}));
  const page=await cache.get(market);
  if(version!==plan.version)return;
  plan.stocks=page.results;select.replaceChildren(new Option(page.results.length?'请选择股票 / ETF':'暂无可用标的',''));
  // Each plan uses its own native select, backed by the same cached catalogue.
  const fragment=document.createDocumentFragment();
  for(const item of page.results){const code=market==='cn'?item.symbol.slice(2)+'.'+item.symbol.slice(0,2).toUpperCase():market==='hk'?item.symbol+'.HK':item.symbol;fragment.append(new Option(item.name+'（'+code+'）',item.symbol));}
  select.append(fragment);
 }catch(e){if(version===plan.version){plan.stocks=[];select.replaceChildren(new Option('加载失败，切换市场重试',''));message(e.message,true);}}
 finally{if(version===plan.version){plan.loading=false;select.disabled=state.busy||!plan.stocks?.length;}}
}
function addPlan(){
 const id=state.next++,row=document.createElement('div');row.className='plan-row';row.setAttribute('role','group');row.setAttribute('aria-label','定投计划 '+id);
 const plan={id,row,version:0,checked:true,color:id<=colors.length?colors[id-1]:`hsl(${((id-1)*137.508)%360} 48% 43%)`,selected:null};
 row.innerHTML=`<span class="plan-number">计划 ${id}</span>
 <div class="date-cell"><label for="plan-start-${id}">开始日期</label><input id="plan-start-${id}" data-field="start" aria-label="计划 ${id} 开始日期" type="date" value="2023-01-01"></div>
 <span class="plan-date-arrow" aria-hidden="true">→</span>
 <div class="date-cell"><label for="plan-end-${id}">结束日期</label><input id="plan-end-${id}" data-field="end" aria-label="计划 ${id} 结束日期" type="date" value="${currentMarketDate()}"></div>
 <div class="plan-schedule"><select data-field="frequency" aria-label="计划 ${id} 定投周期"><option value="monthly">每月</option><option value="weekly">每周</option><option value="daily">每个交易日</option></select><select data-field="schedule" aria-label="每月几号"></select></div>
 <label class="plan-amount"><span class="sr-only">计划 ${id} 每次投入金额</span><input data-field="amount" aria-label="计划 ${id} 每次投入金额" type="number" min="1" max="100000000" step="any" placeholder="每次投入" inputmode="decimal"><span data-unit>元</span></label>
 <select data-field="market" aria-label="计划 ${id} 股票类型"><option value="cn">A股</option><option value="hk">港股</option><option value="us">美股</option></select>
 <select data-field="stock" aria-label="计划 ${id} 股票名称" disabled><option value="">正在加载…</option></select>
 <button class="remove-plan" type="button" aria-label="删除计划 ${id}" title="删除计划">×</button>`;
 state.plans.push(plan);$('#plan-list').append(row);schedule(row);refreshDateBounds();
 for(const input of row.querySelectorAll('input[type=date]'))enhanceDateInput(input);
 field(row,'frequency').addEventListener('change',()=>schedule(row));
 field(row,'market').addEventListener('change',()=>{row.querySelector('[data-unit]').textContent=markets[field(row,'market').value].unit;stockOptions(plan);});
 field(row,'stock').addEventListener('change',()=>{plan.selected=plan.stocks?.find(s=>s.symbol===field(row,'stock').value)||null;});
 row.querySelector('.remove-plan').addEventListener('click',()=>{plan.version++;state.plans=state.plans.filter(p=>p!==plan);state.results=state.results.filter(p=>p.id!==id);state.valuations.delete(id);row.remove();if(!state.plans.length)addPlan();renderToggles();renderResult();});
 stockOptions(plan);return plan;
}
$('#add-plan').addEventListener('click',()=>{const p=addPlan();field(p.row,'amount').focus();});
function busy(value){
 state.busy=value;$('#run-button').disabled=value;$('#add-plan').disabled=value;$('#run-label').textContent=value?'正在计算各项计划…':'那么现在会？';
 for(const p of state.plans)for(const el of p.row.querySelectorAll('input,select,button'))el.disabled=value||(el===field(p.row,'stock')&&(p.loading||!p.stocks?.length));
 currencySelect.disabled=value;
 $('#export-button').disabled=value||!state.group;$('#benchmark-toggle').disabled=value||state.results.some(p=>p.options.market!=='cn');
 $('#chart-container').setAttribute('aria-busy',String(value));
}
function optionsFor(plan){
 const row=plan.row,amount=Number(field(row,'amount').value),start=field(row,'start').value,end=field(row,'end').value;
 validateDateRange(start,end);
 if(!plan.selected)throw new Error('请选择股票或 ETF。');
 if(!Number.isFinite(amount)||amount<1||amount>1e8)throw new Error('每次投入金额需在 1 至 1 亿之间。');
 return {start,end,amount,market:field(row,'market').value,frequency:field(row,'frequency').value,weekday:Number(field(row,'schedule').value),monthday:Number(field(row,'schedule').value),stock:{...plan.selected}};
}
async function calculate(plan,options,compare){
 let stock,coverage,dividends,index=null;
 if(options.market==='cn'){
  [stock,coverage,dividends,index]=await Promise.all([
   options.stock.firstDate&&options.end<options.stock.firstDate?Promise.resolve({bars:[]}):api.history(options.stock.symbol,options),
   api.dataStatus(options.stock.symbol),api.dividends(options.stock.symbol,options),compare?api.history('sh000001',options):Promise.resolve(null)]);
 }else({stock,coverage,dividends}=await api.foreignSnapshot(options.market,options.stock.symbol,options));
 if(options.stock.kind!=='指数'&&coverage?.dividends?.status!=='collected')throw new Error('分红数据尚未采集完成，暂不能计算含分红收益。');
 return {id:plan.id,name:'计划 '+plan.id+' · '+options.stock.name,color:plan.color,checked:plan.checked,options,result:simulate(options,stock.bars,index?.bars||[],dividends?.events||[])};
}
async function valuePlans(plans,target){
 const ranges=new Map();
 for(const {options:{market,start,end}} of plans){
  if(market===target)continue;
  for(const currency of [market,target]){
   if(currency==='cn')continue;
   const range=ranges.get(currency);
   ranges.set(currency,[!range||start<range[0]?start:range[0],!range||end>range[1]?end:range[1]]);
  }
 }
 const rates=new Map(await Promise.all([...ranges].map(async ([currency,[start,end]])=>[currency,await loadRates(currency,start,end)])));
 return new Map(plans.map(plan=>[plan.id,convertPlanCurrency(plan,target,rates.get(plan.options.market),rates.get(target))]));
}
function showCurrencyStatus(text){
 currencyStatus.textContent=text;
 currencyStatus.hidden=!text;
}
currencySelect.addEventListener('change',async ()=>{
 const target=currencySelect.value;
 if(target===state.currency||state.busy)return;
 if(!state.results.length){
  state.currency=target;
  $('#hero-value span').textContent=markets[target].unit;
  return;
 }
 busy(true);showCurrencyStatus('正在读取历史汇率…');
 try{
  const valuations=await valuePlans(state.results,target);
  state.currency=target;state.valuations=valuations;
  showCurrencyStatus('');renderResult();
 }catch(error){
  currencySelect.value=state.currency;
  showCurrencyStatus(error.message?.includes('汇率')?error.message:'币种切换失败，请重试。');
 }finally{busy(false);}
});
async function run(){
 if(state.busy)return;
 const jobs=[];
 try{
  refreshDateBounds();
  for(const plan of state.plans){
   // An untouched row is a draft; a partially entered plan must pass validation.
   if(!field(plan.row,'amount').value&&!field(plan.row,'stock').value)continue;
   try{jobs.push({plan,options:optionsFor(plan)});}catch(e){throw new Error('计划 '+plan.id+'：'+e.message);}
  }
  if(!jobs.length)throw new Error('请至少填写一条计划的金额和标的。');
 }catch(e){message(e.message,true);return;}
 busy(true);showCurrencyStatus('');message('正在读取已采集行情，收益在当前浏览器中独立计算。');
 try{
  if(jobs.some(job=>job.options.market!=='cn'))$('#benchmark-toggle').checked=false;
  const results=[]; // Bound requests to one plan at a time, without contacting collection sources.
  for(const job of jobs){try{results.push(await calculate(job.plan,job.options,$('#benchmark-toggle').checked));}catch(e){throw new Error('计划 '+job.plan.id+'：'+e.message);}}
  const valuations=await valuePlans(results,state.currency);
  state.results=results;state.valuations=valuations;
  if(field(state.plans.at(-1).row,'stock').value||field(state.plans.at(-1).row,'amount').value)addPlan();
  renderToggles();renderResult();
 }catch(e){message(e.message,true);}
 finally{busy(false);}
}
$('#investment-form').addEventListener('submit',e=>{e.preventDefault();run();});
$('#benchmark-toggle').addEventListener('change',()=>{if(state.results.length)run();});
function renderToggles(){
 const box=$('#plan-toggles');box.replaceChildren();
 for(const result of state.results){
  const label=document.createElement('label'),input=document.createElement('input'),swatch=document.createElement('i');
  input.type='checkbox';input.checked=result.checked;input.setAttribute('aria-label',result.name+' 参与合计');swatch.style.background=result.color;
  label.append(input,swatch,document.createTextNode(result.name+'（'+markets[result.options.market].unit+'投入）'));box.append(label);
  input.addEventListener('change',()=>{result.checked=input.checked;const plan=state.plans.find(p=>p.id===result.id);if(plan)plan.checked=input.checked;renderResult();});
 }
}
function renderResult(){
 state.groups=combinePlans(state.results.filter(p=>p.checked).map(p=>state.valuations.get(p.id)),state.currency);
 const group=state.groups[0],currency=markets[state.currency];state.group=group;
 const last=group?.last||{profit:0,assets:0,contributed:0,rate:0};
 const hero=$('#hero-value');hero.replaceChildren(document.createTextNode(signed(last.profit)));const unit=document.createElement('span');unit.textContent=currency.unit;hero.append(unit);hero.classList.toggle('negative',last.profit<0);
 $('#period-years').textContent=group?group.series[0].date+' — '+group.last.date:'—';
 $('#stat-invested').textContent=currency.sign+' '+money.format(last.contributed);$('#stat-assets').textContent=currency.sign+' '+money.format(last.assets);$('#stat-rate').textContent=percent(last.rate);$('#stat-count').textContent=(group?.count||0)+' 次';
 $('#actual-range').textContent=group?group.members.map(p=>p.name+'：'+p.options.start+' 至 '+p.options.end+'，首笔执行 '+(p.result.firstPurchase||'尚未执行')).join('；')+'。':'';
 $('#data-dimensions').hidden=false;$('#data-dimensions').textContent='不复权收盘价；现金分红保留为现金，送转和拆并股计入持股。计划结束后按最后可用行情估值并保留至合计区间末尾。各计划曲线及合计均按所选币种显示。每笔投入按执行日参考汇率折算，资产按估值日汇率折算。';
 $('#benchmark-legend').hidden=!$('#benchmark-toggle').checked||state.results.some(p=>p.options.market!=='cn');
 $('#export-button').disabled=state.busy||!group;
 if(!group){$('#chart').replaceChildren();$('#chart-tooltip').hidden=true;message(state.results.length?'勾选下方计划，查看曲线和合计。':'填写标的和金额，开始查看收益曲线。');return;}
 $('#chart-state').hidden=true;drawChart();
}
for(const [attribute,key] of [['metric','metric'],['granularity','granularity']])for(const button of document.querySelectorAll('[data-'+attribute+']'))button.addEventListener('click',()=>{state[key]=button.dataset[attribute];for(const other of document.querySelectorAll('[data-'+attribute+']')){other.classList.toggle('active',other===button);other.setAttribute('aria-pressed',String(other===button));}drawChart();});
function drawChart(){
 if(!state.group)return;
 const group=state.group,metric=state.metric,currency=markets[group.market],data=chartSeries(group.series,state.granularity);
 const svg=$('#chart'),W=Math.max(320,svg.clientWidth||1000),H=Math.max(230,svg.clientHeight||390),L=70,R=20,T=25,B=40;
 svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
 const first=Date.parse(data[0].date),span=Date.parse(data.at(-1).date)-first;
 const pixel=v=>Math.round(v/2)*2;
 const x=date=>pixel(L+(span?(Date.parse(date)-first)/span*(W-L-R):(W-L-R)/2));
 const series=group.members.map(p=>({name:p.name,color:p.color,points:data.map(d=>({date:d.date,value:d.values[p.id]?.[metric]||0,events:d.values[p.id]?.date===d.date?d.values[p.id].events:[]}))}));
 series.push({name:'所选计划合计',color:'#293f32',total:true,points:data.map(d=>({date:d.date,value:d[metric]}))});
 if($('#benchmark-toggle').checked&&group.members.every(p=>p.options.market==='cn'))series.push({name:'上证指数',color:'#b68d62',benchmark:true,points:data.map(d=>({date:d.date,value:d[metric==='profit'?'benchmarkProfit':'benchmarkAssets']}))});
 const scale=chartScale(series.flatMap(s=>s.points.map(p=>p.value))),y=v=>pixel(T+(scale.hi-v)/(scale.hi-scale.lo)*(H-T-B));
 let html=`<text x="${L-12}" y="14" text-anchor="end" fill="var(--theme-muted, #7b8e61)" font-size="12">${currency.code}</text>`;
 for(const v of scale.ticks){const label=Math.abs(v)>=1e8?(v/1e8).toFixed(1)+'亿':Math.abs(v)>=1e4?(v/1e4).toFixed(1)+'万':Number(v.toPrecision(4));html+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="#b8c29c" stroke-dasharray="2 6"/><text x="${L-12}" y="${y(v)+4}" text-anchor="end" fill="#7b8e61" font-size="12">${label}</text>`;}
 for(let i=0;i<Math.min(5,data.length);i++){const d=data[Math.round(i*(data.length-1)/Math.max(1,Math.min(5,data.length)-1))];html+=`<text x="${x(d.date)}" y="${H-10}" text-anchor="middle" fill="#7b8e61" font-size="12">${d.date.slice(0,7)}</text>`;}
 for(const s of series){const path=s.points.map((p,i)=>(i?'L':'M')+x(p.date).toFixed(2)+','+y(p.value).toFixed(2)).join(' ');html+=`<path data-curve="${s.total?'total':s.benchmark?'benchmark':'plan'}" d="${path}" fill="none" stroke="${s.color}" stroke-width="${s.total?4:2}" stroke-dasharray="${s.total?'8 4':s.benchmark?'4 4':'none'}" stroke-linejoin="miter" stroke-linecap="square"/>`;if(data.length===1)html+=`<rect x="${x(data[0].date)-4}" y="${y(s.points[0].value)-4}" width="8" height="8" fill="${s.color}"/>`;}
 html+=`<line id="crosshair" y1="${T}" y2="${H-B}" stroke="#6f8455" stroke-width="2" stroke-dasharray="4 4" visibility="hidden"/><rect id="chart-hit" x="${L}" y="${T}" width="${W-L-R}" height="${H-T-B}" fill="transparent" tabindex="0" role="slider" aria-label="浏览曲线日期，使用左右方向键" aria-valuemin="0" aria-valuemax="${data.length-1}" aria-valuenow="0"/>`;
 for(const s of series.filter(s=>!s.total&&!s.benchmark))s.points.forEach((p,i)=>{if(p.events?.length)html+=`<g class="dividend-marker" data-index="${i}" tabindex="0" role="button" aria-label="${p.date} 分红送转，查看方案"><rect x="${x(p.date)-10}" y="${y(p.value)-10}" width="20" height="20" fill="transparent"/><rect x="${x(p.date)-4}" y="${y(p.value)-4}" width="8" height="8" fill="${s.color}" stroke="#faf6de" stroke-width="2"/></g>`;});
 svg.innerHTML=html;
 $('#sampling-note').textContent=state.granularity==='day'?'按日显示':state.granularity==='month'?'按月显示期末值':'按年显示期末值';
 const hit=$('#chart-hit'),tip=$('#chart-tooltip');tip.hidden=true;let selected=0;
 function hover(index){
  selected=Math.max(0,Math.min(data.length-1,index));const date=data[selected].date,xx=x(date);$('#crosshair').setAttribute('visibility','visible');$('#crosshair').setAttribute('x1',xx);$('#crosshair').setAttribute('x2',xx);hit.setAttribute('aria-valuenow',selected);hit.setAttribute('aria-valuetext',date);
  tip.replaceChildren();const title=document.createElement('strong');title.textContent=date;tip.append(title);
  for(const s of series){const row=document.createElement('div');row.className='tooltip-line';const name=document.createElement('span'),value=document.createElement('span');name.textContent=s.name;name.style.color=s.color;value.textContent=currency.sign+' '+signed(s.points[selected].value);row.append(name,value);tip.append(row);}
  for(const event of data[selected].events||[]){const row=document.createElement('div');row.className='tooltip-event';row.textContent=event.planName+' · 分红送转：现金 '+money.format(event.cashAmount||0)+' '+currency.unit+'；送转 '+money.format((event.bonusUnits||0)+(event.transferUnits||0))+' 股'+(event.shareFactor&&event.shareFactor!==1?'；拆并股比例 '+event.shareFactor:'');tip.append(row);}
  tip.hidden=false;const container=$('#chart-container');tip.style.left=Math.max(0,Math.min(container.clientWidth-tip.offsetWidth,xx/W*container.clientWidth+12))+'px';tip.style.top='16px';
 }
 hit.addEventListener('pointermove',e=>{const rect=svg.getBoundingClientRect(),px=(e.clientX-rect.left)/rect.width*W;hover(data.reduce((best,d,i)=>Math.abs(x(d.date)-px)<Math.abs(x(data[best].date)-px)?i:best,0));});
 function hide(){tip.hidden=true;$('#crosshair').setAttribute('visibility','hidden');}
 for(const marker of svg.querySelectorAll('.dividend-marker')){const show=()=>hover(Number(marker.dataset.index));marker.addEventListener('pointerenter',show);marker.addEventListener('pointerleave',hide);marker.addEventListener('focus',show);marker.addEventListener('blur',hide);marker.addEventListener('click',show);marker.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();show();}});}
 hit.addEventListener('pointerleave',hide);hit.addEventListener('blur',hide);hit.addEventListener('focus',()=>hover(selected));hit.addEventListener('keydown',e=>{if(['ArrowRight','ArrowLeft'].includes(e.key)){e.preventDefault();hover(selected+(e.key==='ArrowRight'?1:-1));}});
}
$('#export-button').addEventListener('click',()=>{
 const rows=[['日期','计划','币种','累计投入','总资产','收益','累计收益率','投入原币种','原币累计投入','原币总资产','折算汇率','汇率日期']];
 const currency=markets[state.currency].currency;
 for(const g of state.groups)for(const d of g.series){for(const p of g.members){const v=d.values[p.id];rows.push([d.date,p.name,currency,v?.contributed||0,v?.assets||0,v?.profit||0,v?.rate||0,markets[p.options.market].unit,v?.native?.contributed??v?.contributed??0,v?.native?.assets??v?.assets??0,p.options.market===state.currency?1:v?.fxRate??'',v?.fxDate??'']);}rows.push([d.date,'所选计划合计',currency,d.contributed,d.assets,d.profit,d.rate]);}
 const escape=v=>'"'+String(v).replaceAll('"','""')+'"';const blob=new Blob(['\uFEFF'+rows.map(r=>r.map(value=>escape(typeof value==='string'?t(value):value)).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=t('拾日_多计划回测.csv');a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
$('#about-open').addEventListener('click',()=>$('#about-dialog').showModal());
for(const id of ['about-close','about-done'])$('#'+id).addEventListener('click',()=>$('#about-dialog').close());
$('#about-dialog').addEventListener('click',e=>{if(e.target===$('#about-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
let resizeTimer;
window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(drawChart,100);});

addPlan();
