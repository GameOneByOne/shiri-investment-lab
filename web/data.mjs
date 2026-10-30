// Data transport only: the API never receives contribution amounts or schedules.
export function createDataApi(config,fetcher=globalThis.fetch){
  async function rpc(name,params={},signal){
    if(!config.url||!config.key)throw new Error('行情服务尚未配置，请配置 Supabase 后重新部署。');
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),20000);
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    try{
      const response=await fetcher(`${config.url}/rest/v1/rpc/${name}`,{
        method:'POST',headers:{apikey:config.key,'Content-Type':'application/json'},
        body:JSON.stringify(params),signal:combined
      });
      const data=await response.json();
      if(!response.ok)throw new Error(data.message||'行情读取失败，请稍后重试。');
      return data;
    }catch(error){
      if(error.name==='AbortError'||error.name==='TimeoutError')throw new Error('行情读取超时，请稍后重试。');
      throw error;
    }finally{clearTimeout(timer);}
  }
  return {
    config:()=>rpc('market_config'),
    ready:()=>rpc('market_ready'),
    search:(query,signal)=>rpc('market_search',{p_query:query},signal),
    available:(query='',after=null,signal)=>rpc('market_available',{p_query:query,p_after:after},signal),
    history:(symbol,options)=>rpc('market_history',{p_symbol:symbol,p_start:options.start,p_end:options.end}),
    prices:(symbol,options,adjust='none')=>rpc('market_prices',{p_symbol:symbol,p_start:options.start,p_end:options.end,p_adjust:adjust}),
    dividends:(symbol,options)=>rpc('market_dividends',{p_symbol:symbol,p_start:options.start,p_end:options.end}),
    dataStatus:symbol=>rpc('market_data_status',{p_symbol:symbol})
  };
}

