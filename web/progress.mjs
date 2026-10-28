import config from './config.mjs';
const $=id=>document.getElementById(id);
const number=value=>Number(value??0).toLocaleString('zh-CN');
const time=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+'（北京时间）':'—';
const size=value=>(Number(value??0)/1024/1024).toFixed(1)+' MiB';
const states={cataloguing:'核对股票名单并分批采集',running:'分批采集中',paused_capacity:'容量保护：已暂停',paused_provider:'数据源冷却：已暂停',paused_manual:'已手动暂停',completed:'全部完成',completed_with_errors:'本轮结束，部分股票仍需处理'};
let busy=false;
async function refresh(){
  if(busy)return;
  busy=true;$('refresh').disabled=true;
  try{
    const response=await fetch(config.url+'/rest/v1/rpc/market_bulk_progress',{method:'POST',headers:{apikey:config.key,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw new Error('进度读取失败，请稍后刷新。');
    const d=await response.json();
    if(!d){$('state').textContent='尚未启动采集';return;}
    $('state').textContent=states[d.state]??d.state;
    $('updated').textContent='快照：'+time(d.snapshotAt);
    $('error').textContent='';
    $('discovered').textContent=number(d.catalogue.discoveredStocks);
    $('universe').textContent='数据源报告 '+number(d.catalogue.expectedStocks)+' 只';
    $('complete').textContent=number(d.stocks.completed);
    $('stock-detail').textContent=`采集中 ${number(d.stocks.collecting)} · 部分成功 ${number(d.stocks.partial)} · 失败 ${number(d.stocks.failed)}`;
    $('prices').textContent=number(d.published.priceRows);
    $('dividends').textContent=number(d.published.dividendRows);
    $('requests').textContent=number(d.requests.completed);
    $('request-detail').textContent=`已知任务 ${number(d.requests.totalKnown)} · 最终失败 ${number(d.requests.failed)}`;
    $('capacity').textContent=size(d.capacity.databaseBytes);
    $('capacity-limit').textContent='达到 '+size(d.capacity.pauseAtBytes)+' 后暂停';
    $('progress').max=d.stocks.total||1;$('progress').value=d.stocks.completed;
    $('coverage').textContent=`${number(d.stocks.completed)} / ${number(d.stocks.total)} 只完整成功。`+(d.catalogue.complete?'名单已核对完整。':'名单尚未完整，继续逐页核实。');
    $('cutoff').textContent=d.cutoff;$('started').textContent=time(d.startedAt);
    $('catalogue').textContent=d.catalogue.complete?'完整':'已核实 '+number(d.catalogue.discoveredStocks)+' 只，下一页 '+d.catalogue.nextPage;
    $('catalogue-next').textContent=d.catalogue.complete?'无需继续翻页':time(d.catalogue.nextAttemptAt);
    $('blocked').textContent=time(d.blockedUntil);$('last-error').textContent=/error sending request|fetch failed|connection/i.test(d.lastError??'')?'数据源连接失败，已保存断点并延迟重试。':d.lastError||'暂无';
    $('failures').replaceChildren();
    for(const f of d.recentFailures??[]){const li=document.createElement('li');li.textContent=f.symbol+'：'+f.status+'；'+(f.error||'详见采集日志');$('failures').append(li);}
    if(!$('failures').children.length){const li=document.createElement('li');li.textContent='暂无记录';$('failures').append(li);}
  }catch(error){$('error').textContent=error.message||'进度读取失败';}
  finally{busy=false;$('refresh').disabled=false;}
}
$('refresh').addEventListener('click',refresh);
refresh();setInterval(refresh,60000);
