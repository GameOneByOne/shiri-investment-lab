import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

for(const page of ['index.html','my.html']){
 test(`${page} applies the saved theme before styles, modules or body can render`,async()=>{
  const html=await readFile(new URL('../web/'+page,import.meta.url),'utf8');
  const match=html.match(/<script id="theme-init">([\s\S]*?)<\/script>/);
  assert.ok(match);
  assert.ok(match.index<html.indexOf('rel="stylesheet"'));
  assert.ok(match.index<html.indexOf('type="module"'));
  assert.ok(match.index<html.indexOf('<body'));
  for(const saved of ['ink','blue','night','green',null,'invalid']){
   let applied;
   runInNewContext(match[1],{localStorage:{getItem:()=>saved},document:{documentElement:{setAttribute:(key,value)=>{assert.equal(key,'data-theme');applied=value;}}}});
   assert.equal(applied,['ink','blue','night','green'].includes(saved)?saved:'ink');
  }
  let fallback;
  runInNewContext(match[1],{localStorage:{getItem:()=>{throw Error('Storage disabled');}},document:{documentElement:{setAttribute:(_key,value)=>{fallback=value;}}}});
  assert.equal(fallback,'ink');
  assert.match(html,/html\[data-theme="night"\]\{background:#141c29;color-scheme:dark\}/);
 });
}
