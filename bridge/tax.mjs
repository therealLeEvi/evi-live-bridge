// Current exemptions cross-checked against Flipping Utilities' Hub-pinned source,
// with numeric IDs resolved from RuneLite gameval ItemID. Policy date: 2025-05-29.
const exempt=new Set([1755,5325,2347,1733,13190,233,5341,8794,5329,5343,1735,952,5331,8011,365,2309,882,806,1891,8010,28824,2140,2142,3008,3010,3012,3014,8009,3853,347,884,807,28790,379,8008,355,2327,558,351,2552,329,315,886,808,8013,361,8007]);
export function saleProceeds(o){
  const q=o.filled,gross=o.spent;
  if(!Number.isSafeInteger(q)||q<1||!Number.isSafeInteger(gross)||gross<0)return null;
  // Older offers might use a different tax regime; never silently reinterpret them.
  if(o.firstSeen<Date.UTC(2025,4,30))return null;
  if(exempt.has(o.itemId))return {net:gross,tax:0,exact:true};
  // Sell fills may execute above the offer price. The aggregate counter alone
  // cannot reconstruct rounding for several different execution prices.
  const unit=gross/q,exact=q===1||gross===o.price*q;
  const tax=Math.min(5000000,Math.floor(unit/50))*q;
  return {net:gross-tax,tax,exact};
}
// Estimated per-unit tax for a hypothetical future sale (e.g. a live suggestion), not a
// completed offer. Always an estimate: real fills can land at a different price.
export function estimateUnitTax(itemId,sellPrice){
  if(exempt.has(itemId))return 0;
  if(!Number.isFinite(sellPrice)||sellPrice<=0)return 0;
  return Math.min(5000000,Math.floor(sellPrice/50));
}
