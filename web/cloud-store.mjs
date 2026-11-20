import config from './config.mjs';
import {equal,mergePortfolio,choosePortfolio} from './sync-model.mjs';
import {project} from './projection.mjs';
import {currentMarketDate} from './dates.mjs';

export const GUEST_KEY='shiri.personal-plan.v1';
const prefix='shiri.cloud.portfolio.v1.';
const clone=x=>structuredClone(x);
export class PortfolioStore extends EventTarget{
  constructor(){super();this.user=null;this.state='local';this.envelope=null;this.busy=false;this.epoch=0;this.timer=null;this.lastSynced=null;this.external=[];}
  emit(){this.dispatchEvent(new Event('change'));}
  persist(){localStorage.setItem(prefix+this.user.id,JSON.stringify(this.envelope));}
  validate(data){project(data.plan,data.records,currentMarketDate());return data;}
  async init(){
    try{
      const {createClient}=await import('/vendor/supabase.mjs');
      this.client=createClient(config.url,config.key,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true},
        global:{fetch:(url,options={})=>fetch(url,{...options,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)})}
      });
      const {data,error}=await this.client.auth.getSession();if(error)throw error;
      this.switchUser(data.session?.user||null);
      this.client.auth.onAuthStateChange((_event,session)=>{
        // Supabase auth callbacks must not await another auth operation.
        setTimeout(()=>{if(this.user?.id!==session?.user?.id)this.switchUser(session?.user||null);},0);
      });
      window.addEventListener('online',()=>this.sync());
      document.addEventListener('visibilitychange',()=>{if(!document.hidden)this.sync();});
      window.addEventListener('storage',e=>{
        if(this.user&&e.key===prefix+this.user.id&&e.newValue){
          try{this.receive(JSON.parse(e.newValue));}catch{this.state='error';this.emit();}
        }
      });
    }catch(error){this.error=error;this.state='unavailable';this.emit();}
  }
  receive(envelope){
    this.validate(envelope.data);
    if(envelope.base)this.validate(envelope.base);
    // A successful read changes only syncedAt. Do not bounce that acknowledgement
    // between tabs and continuously start another read on both sides.
    if(this.envelope&&equal(envelope.data,this.envelope.data)&&envelope.revision<=this.envelope.revision)return Promise.resolve();
    if(!this.envelope){this.envelope=envelope;this.emit();}
    else if(!equal(envelope.data,this.envelope.data))this.external.push(envelope);
    return this.sync();
  }
  loadEnvelope(){
    this.envelope=null;
    try{const raw=JSON.parse(localStorage.getItem(prefix+this.user.id));if(raw){this.validate(raw.data);if(raw.base)this.validate(raw.base);this.envelope=raw;this.lastSynced=raw.syncedAt||null;}}catch{this.state='error';}
  }
  switchUser(user){
    this.epoch++;clearTimeout(this.timer);this.user=user;this.lastSynced=null;this.error=null;
    this.envelope=null;this.external=[];this.state=user?'loading':'local';
    if(user)this.loadEnvelope();
    this.emit();if(user)this.sync();
  }
  read(){
    if(this.user)return this.envelope?.data||null;
    try{const data=JSON.parse(localStorage.getItem(GUEST_KEY));return data?this.validate(data):null;}catch{return null;}
  }
  save(data){
    this.validate(data);
    if(!this.user){localStorage.setItem(GUEST_KEY,JSON.stringify(data));this.emit();return;}
    if(!this.envelope)throw Error('正在读取云端数据，请稍后再保存。');
    this.envelope={...this.envelope,data:clone(data),dirty:true};this.persist();
    this.state='pending';this.emit();clearTimeout(this.timer);this.timer=setTimeout(()=>this.sync(),700);
  }
  async requestChoice(detail){
    if(!this.choose)throw Error('请打开“我的”完成首次导入或处理同步冲突。');
    return this.choose(detail);
  }
  async sync(){
    if(!this.user||!this.client)return;
    if(this.busy){this.again=true;return;}
    if(!navigator.onLine){this.state='offline';this.emit();return;}
    this.busy=true;this.again=false;
    const epoch=this.epoch,user=this.user;
    const active=()=>this.epoch===epoch;
    try{
      this.state='syncing';this.emit();
      for(let attempt=0;attempt<4;attempt++){
        while(this.external.length){
          const external=this.external[0],original=clone(this.envelope.data);
          const merged=mergePortfolio(this.envelope.base,original,external.data);
          if(merged.conflicts.length){
            this.state='conflict';this.emit();
            const choice=await this.requestChoice({type:'conflict',local:original,cloud:external.data,conflicts:merged.conflicts});
            if(!active())return;
            if(choice==='cancel'){this.state='conflict';return;}
            if(!equal(original,this.envelope.data))continue;
            merged.data=choosePortfolio(this.envelope.base,original,external.data,choice);
          }
          this.validate(merged.data);this.envelope.data=merged.data;this.envelope.dirty=true;this.external.shift();this.persist();this.emit();
        }
        const {data:cloud,error}=await this.client.from('user_portfolios').select('data,revision,updated_at').eq('user_id',user.id).maybeSingle();
        if(error)throw error;if(!active())return;
        if(cloud)this.validate(cloud.data);
        if(!this.envelope){
          let guest=null;try{guest=JSON.parse(localStorage.getItem(GUEST_KEY));if(guest)this.validate(guest);}catch{guest=null;}
          let chosen=cloud?.data||null;
          if(guest){
            this.state='import';this.emit();
            const choice=await this.requestChoice({type:'import',local:guest,cloud:cloud?.data||null});
            if(!active())return;
            if(choice==='cancel'){this.state='import';return;}
            if(choice==='local')chosen=guest;
            if(choice==='merge'&&cloud)chosen=choosePortfolio(null,guest,cloud.data,'local');
          }
          if(!chosen){this.state='empty';this.emit();return;}
          this.validate(chosen);
          this.envelope={data:clone(chosen),base:cloud?.data||null,revision:cloud?.revision||0,dirty:!equal(chosen,cloud?.data)};
          this.persist();this.emit();
        }
        const original=clone(this.envelope.data);
        let merged=mergePortfolio(this.envelope.base,original,cloud?.data||null);
        if(merged.conflicts.length){
          this.state='conflict';this.emit();
          const choice=await this.requestChoice({type:'conflict',local:original,cloud:cloud?.data,conflicts:merged.conflicts});
          if(!active())return;
          if(choice==='cancel'){this.state='conflict';return;}
          if(!equal(original,this.envelope.data))continue;
          merged.data=choosePortfolio(this.envelope.base,original,cloud.data,choice);
        }
        try{this.validate(merged.data);}catch(error){
          if(!cloud)throw error;
          this.state='conflict';this.emit();
          const choice=await this.requestChoice({type:'incompatible',local:original,cloud:cloud.data});
          if(!active())return;
          if(choice==='cancel'){this.state='conflict';return;}
          if(!equal(original,this.envelope.data))continue;
          merged.data=choice==='cloud'?cloud.data:original;this.validate(merged.data);
        }
        if(equal(merged.data,cloud?.data)){
          this.envelope={data:clone(merged.data),base:clone(merged.data),revision:cloud.revision,dirty:false,syncedAt:new Date().toISOString()};
        }else{
          const {data:written,error:writeError}=await this.client.rpc('save_user_portfolio',{expected_revision:cloud?.revision||0,payload:merged.data});
          if(writeError)throw writeError;if(!active())return;
          if(!written?.length)continue; // Another device won the compare-and-swap.
          const latest=this.envelope.data;
          const rebased=mergePortfolio(original,latest,merged.data);
          this.envelope={data:rebased.data,base:clone(merged.data),revision:written[0].revision,dirty:!equal(rebased.data,merged.data),syncedAt:new Date().toISOString()};
          if(rebased.conflicts.length)this.again=true;
        }
        this.persist();this.lastSynced=this.envelope.syncedAt;this.state=this.envelope.dirty?'pending':'synced';this.emit();
        if(this.envelope.dirty)this.again=true;return;
      }
      throw Error('其他设备正在修改，请稍后重试。');
    }catch(error){if(active()){this.error=error;this.state=navigator.onLine?'error':'offline';this.emit();}}
    finally{this.busy=false;if(active())this.emit();if((this.again&&!['conflict','import'].includes(this.state))||!active()){this.again=false;clearTimeout(this.timer);this.timer=setTimeout(()=>this.sync(),1000);}}
  }
  create(data){
    if(!this.user)return this.save(data);
    if(this.state!=='empty')throw Error('请先完成数据同步。');
    this.validate(data);this.envelope={data:clone(data),base:null,revision:0,dirty:true};this.persist();this.sync();
  }
}
export const portfolioStore=new PortfolioStore();
export const accountReady=typeof window!=='undefined'?portfolioStore.init():Promise.resolve();
