// Round the domain to multiples of a readable step so zero is always a tick.
export function chartScale(values){
  const finite=values.filter(Number.isFinite);
  let lo=Math.min(0,...finite),hi=Math.max(0,...finite);
  if(lo===hi){lo=-1;hi=1;}
  const padding=(hi-lo)*.12;
  hi+=padding;
  if(lo<0)lo-=padding;
  const raw=(hi-lo)/4;
  const magnitude=10**Math.floor(Math.log10(raw));
  const step=[1,2,2.5,5,10].find(n=>n>=raw/magnitude)*magnitude;
  const first=Math.floor(lo/step),last=Math.ceil(hi/step);
  const ticks=Array.from({length:last-first+1},(_,i)=>Number(((first+i)*step).toPrecision(12)));
  return {lo:ticks[0],hi:ticks.at(-1),ticks};
}
