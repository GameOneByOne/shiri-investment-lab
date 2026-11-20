// Three-way merge against the last acknowledged server snapshot. Dates are the
// existing record identity; absence is a deletion, including after offline edits.
// PostgreSQL jsonb reorders object keys; property order is not a data change.
export function equal(a,b){
  if(a===b)return true;
  if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
  if(Array.isArray(a)!==Array.isArray(b))return false;
  const ak=Object.keys(a).sort(),bk=Object.keys(b).sort();
  return ak.length===bk.length&&ak.every((key,i)=>key===bk[i]&&equal(a[key],b[key]));
}
export function mergePortfolio(base,local,remote){
  const conflicts=[];
  function choose(key,b,l,r){
    if(equal(l,r))return l;
    if(equal(l,b))return r;
    if(equal(r,b))return l;
    conflicts.push(key);return l;
  }
  const plan=choose('plan',base?.plan,local?.plan,remote?.plan);
  const maps=[base,local,remote].map(x=>new Map((x?.records||[]).map(r=>[r.date,r])));
  const records=[...new Set(maps.flatMap(m=>[...m.keys()]))].sort().map(date=>choose(date,...maps.map(m=>m.get(date)))).filter(Boolean);
  return {data:{plan,records},conflicts};
}
export function choosePortfolio(base,local,remote,choice){
  const merged=mergePortfolio(base,local,remote);
  if(choice==='cloud'){
    if(merged.conflicts.includes('plan'))merged.data.plan=remote.plan;
    const cloud=new Map(remote.records.map(r=>[r.date,r]));
    for(const date of merged.conflicts.filter(k=>k!=='plan')){
      merged.data.records=merged.data.records.filter(r=>r.date!==date);
      if(cloud.has(date))merged.data.records.push(cloud.get(date));
    }
    merged.data.records.sort((a,b)=>a.date.localeCompare(b.date));
  }
  return merged.data;
}
