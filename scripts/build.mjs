import {cp, mkdir, writeFile, readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));

export async function build(env=process.env, output=resolve('dist')) {
  const url=env.PUBLIC_SUPABASE_URL, key=env.PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if(!url || !key) throw new Error('请配置 PUBLIC_SUPABASE_URL 和 PUBLIC_SUPABASE_PUBLISHABLE_KEY。');
  if(new URL(url).protocol!=='https:') throw new Error('Supabase URL 必须使用 HTTPS。');
  if(!key.startsWith('sb_publishable_')) throw new Error('前端只能使用 sb_publishable_ 公钥，禁止使用服务端密钥。');
  await mkdir(output,{recursive:true});
  await cp(new URL('../web/',import.meta.url),output,{recursive:true});
  await writeFile(resolve(output,'config.mjs'),`export default ${JSON.stringify({url:url.replace(/\/$/,''),key,version})};\n`);
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) await build();
