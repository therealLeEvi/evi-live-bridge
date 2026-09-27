'use strict';
(async()=>{const {performanceReport}=await import('/performance-core.mjs');const el=id=>document.getElementById(id),esc=escapeHtml;
async function refresh(){el('performanceRefresh').disabled=true;try{
 const response=await fetch('/api/state',{signal:AbortSignal.timeout(5000)});if(!response.ok)throw Error('Unlock or reconnect the bridge.');const state=await response.json();
 const excluded=new Set([...(state.removedFlips||[]),...state.flips].map(f=>'runelite:'+f.id));
 const records=[...(rawHistoryRows||[]),...extraRows].filter(r=>!excluded.has(r.fp));
 records.push(...state.flips.map(f=>({fp:'runelite:'+f.id,item:f.item,profit:f.profit,hold:f.hold})));
 const report=performanceReport(records),count=report.items.reduce((n,g)=>n+g.trades,0),profit=report.items.reduce((n,g)=>n+g.profit,0);
 el('performanceStatus').textContent=count+' detailed trades · Net profit: '+gpExact(profit)+' GP · '+report.unknownHold+' missing holding times. '+(!rawHistoryRows?'The embedded summary history has no individual trade records and is excluded. Import its original log to include it. ':'')+(report.invalid?report.invalid+' invalid records excluded.':'');
 const rows=groups=>groups.map(g=>`<tr><td>${esc(g.name)}</td><td>${g.trades}</td><td>${gpExact(g.profit)}</td><td>${(100*g.wins/g.trades).toFixed(1)}%</td><td>${g.losses}</td><td>${g.breakEven}</td><td>${g.trades<10?'Small sample':'Historical results'}</td></tr>`).join('');
 el('performanceItems').innerHTML=rows(report.items)||'<tr><td colspan="7">No detailed trades yet.</td></tr>';el('performancePeriods').innerHTML=rows(report.periods);
 }catch(e){el('performanceStatus').textContent='Report unavailable: '+e.message;el('performanceItems').innerHTML='';el('performancePeriods').innerHTML='';}finally{el('performanceRefresh').disabled=false;}}
 el('performanceRefresh').onclick=refresh;
})().catch(e=>{document.getElementById('performanceStatus').textContent=e.message;});
