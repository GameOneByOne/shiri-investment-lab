// Fractions are measured in plot widths/heights, independent of pixel density.
export function panTimeRange(view,bounds,fraction){
  const span=view.end-view.start;
  const start=Math.max(bounds.start,Math.min(bounds.end-span,view.start-fraction*span));
  return {start,end:start+span};
}

export function panValueRange(view,fraction){
  const shift=fraction*(view.hi-view.lo);
  return {lo:view.lo+shift,hi:view.hi+shift};
}
