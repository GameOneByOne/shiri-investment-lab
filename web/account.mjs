import {portfolioStore as store,accountReady} from './cloud-store.mjs';
import {t} from './i18n.mjs?v=auth-unified-v1';

const el=(tag,attrs={},text)=>{const node=document.createElement(tag);for(const [k,v]of Object.entries(attrs))node.setAttribute(k,v);if(text)node.textContent=text;return node;};
const header=document.querySelector('.site-header');
const root=el('div',{class:'account-menu'}),avatar=el('button',{type:'button',class:'account-avatar','aria-label':'账号与云同步','aria-expanded':'false','aria-controls':'account-popover'});
avatar.innerHTML='<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><circle cx="16" cy="11" r="5" fill="currentColor"/><path d="M6 27v-4c0-6 20-6 20 0v4" fill="currentColor"/></svg>';
const popover=el('div',{id:'account-popover',class:'account-popover'});
root.append(avatar,popover);header.append(root);
avatar.addEventListener('click',()=>{const open=root.classList.toggle('is-open');avatar.setAttribute('aria-expanded',String(open));});
root.addEventListener('mouseenter',()=>{root.classList.remove('is-dismissed');avatar.setAttribute('aria-expanded','true');});
root.addEventListener('focusin',()=>{root.classList.remove('is-dismissed');avatar.setAttribute('aria-expanded','true');});
root.addEventListener('mouseleave',()=>{if(!root.classList.contains('is-open'))avatar.setAttribute('aria-expanded','false');});
root.addEventListener('keydown',e=>{if(e.key==='Escape'){root.classList.remove('is-open');avatar.focus();root.classList.add('is-dismissed');avatar.setAttribute('aria-expanded','false');}});
root.addEventListener('focusout',()=>{queueMicrotask(()=>{if(!root.contains(document.activeElement)&&!root.matches(':hover'))avatar.setAttribute('aria-expanded','false');});});
document.addEventListener('pointerdown',e=>{if(!root.contains(e.target)){root.classList.remove('is-open');root.classList.add('is-dismissed');avatar.setAttribute('aria-expanded','false');}});
const dialog=el('dialog',{class:'account-dialog','aria-labelledby':'account-title'});document.body.append(dialog);
let pendingResolve=null;
dialog.addEventListener('cancel',()=>{pendingResolve?.('cancel');pendingResolve=null;});
dialog.addEventListener('close',()=>{pendingResolve?.('cancel');pendingResolve=null;});
function close(){dialog.close();}
function button(label,fn,className=''){const b=el('button',{type:'button',class:className},t(label));b.addEventListener('click',fn);return b;}
function dialogShell(title){
  dialog.replaceChildren();dialog.append(button('关闭',close,'account-close'));
  dialog.append(el('h2',{id:'account-title'},t(title)));
}
const states={local:'仅保存在当前浏览器',loading:'正在读取云端数据',syncing:'同步中…',synced:'已同步到云端',pending:'更改等待同步',offline:'离线，联网后继续同步',error:'同步失败，请重试',import:'待确认本地数据导入',conflict:'有同步冲突待处理',empty:'尚无云端计划',unavailable:'云同步暂不可用'};
export const syncLabel=()=>t(states[store.state]||states.error);
function download(){
  const data=store.read();if(!data)return;
  let previous=null;try{previous=JSON.parse(localStorage.getItem('shiri.cloud.backup.'+store.user?.id));}catch{}
  const url=URL.createObjectURL(new Blob([JSON.stringify({format:'shiri-portfolio-v1',exportedAt:new Date().toISOString(),data,previous},null,2)],{type:'application/json'}));
  const a=el('a',{href:url,download:'shiri-portfolio-'+new Date().toISOString().slice(0,10)+'.json'});a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function authError(error){
  if(['email_address_not_authorized','over_email_send_rate_limit'].includes(error.code))return t('邮件服务尚未配置完成或发送受限，请稍后再试。');
  if(error.code==='otp_expired')return t('验证码已失效，请重新获取。');
  if(error.status===429)return t('操作过于频繁，请稍后再试。');
  return t('操作失败，请检查网络、邮箱或验证码后重试。');
}
let sentEmail='',resendAt=0;
async function auth(){
  await accountReady;
  if(!store.client){dialogShell('云同步暂不可用');dialog.append(el('p',{},t('请检查网络后刷新页面。')));dialog.showModal();return;}
  sentEmail='';
  dialogShell('注册/登陆');
  const intro=el('p',{},t('使用邮箱验证码继续，未注册的邮箱将在验证后自动创建账号。'));
  const form=el('form'),label=el('label',{for:'account-email'},t('邮箱')),email=el('input',{id:'account-email',type:'email',autocomplete:'email',required:'',placeholder:'name@example.com'});
  const send=el('button',{type:'submit'},t('获取验证码'));
  const codeLabel=el('label',{for:'account-code'},t('邮箱验证码')),code=el('input',{id:'account-code',type:'text',inputmode:'numeric',autocomplete:'one-time-code',pattern:'[0-9]{6,10}',minlength:'6',maxlength:'10'});
  const verify=button('验证并继续',async()=>{
    if(!code.reportValidity()||!code.value)return;
    verify.disabled=true;
    try{const {error}=await store.client.auth.verifyOtp({email:sentEmail,token:code.value,type:'email'});if(error)throw error;close();}
    catch(error){status.textContent=authError(error);}finally{verify.disabled=false;}
  });
  const codeGroup=el('div',{class:'account-code-group'});codeGroup.hidden=true;codeGroup.append(codeLabel,code,verify);
  const status=el('p',{class:'account-message',role:'status','aria-live':'polite'});
  code.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();verify.click();}});
  form.append(label,email,send,status);
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(!email.reportValidity())return;
    if(Date.now()<resendAt){status.textContent=t('请等待一分钟后再次获取验证码。');return;}
    send.disabled=true;
    try{
      const {error}=await store.client.auth.signInWithOtp({email:email.value.trim(),options:{shouldCreateUser:true,emailRedirectTo:location.origin+'/my.html'}});
      if(error)throw error;
      sentEmail=email.value.trim();resendAt=Date.now()+60000;email.readOnly=true;
      codeGroup.hidden=false;code.required=true;send.textContent=t('重新发送验证码');
      status.textContent=t('请查看邮箱中的验证码；如果收到登录链接，也可以点击链接继续。');code.focus();
    }catch(error){status.textContent=authError(error);}finally{send.disabled=false;}
  });
  dialog.append(intro,form,codeGroup);
  dialog.showModal();email.focus();
}
async function logout(){
  if(store.envelope?.dirty){
    dialogShell('尚有未同步的更改');dialog.append(el('p',{},t('请先同步，或导出备份后退出。退出会清除此账号在本机的缓存。')));
    dialog.append(button('立即同步',()=>{close();store.sync();}),button('导出备份并退出',async()=>{download();close();await doLogout();}));dialog.showModal();return;
  }
  await doLogout();
}
async function doLogout(){
  const id=store.user?.id;
  const {error}=await store.client.auth.signOut({scope:'local'});
  if(error){dialogShell('退出失败');dialog.append(el('p',{},t('请检查网络后重试。')));dialog.showModal();return;}
  if(id){localStorage.removeItem('shiri.cloud.portfolio.v1.'+id);localStorage.removeItem('shiri.cloud.backup.'+id);}
  store.switchUser(null);
}
let shownUser=store.user?.id;
function render(){
  if(shownUser!==store.user?.id){if(dialog.open)close();shownUser=store.user?.id;}
  popover.replaceChildren();avatar.classList.toggle('is-authenticated',!!store.user);
  if(!store.user){
    popover.append(button('注册/登陆',()=>auth()));
    return;
  }
  popover.append(el('strong',{class:'account-email','data-i18n-skip':''},store.user.email||''));
  popover.append(el('p',{role:'status','aria-live':'polite'},syncLabel()));
  if(store.lastSynced)popover.append(el('small',{},t('上次同步')+' '+new Date(store.lastSynced).toLocaleString()));
  const sync=button('立即同步',()=>store.sync());sync.disabled=store.busy;popover.append(sync);
  if(!store.choose){const a=el('a',{href:'/my.html'},t('前往我的，管理同步数据'));popover.append(a);}
  else popover.append(button('导出备份',download),button('导入备份',importBackup));
  popover.append(button('退出登录',logout));
}
function importBackup(){
  const input=el('input',{type:'file',accept:'.json,application/json'});
  input.addEventListener('change',async()=>{
    try{
      if(!input.files[0]||input.files[0].size>1048576)throw Error('size');
      const raw=JSON.parse(await input.files[0].text()),data=raw.data||raw;store.validate(data);
      const choice=await choose({type:'restore',local:data,cloud:store.read()});
      if(choice==='local'){if(store.state==='empty')store.create(data);else store.save(data);}
    }catch{dialogShell('无法导入备份');dialog.append(el('p',{},t('请检查备份格式及记录日期。')));dialog.showModal();}
  });input.click();
}
function summary(data){
  if(!data)return t('无已保存的计划');
  const p=data.plan;
  return [p.start+' / '+p.years+' '+t('年'),t('初始资产')+': '+p.initial,t('每次投入')+': '+p.amount+' / '+t(p.frequency==='monthly'?'每月':p.frequency==='daily'?'每天':'每年'),t('预期收益率')+': '+p.rate+'% / '+t(p.rateUnit==='yearly'?'每年':p.rateUnit==='monthly'?'每月':'每天'),t('实际记录')+': '+data.records.length].join('\n');
}
async function choose(detail){
  if(dialog.open)return 'cancel';
  dialogShell(detail.type==='conflict'||detail.type==='incompatible'?'处理同步冲突':detail.type==='restore'?'导入备份':'导入本机数据');
  dialog.append(el('p',{},t(detail.type==='incompatible'?'合并后的计划与记录日期不兼容，请选择完整保留哪一份。两份原始数据会保留在备份中。':detail.type==='conflict'?'两台设备修改了相同内容，请选择冲突部分保留哪一份。其他记录仍会合并。':'确认后再将数据加入账号，游客数据仍保留在本机。')));
  const grid=el('div',{class:'account-compare'});
  for(const [label,data]of [['本机数据',detail.local],['云端数据',detail.cloud]]){const card=el('div');card.append(el('h3',{},t(label)),el('pre',{},summary(data)));grid.append(card);}dialog.append(grid);
  if(detail.conflicts){
    dialog.append(el('p',{},t('冲突项目')+': '+detail.conflicts.map(x=>x==='plan'?t('投资目标'):x).join(', ')));
    for(const key of detail.conflicts){
      const details=el('details'),title=el('summary',{},key==='plan'?t('投资目标'):key);
      const value=data=>key==='plan'?data.plan:data.records.find(r=>r.date===key)||null;
      details.append(title,el('pre',{},t('本机数据')+'\n'+JSON.stringify(value(detail.local),null,2)+'\n'+t('云端数据')+'\n'+JSON.stringify(value(detail.cloud),null,2)));dialog.append(details);
    }
  }
  return new Promise(resolve=>{
    pendingResolve=resolve;
    const finish=value=>{
      if(value!=='cancel'&&store.user)localStorage.setItem('shiri.cloud.backup.'+store.user.id,JSON.stringify({local:detail.local,cloud:detail.cloud,createdAt:new Date().toISOString()}));
      pendingResolve=null;resolve(value);close();
    };
    if(detail.cloud&&detail.type!=='restore')dialog.append(button(detail.type==='conflict'?'冲突保留云端':'使用云端数据',()=>finish('cloud')));
    dialog.append(button(detail.type==='conflict'?'冲突保留本机':detail.type==='restore'?'使用此备份':'导入本机数据',()=>finish('local')));
    if(detail.type==='import'&&detail.cloud)dialog.append(button('合并，冲突保留本机',()=>finish('merge')));
    dialog.append(button('暂不处理',()=>finish('cancel')));dialog.showModal();
  });
}
if(document.querySelector('#projection-form'))store.choose=choose;
store.addEventListener('change',render);window.addEventListener('shiri:language',render);render();
