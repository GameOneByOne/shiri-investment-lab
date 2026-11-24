export const DAY=86400000;

// Keep the time under the pointer fixed, then clamp the window to its bounds.
export function zoomTimeRange(view,bounds,fraction,delta){
  const total=bounds.end-bounds.start;
  if(total<=0)return {...bounds};
  const anchor=Math.max(0,Math.min(1,fraction));
  const span=view.end-view.start;
  const nextSpan=Math.max(Math.min(7*DAY,total),Math.min(total,span*Math.exp(delta)));
  if(nextSpan===total)return {...bounds};
  const time=view.start+span*anchor;
  const start=Math.max(bounds.start,Math.min(bounds.end-nextSpan,time-nextSpan*anchor));
  return {start,end:start+nextSpan};
}

export function zoomChartView(timeView,valueView,bounds,fraction,delta){
  const time=zoomTimeRange(timeView,bounds,fraction,delta);
  const restored=delta>0&&time.start===bounds.start&&time.end===bounds.end;
  return {time,values:restored?null:valueView};
}
