const categories=['使用问题','功能建议','其他反馈'];
export function feedbackPayload(input){
  const content=String(input.content??'').trim(),contact=String(input.contact??'').trim();
  if(!categories.includes(input.category))throw Error('请选择反馈类型。');
  if(!content||content.length>2000)throw Error('请填写 1～2000 字的反馈内容。');
  if(contact.length>120)throw Error('联系方式请控制在 120 字以内。');
  if(!['/','/my.html','/progress.html'].includes(input.page_path))throw Error('反馈页面无效，请刷新后重试。');
  if(!/^V\d+\.\d+\.\d+$/.test(input.version))throw Error('版本信息无效，请刷新后重试。');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id))throw Error('提交标识无效，请刷新后重试。');
  return {id:input.id,category:input.category,content,contact:contact||null,page_path:input.page_path,version:input.version};
}
export function createFeedbackApi(config,fetcher=globalThis.fetch){
  return async input=>{
    const payload=feedbackPayload(input);
    if(!config.url||!config.key)throw Error('反馈服务暂未配置，请稍后再试。');
    let response;
    try{
      response=await fetcher(`${config.url}/rest/v1/feedback`,{method:'POST',headers:{apikey:config.key,'Content-Type':'application/json',Prefer:'return=minimal'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
    }catch{throw Error('暂时无法连接，内容已保留，请重试。');}
    if(response.ok)return;
    const error=await response.json().catch(()=>({}));
    // The same UUID is retained on retry, preventing duplicate feedback after an uncertain response.
    if(response.status===409&&error.code==='23505')return;
    if(error.code==='P0001')throw Error('反馈提交较多，请稍后再试。');
    throw Error('提交未完成，内容已保留，请稍后重试。');
  };
}
