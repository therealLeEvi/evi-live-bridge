export function performanceReport(records){
 const items=new Map(),periods=new Map(),seen=new Set();let unknownHold=0,invalid=0,duplicates=0;
 const add=(map,key,r)=>{let g=map.get(key);if(!g){g={name:key,trades:0,profit:0,wins:0,losses:0,breakEven:0};map.set(key,g);}g.trades++;g.profit+=r.profit;if(r.profit>0)g.wins++;else if(r.profit<0)g.losses++;else g.breakEven++;};
 for(const r of records){if(!r||typeof r.item!=='string'||!Number.isSafeInteger(r.profit)){invalid++;continue;}if(r.fp&&seen.has(r.fp)){duplicates++;continue;}if(r.fp)seen.add(r.fp);add(items,r.item,r);const h=r.hold;const bucket=typeof h!=='number'||!Number.isFinite(h)||h<0?'Unknown':h<=1/12?'Up to 5 minutes':h<=1?'5 minutes–1 hour':h<=6?'1–6 hours':h<=12?'6–12 hours':h<=24?'12–24 hours':'Over 1 day';if(bucket==='Unknown')unknownHold++;add(periods,bucket,r);}
 return {items:[...items.values()].sort((a,b)=>b.profit-a.profit),periods:[...periods.values()],unknownHold,invalid,duplicates};
}
