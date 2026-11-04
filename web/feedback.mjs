import config from './config.mjs';
import {createFeedbackApi} from './feedback-api.mjs';
const send=createFeedbackApi(config),version='V'+config.version;
const host=document.createElement('div');
host.innerHTML=`<button class="feedback-launch" type="button" aria-haspopup="dialog">意见反馈 <span aria-hidden="true">↗</span></button>
<dialog class="feedback-dialog" aria-labelledby="feedback-title" aria-describedby="feedback-intro">
 <button class="feedback-close" type="button" aria-label="关闭意见反馈">×</button>
 <div class="feedback-form-view"><h2 id="feedback-title">你的想法，我们想听。</h2>
 <p id="feedback-intro" class="feedback-intro">哪里不顺手，或是还想看到什么？欢迎告诉我们。</p>
 <form class="feedback-form">
  <label class="feedback-label" for="feedback-content">反馈内容 <span class="feedback-count">0 / 2000</span></label>
  <textarea id="feedback-content" name="content" rows="5" maxlength="2000" required placeholder="例如：在哪个页面遇到了什么问题，或希望增加什么功能……"></textarea>
  <div hidden><label>请留空<input name="website" tabindex="-1" autocomplete="off"></label></div>
  <p class="feedback-privacy">反馈仅供管理员查看；提交时会附带当前页面和版本号，不会读取你的投资计划。</p>
  <p class="feedback-error" role="alert"></p>
  <button class="feedback-submit" type="submit">提交反馈 <span aria-hidden="true">↗</span></button>
 </form></div>
 <div class="feedback-success" hidden role="status"><span class="feedback-check" aria-hidden="true">✓</span><h2 id="feedback-success-title">已收到，谢谢你。</h2><p>感谢帮我们完善拾日。每一条反馈，我们都会认真查看。</p><button class="feedback-done" type="button">好的</button></div>
</dialog>`;
document.body.append(host);
const $=selector=>host.querySelector(selector),dialog=$('dialog'),form=$('form'),submit=$('.feedback-submit');
let pending=false,requestId=null,requestBody=null,lastSentAt=0;
$('.feedback-launch').addEventListener('click',()=>{dialog.showModal();if(!$('.feedback-form-view').hidden)$('#feedback-content').focus();});
$('.feedback-close').addEventListener('click',()=>dialog.close());$('.feedback-done').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();});
$('#feedback-content').addEventListener('input',()=>{$('.feedback-count').textContent=$('#feedback-content').value.length+' / 2000';});
form.addEventListener('submit',async e=>{
 e.preventDefault();if(pending)return;
 const error=$('.feedback-error');error.textContent='';
 if(Date.now()-lastSentAt<60000){error.textContent='刚刚已经收到你的反馈，稍等片刻再提交吧。';return;}
 const data=new FormData(form);if(data.get('website'))return;
 const fields={category:'其他反馈',content:data.get('content'),contact:null,page_path:location.pathname,version};
 const body=JSON.stringify(fields);if(body!==requestBody){requestId=crypto.randomUUID();requestBody=body;}
 pending=true;submit.disabled=true;submit.textContent='正在提交…';
 try{
  await send({id:requestId,...fields});lastSentAt=Date.now();
  form.reset();$('.feedback-count').textContent='0 / 2000';requestId=null;requestBody=null;
  $('.feedback-form-view').hidden=true;$('.feedback-success').hidden=false;dialog.setAttribute('aria-labelledby','feedback-success-title');dialog.removeAttribute('aria-describedby');$('.feedback-done').focus();
 }catch(reason){error.textContent=reason.message;}
 finally{pending=false;submit.disabled=false;submit.innerHTML='提交反馈 <span aria-hidden="true">↗</span>';}
});
dialog.addEventListener('close',()=>{if(!pending&&$('.feedback-form-view').hidden){$('.feedback-form-view').hidden=false;$('.feedback-success').hidden=true;dialog.setAttribute('aria-labelledby','feedback-title');dialog.setAttribute('aria-describedby','feedback-intro');}});
