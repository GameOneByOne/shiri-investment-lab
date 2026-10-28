import {createWorker} from './worker.mjs';
Deno.serve(createWorker({
  url:Deno.env.get('SUPABASE_URL'),
  key:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  catalog:true,paced:true,maxTasks:10
}));

