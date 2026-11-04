import {project} from './projection.mjs';
import {chartScale} from './chart-scale.mjs';
import {DAY,zoomTimeRange} from './chart-zoom.mjs';
import {currentMarketDate} from './dates.mjs';
const $=s=>document.querySelector(s),today=currentMarketDate(),KEY='shiri.personal-plan.v1';
const money=n=>'¥ '+new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);
const defaults={start:today,years:5,initial:0,amount:1000,frequency:'monthly',rate:6,rateUnit:'yearly'};
const metric='assets';
let plan={...defaults},records=[],result,viewport=null,chartGeometry,zoomFrame;
$('#p-chart-range').addEventListener('change',()=>{viewport=null;draw();});
$('#p-chart-reset').addEventListener('click',()=>{viewport=null;draw();});
try{const stored=JSON.parse(localStorage.getItem(KEY));if(stored){project(stored.plan,stored.records,today);plan=stored.plan;records=stored.records;}}catch{$('#save-status').textContent='未能读取本地数据，当前使用新计划';}
function save(){try{localStorage.setItem(KEY,JSON.stringify({plan,records}));$('#save-status').textContent='已保存到当前浏览器';}catch{$('#save-status').textContent='浏览器无法保存，刷新后更改会丢失';}}
function fillPlan(){for(const [id,key] of Object.entries({'p-start':'start','p-years':'years','p-initial':'initial','p-amount':'amount','p-frequency':'frequency','p-rate':'rate','p-rate-unit':'rateUnit'}))$('#'+id).value=plan[key];}
fillPlan();$('#a-date').value=today;
$('#projection-form').addEventListener('submit',e=>{e.preventDefault();try{const candidate={start:$('#p-start').value,years:Number($('#p-years').value),initial:Number($('#p-initial').value),amount:Number($('#p-amount').value),frequency:$('#p-frequency').value,rate:Number($('#p-rate').value),rateUnit:$('#p-rate-unit').value};project(candidate,records,today);plan=candidate;save();render();$('#plan-error').textContent='';}catch(error){$('#plan-error').textContent=error.message;}});
$('#actual-form').addEventListener('submit',e=>{e.preventDefault();try{const value=$('#a-value').value;if(!value.trim())throw Error('请填写实际数据。');const record={date:$('#a-date').value,mode:'assets',value:Number(value)};const candidate=[...records.filter(r=>r.date!==record.date),record].sort((a,b)=>a.date.localeCompare(b.date));project(plan,candidate,today);records=candidate;save();render();$('#record-error').textContent='';$('#a-value').value='';}catch(error){$('#record-error').textContent=error.message;}});
function displayGap(element,value){
  const rounded=Math.round(value*100)/100;
  element.textContent=(rounded>0?'+':rounded<0?'−':'')+money(Math.abs(rounded));
  element.classList.toggle('gap-positive',rounded>0);
  element.classList.toggle('gap-negative',rounded<0);
}
function render(){
  viewport=null;
  result=project(plan,records,today);const final=result.expected.at(-1),latest=result.latest;
  $('#projection-range').textContent=plan.start+' — '+result.end;
  $('#forecast-assets').textContent=money(final.assets);$('#forecast-profit').textContent=money(final.profit);$('#forecast-invested').textContent=money(final.invested);
  $('#progress-date').textContent=latest?'最新纪录至 '+latest.date:'尚无实际记录';
  const target=latest?result.expected.find(p=>p.date===latest.date):null;
  $('#actual-assets').textContent=latest?money(latest.assets):'—';$('#current-target').textContent=target?money(target.assets):'—';
  if(latest)displayGap($('#target-gap'),latest.assets-target.assets);else{$('#target-gap').textContent='—';$('#target-gap').classList.remove('gap-positive','gap-negative');}
  const elapsed=Math.max(0,Math.min(100,(Date.parse(latest?.date||today)-Date.parse(plan.start))/(Date.parse(result.end)-Date.parse(plan.start))*100));
  $('#progress-fill').style.width=elapsed+'%';
  const min=plan.start,max=today<result.end?today:result.end;
  $('#a-date').min=min;$('#a-date').max=max;$('#actual-form button').disabled=min>max;
  $('#p-chart-range option[value=recorded]').disabled=!latest;
  if(!latest)$('#p-chart-range').value='full';
  $('#records-empty').hidden=records.length>0;$('#chart-note').textContent=latest?'实际线仅连接记录点，未记录的未来留白。':'添加实际记录后，第二条曲线会从计划开始日延伸至最新记录日。';
  const body=$('#records-body');body.replaceChildren();
  for(const record of [...records].reverse()){
    const row=result.actual.find(p=>p.date===record.date),target=result.expected.find(p=>p.date===record.date),tr=document.createElement('tr');
    const values=[record.date,money(row.assets),money(row.profit)];
    for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);}
    const gap=document.createElement('td');displayGap(gap,row.assets-target.assets);tr.append(gap);
    const td=document.createElement('td'),button=document.createElement('button');button.type='button';button.className='record-delete';button.textContent='删除';button.setAttribute('aria-label','删除 '+record.date+' 的记录');button.addEventListener('click',()=>{records=records.filter(r=>r.date!==record.date);save();render();$('#record-error').textContent='已删除记录。';});td.append(button);tr.append(td);body.append(tr);
  }
  draw();
}
function draw(){
  if(!result)return;
  const svg=$('#projection-chart'),W=Math.max(300,svg.clientWidth||800),H=320,L=64,R=22,T=25,B=38,pw=W-L-R,ph=H-T-B;
  svg.setAttribute('viewBox',`0 0 ${W} ${H}`);
  const chartEnd=$('#p-chart-range').value==='recorded'&&result.latest?result.latest.date:result.end;
  const bounds={start:Date.parse(plan.start),end:Date.parse(chartEnd)};
  viewport??={...bounds};
  const {start,end}=viewport,span=end-start;
  $('#p-chart-reset').hidden=Math.abs(start-bounds.start)<1&&Math.abs(end-bounds.end)<1;
  chartGeometry={W,L,pw,bounds,T,ph};
  const x=d=>L+(span?(Date.parse(d)-start)/span*pw:pw/2);
  const first=Math.max(0,Math.floor((start-bounds.start)/DAY)),last=Math.min(result.expected.length-1,Math.ceil((end-bounds.start)/DAY));
  const visible=result.expected.slice(first,last+1);
  const indices=new Set([0,visible.length-1]);const stride=Math.max(1,Math.floor(visible.length/250));for(let i=0;i<visible.length;i+=stride)indices.add(i);
  const expected=[...indices].sort((a,b)=>a-b).map(i=>visible[i]);
  const actual=result.actual.filter((p,i,rows)=>Date.parse(p.date)>=start&&Date.parse(p.date)<=end||i+1<rows.length&&Date.parse(p.date)<start&&Date.parse(rows[i+1].date)>=start||i>0&&Date.parse(p.date)>end&&Date.parse(rows[i-1].date)<=end);
  // Scale to the visible line, interpolating segments that cross a boundary.
  const values=[];
  for(const rows of [expected,actual]){
    for(let i=0;i<rows.length;i++){
      const p=rows[i],t=Date.parse(p.date);
      if(t>=start&&t<=end)values.push(p[metric]);
      if(i){const previous=rows[i-1],pt=Date.parse(previous.date);for(const edge of [start,end])if(pt<edge&&t>edge)values.push(previous[metric]+(p[metric]-previous[metric])*(edge-pt)/(t-pt));}
    }
  }
  const {lo,hi,ticks}=chartScale(values);const y=v=>T+(hi-v)/(hi-lo)*ph;
  const path=rows=>rows.map((p,i)=>`${i?'L':'M'}${x(p.date)},${y(p[metric])}`).join(' ');
  const number=n=>Math.abs(n)>=1e8?(n/1e8).toFixed(1)+'亿':Math.abs(n)>=10000?(n/10000).toFixed(1)+'万':new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n);
  let html=`<defs><clipPath id="projection-clip"><rect x="${L}" y="${T}" width="${pw}" height="${ph}"/></clipPath></defs>`+'<defs><linearGradient id="expected-fill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#9cb47b" stop-opacity=".18"/><stop offset="1" stop-color="#9cb47b" stop-opacity="0"/></linearGradient></defs>';
  for(const v of ticks)html+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" stroke="${v===0?'#b2bfa4':'#e2e6da'}" stroke-dasharray="3 5"/><text x="${L-10}" y="${y(v)+4}" text-anchor="end" fill="#909c84" font-size="10">${number(v)}</text>`;
  for(let i=0;i<(span?4:1);i++){const t=Math.round((start+span*i/3)/DAY)*DAY;const d=new Date(t).toISOString().slice(0,10);html+=`<text x="${span?L+pw*i/3:L+pw/2}" y="${H-10}" text-anchor="middle" fill="#909c84" font-size="10">${span<=120*86400000?d.slice(5):d.slice(0,7)}</text>`;}
  html+=`<g clip-path="url(#projection-clip)"><path d="${path(expected)} L${x(expected.at(-1).date)},${y(0)} L${x(expected[0].date)},${y(0)} Z" fill="url(#expected-fill)"/><path d="${path(expected)}" fill="none" stroke="#66864e" stroke-width="2.4" stroke-dasharray="6 4"/>`;
  if(expected.length===1)html+=`<circle cx="${x(plan.start)}" cy="${y(expected[0][metric])}" r="4" fill="#66864e"/>`;
  if(actual.length){html+=`<path d="${path(actual)}" fill="none" stroke="#b68d62" stroke-width="2.6"/>`;for(const p of actual)html+=`<circle cx="${x(p.date)}" cy="${y(p[metric])}" r="4" fill="#b68d62" stroke="#fffef9" stroke-width="2"/>`;}
  html+=`</g><line id="p-crosshair" y1="${T}" y2="${H-B}" stroke="#a9b59b" stroke-dasharray="3 5" visibility="hidden"/><rect id="projection-hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent" tabindex="0" role="slider" aria-label="浏览预期日期，使用左右方向键" aria-valuemin="0" aria-valuemax="${visible.length-1}" aria-valuenow="0"/>`;
  svg.innerHTML=html;const tip=$('#projection-tooltip'),hit=$('#projection-hit');tip.hidden=true;let index=0;
  const show=i=>{index=Math.max(0,Math.min(visible.length-1,i));const p=visible[index],actual=result.actual.find(r=>r.date===p.date);tip.replaceChildren();const title=document.createElement('strong');title.textContent=p.date;tip.append(title);for(const [name,value] of [['理想预期',money(p[metric])],['实际记录',actual?money(actual[metric]):'尚无记录'],['累计投入',money(p.invested)]]){const row=document.createElement('div');row.className='tooltip-line';const a=document.createElement('span'),b=document.createElement('span');a.textContent=name;b.textContent=value;row.append(a,b);tip.append(row);}tip.hidden=false;tip.style.top='8px';tip.style.left=Math.max(0,Math.min(W-tip.offsetWidth,x(p.date)+12))+'px';const cross=$('#p-crosshair');cross.setAttribute('x1',x(p.date));cross.setAttribute('x2',x(p.date));cross.setAttribute('visibility','visible');hit.setAttribute('aria-valuenow',index);hit.setAttribute('aria-valuetext',p.date+'，理想预期 '+money(p[metric]));};
  const hide=()=>{tip.hidden=true;$('#p-crosshair').setAttribute('visibility','hidden');};
  hit.addEventListener('pointermove',e=>{const r=svg.getBoundingClientRect(),fraction=((e.clientX-r.left)/r.width*W-L)/pw;const desired=Math.round((start+fraction*span-Date.parse(visible[0].date))/DAY);let nearest=desired;for(const p of actual){const i=Math.round((Date.parse(p.date)-Date.parse(visible[0].date))/DAY);if(Math.abs(x(p.date)-(L+fraction*pw))<9){nearest=i;break;}}show(nearest);});hit.addEventListener('pointerleave',hide);hit.addEventListener('focus',()=>show(index));hit.addEventListener('blur',hide);hit.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();show(index+(e.key==='ArrowRight'?1:-1));}});
}
// Listen on the stable SVG so successive trackpad events survive redraws.
$('#projection-chart').addEventListener('wheel',e=>{
  if(!chartGeometry)return;
  const {W,L,pw,bounds,T,ph}=chartGeometry,r=e.currentTarget.getBoundingClientRect();
  const px=(e.clientX-r.left)/r.width*W,py=(e.clientY-r.top)/r.height*320;
  if(px<L||px>L+pw||py<T||py>T+ph)return;
  const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?320:1);
  if(!delta)return;
  e.preventDefault();
  viewport=zoomTimeRange(viewport,bounds,(px-L)/pw,Math.max(-200,Math.min(200,delta))*(e.ctrlKey?.01:.002));
  if(!zoomFrame)zoomFrame=requestAnimationFrame(()=>{zoomFrame=null;draw();});
},{passive:false});
let resize;window.addEventListener('resize',()=>{clearTimeout(resize);resize=setTimeout(draw,100);});render();
