export const firstHistoryDate='2021-01-01';
const calendar=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function currentMarketDate(now=new Date()){
  const parts=Object.fromEntries(calendar.formatToParts(now).map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function validateDateRange(start,end,now=new Date()){
  if(!start||!end||start>end)throw new Error('开始日期需要早于或等于结束日期。');
  if(start<firstHistoryDate||end<firstHistoryDate)throw new Error('日期最早只能选择 2021 年 1 月 1 日。');
  if(start>currentMarketDate(now)||end>currentMarketDate(now))throw new Error('日期最晚只能选择今天。');
}
