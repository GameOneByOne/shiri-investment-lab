import {getLanguage} from './i18n.mjs?v=auth-unified-v1';
const themes=[['ink','暖白墨蓝','Ivory & Ink'],['blue','冷白深蓝','White & Blue'],['night','深色琥珀','Dark Amber'],['green','经典绿色','Classic Green']];
const key='shiri.ui.theme';
let selected='ink';
try{const saved=localStorage.getItem(key);if(themes.some(([id])=>id===saved))selected=saved;}catch{}
function apply(value){document.documentElement.dataset.theme=value;try{localStorage.setItem(key,value);}catch{}}
apply(selected);
const header=document.querySelector('.site-header');
if(header){
 const settings=document.createElement('div');settings.className='display-settings';
 const language=header.querySelector('.language-switcher');if(language)settings.append(language);
 const label=document.createElement('label');label.className='theme-picker';label.setAttribute('data-i18n-skip','');
 const caption=document.createElement('span'),select=document.createElement('select');select.id='theme-choice';
 for(const [id]of themes){const option=document.createElement('option');option.value=id;select.append(option);}
 function translate(){const en=getLanguage()==='en';caption.textContent=en?'Theme':'主题';select.setAttribute('aria-label',en?'Theme':'主题');for(let i=0;i<themes.length;i++)select.options[i].textContent=themes[i][en?2:1];}
 select.value=selected;select.addEventListener('change',()=>apply(select.value));label.append(caption,select);settings.append(label);header.append(settings);translate();
 window.addEventListener('shiri:language',translate);
 window.addEventListener('storage',event=>{if(event.key===key&&themes.some(([id])=>id===event.newValue)){select.value=event.newValue;document.documentElement.dataset.theme=event.newValue;}});
}
