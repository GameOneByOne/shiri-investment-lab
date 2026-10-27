import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from '../scripts/build.mjs';

test('build emits only explicit public configuration and rejects secret keys',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'shiri-build-'));
  try{
    const env={PUBLIC_SUPABASE_URL:'https://example.supabase.co',PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_SECRET_KEY:'sb_secret_never_ship'};
    await build(env,dir);
    const config=await readFile(join(dir,'config.mjs'),'utf8');
    assert.ok(config.includes('sb_publishable_test'));
    assert.ok(!config.includes('sb_secret_never_ship'));
    await assert.rejects(build({...env,PUBLIC_SUPABASE_PUBLISHABLE_KEY:'sb_secret_wrong'},dir),/禁止/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
