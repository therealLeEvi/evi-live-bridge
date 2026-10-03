'use strict';
(() => {
  const $=id=>document.getElementById(id),esc=escapeHtml,fmt=gpExact;
  let state=null,busy=false,reviewEligible=[];
  const storageKeys=['eviHistory','eviFeedback','eviPredictions','eviPredictionLog','eviOsrsNews','eviRawHistoryRows','eviExtraRows','eviImportedFingerprints','eviPredictionEvaluations'];
  async function api(url,data) {
    const r=await fetch(url,data===undefined?{signal:AbortSignal.timeout(5000)}:{method:'POST',headers:{'Content-Type':'application/json','X-EVI-UI':'1'},body:JSON.stringify(data),signal:AbortSignal.timeout(5000)});
    const j=await r.json();if(!r.ok)throw Error(r.status===404&&url==='/api/flips/removal'?'The running bridge needs updating. Replace bridge/server.mjs and bridge/store.mjs, then close and restart the bridge.':j.error||'Local request failed');return j;
  }
  const time=t=>new Date(t).toLocaleString();
  const account=o=>esc(o.account.slice(0,8));
  const isBuy=o=>['BUYING','BOUGHT','CANCELLED_BUY'].includes(o.state);
  const coverage=o=>o.knownStart?'Observed from zero':'First seen at login';
  // Real average GP per item from the GE's own counters (before tax for sales); never the offer's set price.
  const each=o=>o.filled>0?fmt(Math.round(o.spent/o.filled)):'—';
  // Latest Wiki prices, shared with the Scanner tab's own once-a-minute refresh (`market`).
  function marketNow(itemId){
    const p=typeof market!=='undefined'&&market?.latest?.[itemId];
    if(!p||!(p.low>0||p.high>0))return '<span class="muted">—</span>';
    return `${p.low>0?fmt(p.low):'—'} / ${p.high>0?fmt(p.high):'—'}`;
  }
  function option(o){return `<option value="${esc(o.offerId)}">${esc(o.name)} · ${fmt(o.filled)} × ${each(o)} · ${account(o)} · ${esc(time(o.completedAt))}${o.knownStart?'':' · first seen at login'}</option>`;}
  function entryPrediction(f) {
    const p=predictionLog.filter(p=>String(p.id)===String(f.itemId)&&p.ts<=f.firstBuy&&p.ts>=f.firstBuy-6*3600000).sort((a,b)=>b.ts-a.ts)[0];
    if(!p)return 'No recent pre-entry prediction';
    return ['p1','p6','po'].map((k,i)=>`${['1h','6h','12h'][i]}: ${p[k]?.label||'unknown'}`).join(' · ');
  }
  function renderLive() {
    const deleted=new Set((state.removedFlips||[]).map(f=>'runelite:'+f.id));
    if(extraRows.some(r=>deleted.has(r.fp))||Object.keys(importedFingerprints).some(k=>deleted.has(k))){
      const nextExtra=extraRows.filter(r=>!deleted.has(r.fp)),nextFP={...importedFingerprints};deleted.forEach(k=>delete nextFP[k]);
      const nextHistory=rawHistoryRows?aggregateRows([...rawHistoryRows,...nextExtra.filter(x=>!rawHistoryRows.some(y=>y.fp===x.fp))]):mergeAggregateProfiles(DEFAULT_HISTORY,aggregateRows(nextExtra));
      localStorage.setItem('eviLiveMergeCheckpoint',JSON.stringify({extraRows:nextExtra,importedFingerprints:nextFP,history:nextHistory}));
      for(const [k,v] of [['eviExtraRows',nextExtra],['eviImportedFingerprints',nextFP],['eviHistory',nextHistory]])localStorage.setItem(k,JSON.stringify(v));
      localStorage.removeItem('eviLiveMergeCheckpoint');extraRows=nextExtra;importedFingerprints=nextFP;history=nextHistory;
      if(market)rows=buildRows(market.mapping,market.latest,market.m5,market.h1);render();
    }
    // netProfit/tradeCount are computed bridge-side across BOTH manually reviewed flips and the
    // automatically FIFO-matched ones (see Store.state in bridge/store.mjs), so the headline
    // number no longer waits on the manual "Review a completed flip" step below.
    const allFlips=[...state.flips,...(state.autoFlips||[])],latest=allFlips.slice().sort((a,b)=>b.lastSell-a.lastSell)[0];
    const total=state.netProfit??allFlips.reduce((n,f)=>n+f.profit,0),tradeCount=state.tradeCount??allFlips.length;
    $('liveProfitSummary').textContent=`Saved flips · Net profit after tax: ${total>=0?'+':''}${fmt(total)} GP · ${tradeCount} flips`+(latest?` · Latest: ${latest.item} ${latest.profit>=0?'+':''}${fmt(latest.profit)} GP`:'');
    // What the total above does NOT include, said right beside it (see dataHealthOf in
    // bridge/store.mjs). Without this the headline can read as "EVI loses GP" when part of it is simply
    // trades EVI could not see both halves of. The inventory figure comes from the plugin's own check
    // and says "seen in your inventory", never "the rest are gone": banked stock isn't in the inventory.
    const h=state.dataHealth;
    if(h){
      const s=n=>n===1?'':'s',parts=[];
      if(h.unmatchedSales)parts.push(`${fmt(h.unmatchedSales)} sale${s(h.unmatchedSales)} with no recorded purchase (${fmt(h.unmatchedGross)} GP received)`);
      // Left out on purpose rather than missed: these came from purchases marked as personal use.
      if(h.personalUseSales)parts.push(`${fmt(h.personalUseSales)} sale${s(h.personalUseSales)} of items you marked as personal use (${fmt(h.personalUseGross)} GP received)`);
      if(h.openPositions){
        let held=`${fmt(h.openPositions)} purchase${s(h.openPositions)} not yet sold (${fmt(h.openCost)} GP at cost)`;
        const c=h.inventoryCheck;
        if(c&&c.positions)held+=` — ${fmt(c.seenInInventory)} of ${fmt(c.positions)} seen in your inventory just now; any others are banked, or gone`;
        parts.push(held);
      }
      const healthHtml=parts.length
        ?`Not included in this total: ${parts.join(' · ')}. <a href="#stillHeld">Review what's still held</a>`
        :'Every observed trade is matched and included in this total.';
      if($('liveDataHealth').innerHTML!==healthHtml)$('liveDataHealth').innerHTML=healthHtml;
    }
    const autoFlips=state.autoFlips||[],autoOpen=state.autoOpenPositions||[],autoUnmatched=state.autoUnmatchedSells||[];
    const autoRows=autoFlips.slice().reverse().map(f=>`<tr><td>${account(f)}</td><td>${esc(f.item)}</td><td>${fmt(f.quantity)}</td><td>${fmt(f.capital)}</td><td>${fmt(f.netProceeds)}</td><td class="${f.profit>=0?'good':'bad'}">${fmt(f.profit)}</td><td>${hfmt(f.hold)}</td><td>${f.sellIds.length}</td><td>${f.exact?'Exact':'Estimated'}</td></tr>`).join('');
    if($('liveAutoFlips').innerHTML!==autoRows)$('liveAutoFlips').innerHTML=autoRows||'<tr><td colspan="9">No automatically matched trades yet.</td></tr>';
    const openText=autoOpen.length?`${autoOpen.length} item(s) bought and not yet fully sold (still held or partially sold).`:'';
    const unmatchedText=autoUnmatched.length?`${autoUnmatched.length} sale(s) could not be matched to a known preceding buy (stock held before tracking started, or an unobserved buy) — still visible in Completed buys and sells and the downloadable log, just not counted as profit.`:'';
    $('liveAutoStatus').textContent=[openText,unmatchedText].filter(Boolean).join(' ')||(autoFlips.length?'':'Nothing to match yet.');
    const removedRows=(state.removedFlips||[]).map(f=>`<p>${esc(f.item)} · ${fmt(f.profit)} GP ${f.reopened?'Reopened for correction':`<button data-restore="${esc(f.id)}">Restore saved flip</button> <button data-edit="${esc(f.id)}">Edit / rematch</button>`}</p>`).join('')||'No removed flips.';
    if($('liveRemoved').innerHTML!==removedRows)$('liveRemoved').innerHTML=removedRows;
    renderOwned();
    const live=state.sessions.filter(s=>s.live),inGame=live.filter(s=>s.loggedIn);
    $('liveStatus').textContent=inGame.length?`Bridge connected · RuneLite live · ${inGame.length} session(s) · refreshed ${new Date().toLocaleTimeString()}`:
      live.length?'Bridge connected · RuneLite logged out / changing worlds':'Bridge connected · no fresh RuneLite data. Start and pair the plugin, then log in. Historical records remain below.';
    $('liveOffers').innerHTML=state.active.map(o=>`<tr><td>${account(o)}</td><td>${esc(o.name)}</td><td>${o.slot+1}</td><td>${esc(o.state)}</td><td>${fmt(o.price)}</td><td>${fmt(o.filled)} / ${fmt(o.total)}</td><td>${each(o)}</td><td>${marketNow(o.itemId)}</td><td>${fmt(o.spent)}</td><td>${coverage(o)}</td></tr>`).join('')||'<tr><td colspan="10">No active offers in a fresh session.</td></tr>';
    // A margin check (see isMarginCheck in bridge/store.mjs) is a one-item price probe, not a trade:
    // shown for completeness, labelled, and deliberately absent from every profit figure.
    const completedRows=state.completed.slice(0,500).map(o=>`<tr><td>${account(o)}</td><td>${esc(o.name)}${o.marginCheck?' <span class="muted">(margin check)</span>':''}</td><td>${isBuy(o)?'Buy':'Sell'} · ${esc(o.state)}</td><td>${fmt(o.filled)}</td><td>${each(o)}</td><td>${marketNow(o.itemId)}</td><td>${fmt(o.spent)}</td><td>${esc(time(o.completedAt))}</td><td>${coverage(o)}</td></tr>`).join('')||'<tr><td colspan="9">No completed offers observed yet.</td></tr>';
    if($('liveCompleted').innerHTML!==completedRows)$('liveCompleted').innerHTML=completedRows;
    const openRows=(state.autoOpenPositions||[]).map(p=>`<tr><td>${account(p)}</td><td>${esc(p.item)}</td><td>${fmt(p.remaining)} / ${fmt(p.totalQty)}</td><td>${fmt(Math.round(p.unitCost))}</td><td>${marketNow(p.itemId)}</td><td>${esc(time(p.firstSeen))}</td><td><button data-close="${esc(p.buyId)}" data-reason="used">Used it</button> <button data-close="${esc(p.buyId)}" data-reason="sold-untracked">Sold outside EVI</button></td></tr>`).join('')||'<tr><td colspan="7">Nothing held — every observed purchase has been sold or closed.</td></tr>';
    if($('liveOpenPositions').innerHTML!==openRows)$('liveOpenPositions').innerHTML=openRows;
    const closedRows=(state.closedPositions||[]).map(c=>`<p>${esc(c.item||'Unknown item')} · ${c.reason==='used'?'used':'sold outside EVI'} · closed ${esc(time(c.at))} <button data-reopen-position="${esc(c.buyId)}">Undo</button></p>`).join('')||'No closed positions.';
    if($('liveClosedPositions').innerHTML!==closedRows)$('liveClosedPositions').innerHTML=closedRows;
    const used=new Set([...state.flips,...(state.removedFlips||[])].filter(f=>!f.reopened).flatMap(f=>[f.buyId,...(f.sellIds??[f.sellId])]));
    // Offers first seen at login are included (labelled in the dropdown): their counters are the
    // full totals, and the bridge already links the ones EVI watched start in an earlier session.
    const eligible=state.completed.filter(o=>o.filled>0&&!used.has(o.offerId));
    reviewEligible=eligible;
    const selected=$('liveBuy').value;
    const buyHTML='<option value="">Choose a purchase…</option>'+eligible.filter(isBuy).map(option).join('');
    if($('liveBuy').innerHTML!==buyHTML){$('liveBuy').innerHTML=buyHTML;$('liveBuy').value=selected;}
    matchingSales(false);
    const flipRows=state.flips.slice().reverse().map(f=>`<tr><td>${account(f)}</td><td>${esc(f.item)}</td><td>${fmt(f.quantity)}</td><td>${fmt(f.capital)}</td><td>${fmt(f.netProceeds)}</td><td class="${f.profit>=0?'good':'bad'}">${fmt(f.profit)}</td><td>${hfmt(f.hold)}</td><td>${esc(entryPrediction(f))}</td><td>${importedFingerprints['runelite:'+f.id]?'Merged':'Ready to merge'}</td><td><button data-edit="${esc(f.id)}">Edit / rematch</button> <button data-remove="${esc(f.id)}">Remove</button></td></tr>`).join('');
    if($('liveFlips').innerHTML!==flipRows)$('liveFlips').innerHTML=flipRows;
  }
  async function poll() {
    if(busy)return;busy=true;
    try {state=await api('/api/state');renderLive();}
    catch(e){$('liveStatus').textContent='Bridge disconnected or locked: '+e.message;$('liveOffers').innerHTML='<tr><td colspan="8">Live state unavailable. Reconnect before relying on active offers.</td></tr>';}
    finally{busy=false;}
  }
  $('liveRefresh').onclick=poll;
  async function removal(event,removed){
    const button=event.target.closest(removed?'[data-remove]':'[data-restore]');if(!button)return;
    button.disabled=true;
    try{await api('/api/flips/removal',{id:button.dataset[removed?'remove':'restore'],removed});await poll();$('liveAction').textContent=removed?'Flip removed from totals and this browser’s merged live history. You can restore it below.':'Flip restored. Use Merge to add it back to history.';}
    catch(e){$('liveAction').textContent=e.message;}finally{button.disabled=false;}
  }
  function matchingSales(auto){
    const buy=reviewEligible.find(o=>o.offerId===$('liveBuy').value);
    const sales=reviewEligible.filter(o=>!isBuy(o)&&buy&&o.account===buy.account&&o.itemId===buy.itemId&&o.firstSeen>=buy.completedAt);
    const selected=[...$('liveSell').selectedOptions].map(o=>o.value);
    const markup=sales.map(option).join('');
    if($('liveSell').innerHTML!==markup)$('liveSell').innerHTML=markup;
    for(const o of $('liveSell').options)o.selected=selected.includes(o.value);
    if(auto){for(const o of $('liveSell').options)o.selected=sales.length===1&&sales[0].filled===buy.filled;}
    const qty=sales.filter(o=>[...$('liveSell').selectedOptions].some(x=>x.value===o.offerId)).reduce((n,o)=>n+o.filled,0);
    $('liveMatchHint').textContent=buy?'Selected sales: '+qty+' / '+buy.filled+' items. '+(sales.length===1&&qty===buy.filled?'One matching sale selected; review and save.':'Select matching sales; hold Ctrl for split sales.'):'Choose a purchase to see only its eligible sales.';
  }
  $('liveBuy').onchange=()=>matchingSales(true);
  $('liveSell').onchange=()=>matchingSales(false);
  async function editFlip(event){
    const button=event.target.closest('[data-edit]');if(!button)return false;
    const f=[...state.flips,...(state.removedFlips||[])].find(f=>f.id===button.dataset.edit);
    button.disabled=true;
    try{
      await api('/api/flips/reopen',{id:f.id});
      state=await api('/api/state');renderLive();
      $('liveBuy').value=f.buyId;matchingSales(false);
      for(const o of $('liveSell').options)o.selected=(f.sellIds??[f.sellId]).includes(o.value);
      $('liveNet').value='';matchingSales(false);
      $('liveAction').textContent='Previous version excluded from totals. Review the selected purchase and sales, then save the corrected flip. Proceeds will be recalculated.';
    }catch(e){$('liveAction').textContent=e.message;}finally{button.disabled=false;}
    return true;
  }
  $('liveFlips').onclick=async e=>{if(!await editFlip(e))await removal(e,true);};
  $('liveRemoved').onclick=async e=>{if(!await editFlip(e))await removal(e,false);};
  // Previously a type="number" field: a browser silently turns "1.500.000" or "1,500,000" into an
  // empty/decimal value there, and the check below then reported it as "zero proceeds".
  function netOverride(){
    const raw=$('liveNet').value.trim();
    return raw===''?{blank:true}:parseGpAmount(raw);
  }
  $('liveNet').addEventListener('input',()=>{
    const r=netOverride();
    $('liveNetPreview').textContent=r.blank?'':r.error?r.error:`= ${fmt(r.value)} GP after tax`;
  });
  $('confirmFlip').onclick=async()=>{
    const button=$('confirmFlip');button.disabled=true;
    try {
      const override=netOverride();
      if(override.error)throw Error(override.error+' Leave it blank for automatic calculation, or enter the total GP you received after tax (not the profit).');
      await api('/api/flips',{buyId:$('liveBuy').value,sellIds:[...$('liveSell').selectedOptions].map(o=>o.value).filter(Boolean),...(override.blank?{}:{netProceeds:override.value})});
      $('liveAction').textContent='Reviewed flip saved locally.';$('liveNet').value='';$('liveNetPreview').textContent='';await poll();
    }catch(e){$('liveAction').textContent=e.message;}finally{button.disabled=false;}
  };
  $('liveOpenPositions').onclick=async e=>{
    const button=e.target.closest('[data-close]');if(!button)return;
    const label=button.dataset.reason==='used'?'used in-game':'sold outside EVI';
    if(!confirm(`Mark the rest of this purchase as ${label}? It stops being suggested for selling, and only the part EVI saw sold counts toward profit. You can undo this.`))return;
    button.disabled=true;
    try{await api('/api/positions/close',{buyId:button.dataset.close,reason:button.dataset.reason});await poll();$('liveAction').textContent=`Position closed (${label}).`;}
    catch(err){$('liveAction').textContent=err.message;}finally{button.disabled=false;}
  };
  $('liveClosedPositions').onclick=async e=>{
    const button=e.target.closest('[data-reopen-position]');if(!button)return;
    button.disabled=true;
    try{await api('/api/positions/close',{buyId:button.dataset.reopenPosition,closed:false});await poll();$('liveAction').textContent='Position reopened.';}
    catch(err){$('liveAction').textContent=err.message;}finally{button.disabled=false;}
  };
  $('mergeFlips').onclick=()=>{
    try {
      if(!state)throw Error('Connect to the bridge first.');
      const additions=state.flips.filter(f=>!importedFingerprints['runelite:'+f.id]).map(f=>({fp:'runelite:'+f.id,item:f.item,profit:f.profit,
        capital:f.capital,roi:f.capital?f.profit/f.capital:null,hold:f.hold,win:f.profit>0,loss:f.profit<0}));
      const nextExtra=[...extraRows,...additions], nextFP={...importedFingerprints};additions.forEach(x=>nextFP[x.fp]=1);
      const nextHistory=rawHistoryRows?aggregateRows([...rawHistoryRows,...nextExtra.filter(x=>!rawHistoryRows.some(y=>y.fp===x.fp))]):mergeAggregateProfiles(DEFAULT_HISTORY,aggregateRows(nextExtra));
      // Recovery checkpoint written first. On reload it completes the same idempotent merge.
      localStorage.setItem('eviLiveMergeCheckpoint',JSON.stringify({extraRows:nextExtra,importedFingerprints:nextFP,history:nextHistory}));
      for(const [k,v] of [['eviExtraRows',nextExtra],['eviImportedFingerprints',nextFP],['eviHistory',nextHistory]])localStorage.setItem(k,JSON.stringify(v));
      localStorage.removeItem('eviLiveMergeCheckpoint');extraRows=nextExtra;importedFingerprints=nextFP;history=nextHistory;
      if(market)rows=buildRows(market.mapping,market.latest,market.m5,market.h1);render();renderLive();
      $('liveAction').textContent=`${additions.length} reviewed flip(s) merged. Existing record IDs were skipped.`;
    }catch(e){$('liveAction').textContent='History could not be saved: '+e.message;}
  };
  // Recover a merge interrupted by browser close/storage failure before accepting another import.
  try {
    const pending=JSON.parse(localStorage.getItem('eviLiveMergeCheckpoint')||'null');
    if(pending){for(const [k,v] of [['eviExtraRows',pending.extraRows],['eviImportedFingerprints',pending.importedFingerprints],['eviHistory',pending.history]])localStorage.setItem(k,JSON.stringify(v));extraRows=pending.extraRows;importedFingerprints=pending.importedFingerprints;history=pending.history;localStorage.removeItem('eviLiveMergeCheckpoint');render();}
  }catch(e){$('liveAction').textContent='An interrupted history save needs more browser storage. Back up your data before retrying.';}
  $('csv').addEventListener('change',e=>{
    if(Object.keys(importedFingerprints).some(k=>k.startsWith('runelite:'))&&!confirm('Imported CSV rows cannot reliably be matched to trades EVI tracked live. Continue only if this CSV does not overlap your merged live trades.')){e.stopImmediatePropagation();e.target.value='';}
  },true);
  function download(data,name) {
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  function downloadText(text,name,type,bom) {
    // A UTF-8 BOM where asked for: Excel otherwise reads a plain .csv in a legacy code page, which
    // mangles any item name that is not pure ASCII. Harmless to every other reader.
    const parts=bom?['﻿',text]:[text];
    const url=URL.createObjectURL(new Blob(parts,{type}));
    const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  const CRLF=String.fromCharCode(13)+String.fromCharCode(10);
  function csvCell(v) {return '"'+String(v).replace(/"/g,'""')+'"';}
  function buildTradeLogCSV() {
    if(!state)throw Error('Connect to the bridge first.');
    const header=['Match type','Account','Item','Quantity','Buy cost GP','Net proceeds GP','Profit GP','First buy','Last sell','Hold hours','Confidence','Sales combined','Note'];
    const rows=[header];
    // Eight characters, the same short form the rest of this page uses. The full value is a 64-char
    // account identifier: it is the key every record is stored under, it repeats on every single row,
    // and it pushed the item and the money off the first screen. Eight is still enough to tell two
    // accounts apart, which is the only reason the column exists.
    const shortAccount=a=>String(a==null?'':a).slice(0,8);
    const addFlip=(f,type)=>rows.push([type,shortAccount(f.account),f.item,f.quantity,f.capital,f.netProceeds,f.profit,time(f.firstBuy),time(f.lastSell),f.hold.toFixed(2),(f.exact??true)?'Exact':'Estimated',(f.sellIds??[f.sellId]).length,'']);
    for(const f of state.flips)addFlip(f,'Manually reviewed');
    for(const f of (state.autoFlips||[]))addFlip(f,'Automatic');
    for(const f of (state.removedFlips||[]))if(!f.reopened)addFlip(f,'Removed (excluded from totals)');
    for(const o of (state.autoOpenPositions||[]))rows.push(['Open position',shortAccount(o.account),o.item,o.totalQty,'','','',time(o.firstSeen),'','','','',o.partiallySold?`${o.remaining} of ${o.totalQty} still unsold`:'Not yet sold']);
    for(const o of (state.autoUnmatchedSells||[]))rows.push(['Unmatched sale',shortAccount(o.account),o.name,o.unmatchedQty??o.filled,'','','',time(o.firstSeen),time(o.completedAt),'','','',o.reason||'']);
    // sep=, tells Excel which delimiter to use, whatever the system list separator is. On a Dutch,
    // German, French or Spanish Windows that separator is a SEMICOLON, so without this line every
    // row lands in column A and the export looks broken when it is not. LibreOffice honours it too;
    // pandas wants skiprows=1. Nothing re-imports this file, so the extra line costs no round trip.
    // Do NOT 'fix' this by switching to semicolons: that repairs one locale and breaks every other.
    return 'sep=,' + CRLF + rows.map(r=>r.map(csvCell).join(',')).join(CRLF) + CRLF;
  }
  $('downloadTradeLog').onclick=()=>{
    try{downloadText(buildTradeLogCSV(),`EVI-trade-log-${new Date().toISOString().slice(0,10)}.csv`,'text/csv',true);}
    catch(e){$('liveAction').textContent=e.message;}
  };
  $('exportEvi').onclick=()=>download({format:'evi-browser-backup-1',data:Object.fromEntries(storageKeys.map(k=>[k,loadJSON(k,null)]))},'EVI-browser-backup.json');
  $('restoreEvi').onchange=async e=>{
    try {
      const file=e.target.files[0];if(!file)return;if(file.size>10000000)throw Error('Backup is too large');
      const backup=JSON.parse(await file.text());
      if(backup.format!=='evi-browser-backup-1'||!backup.data||Array.isArray(backup.data))throw Error('Not an EVI backup');
      const dangerous=x=>x&&typeof x==='object'&&Object.entries(x).some(([k,v])=>['__proto__','prototype','constructor'].includes(k)||dangerous(v));
      if(dangerous(backup.data))throw Error('Unsafe backup keys');
      for(const [k,v] of Object.entries(backup.data)) {
        if(!storageKeys.includes(k))throw Error('Unknown backup key');
        if(v!==null && (typeof v!=='object' || (['eviPredictionLog','eviOsrsNews','eviRawHistoryRows','eviExtraRows'].includes(k)!==Array.isArray(v))))throw Error('Invalid backup data type');
      }
      if(!confirm('Restore this EVI backup and replace the browser history, feedback and predictions? Back up the current data first if needed.'))return;
      // Save a rollback backup before touching any keys.
      download({format:'evi-browser-backup-1',data:Object.fromEntries(storageKeys.map(k=>[k,loadJSON(k,null)]))},'EVI-before-restore.json');
      for(const k of storageKeys){if(backup.data[k]==null)localStorage.removeItem(k);else localStorage.setItem(k,JSON.stringify(backup.data[k]));}
      location.reload();
    }catch(error){$('liveAction').textContent='Restore failed: '+error.message;}finally{e.target.value='';}
  };
  $('evaluateEvi').onclick=async()=>{
    const btn=$('evaluateEvi');btn.disabled=true;
    try {
      const results=loadJSON('eviPredictionEvaluations',{}),now=Date.now();let added=0,requests=0;
      const ids=[...new Set(predictionLog.filter(p=>p.ts+3600000<=now).map(p=>String(p.id)))].slice(-10);
      for(const id of ids) {
        const series=await fetchSeries(id,'1h');requests++;
        for(const p of predictionLog.filter(p=>String(p.id)===id))for(const [h,k] of [[1,'p1'],[6,'p6'],[12,'po']]) {
          const fp=`${p.id}:${p.ts}:${h}`,due=p.ts+h*3600000;
          if(results[fp]||due>now||!p[k]||p[k].dir===0.5||p[k].label==='Uncertain')continue;
          const sample=series.find(x=>x.timestamp*1000>=due&&x.timestamp*1000<=due+3600000&&midpointPoint(x)>0);
          const base=(Number(p.buy)+Number(p.sell))/2;if(!sample||!(base>0))continue;
          const change=midpointPoint(sample)/base-1,actual=change>0.0025?1:change<-.0025?-1:0;
          results[fp]={id:p.id,hours:h,due,sampleTime:sample.timestamp*1000,change,predicted:p[k].dir,actual,correct:p[k].dir===actual};added++;
        }
      }
      localStorage.setItem('eviPredictionEvaluations',JSON.stringify(results));
      const all=Object.values(results);
      $('evaluationStatus').textContent=`${added} new evaluations from ${requests} item requests. `+[1,6,12].map(h=>{const a=all.filter(x=>x.hours===h);return `${h}h: ${a.filter(x=>x.correct).length}/${a.length} correct`;}).join(' · ')+'. Uses the first available hourly sample within one hour after the horizon; stable means within ±0.25%. Missing samples stay unevaluated. Up to 10 recent items per click.';
    }catch(e){$('evaluationStatus').textContent='Evaluation unavailable: '+e.message;}finally{btn.disabled=false;}
  };
  function renderArchive(s){
    $('archiveEnabled').checked=s.enabled;$('archiveBackfill').value=String(s.backfillDays);
    const days=s.hoursStored/24,mb=(s.bytes/1048576).toFixed(1);
    const range=s.oldest?` from ${time(s.oldest*1000)} to ${time(s.newest*1000)}`:'';
    const hourly=s.steps&&s.steps['1h'];
    $('archiveStatus').textContent=(s.enabled?((hourly?hourly.catchingUp:s.catchingUp)?'On · catching up':'On · up to date, next hour checked automatically'):'Off')+
      ` · ${fmt(s.hoursStored)} hours stored (${days.toFixed(1)} days)${range} · ${mb} MB on disk, both resolutions`+
      (s.lastError?` · last error: ${s.lastError} (retries in 5 minutes)`:'');
    // Five-minute buckets: reported separately because they cost separately, and the remaining
    // request count is stated plainly rather than hidden behind a bare "catching up" -- switching
    // this on can mean tens of thousands of requests.
    const f=s.steps&&s.steps['5m'];
    if(!f)return;
    $('archiveFiveEnabled').checked=f.enabled;$('archiveFiveBackfill').value=String(f.backfillDays);
    const fRange=f.oldest?` from ${time(f.oldest*1000)} to ${time(f.newest*1000)}`:'';
    const left=f.catchingUp?` · ${fmt(f.remaining)} buckets still to fetch (about ${(f.remaining*2.5/3600).toFixed(1)} hours at one every 2.5 seconds)`:'';
    $('archiveFiveStatus').textContent=(f.enabled?(f.catchingUp?'On · catching up':'On · up to date'):'Off')+
      ` · ${fmt(f.stored)} buckets stored (${(f.stored/288).toFixed(1)} days)${fRange}${left}`;
  }
  // News-to-item chains (see bridge/newsChain.mjs). The path is the point: it is shown in full so
  // a link that does not hold up can be dismissed on sight, rather than asking anyone to trust a
  // score. Nothing here says a price will move.
  function renderNewsItems(d){
    const posts=(d&&d.posts)||[];
    const withItems=posts.filter(p=>p.chains&&p.chains.length);
    $('newsItemsStatus').textContent=d&&d.lastError?`News links unavailable: ${d.lastError}`
      :d&&d.running?'Following the chains through the wiki now — this takes a couple of minutes and only runs when the news changes.'
      :!posts.length?'No news posts read yet.'
      :`${posts.length} recent posts, ${withItems.length} with tradeable links`+(d.lastRun?` · checked ${time(d.lastRun)}`:'');
    const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    $('newsItems').innerHTML=posts.map(p=>{
      const rows=(p.chains||[]).map(c=>
        `<tr><td>${esc(c.name)}</td><td class="detail">${esc(c.path.join(' → '))}</td>`+
        `<td>${c.volume==null?'—':fmt(c.volume)+'/h'}</td></tr>`).join('');
      const head=p.link?`<a href="${esc(p.link)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a>`:esc(p.title);
      return `<h3>${head}</h3>`+(rows
        ?`<table><thead><tr><th>Item</th><th>How it connects</th><th>Traded</th></tr></thead><tbody>${rows}</tbody></table>`
        :'<p class="detail">No tradeable items connect to this post.</p>');
    }).join('');
  }
  async function pollNewsItems(){try{renderNewsItems(await api('/api/news-items'));}catch(e){$('newsItemsStatus').textContent='News links unavailable: '+e.message;}}
  async function pollArchive(){try{renderArchive(await api('/api/price-archive'));}catch(e){$('archiveStatus').textContent='Archive status unavailable: '+e.message;}}
  async function configureArchive(change){
    try{renderArchive(await api('/api/price-archive',change));}catch(e){$('archiveStatus').textContent=e.message;await pollArchive();}
  }
  $('archiveEnabled').onchange=()=>configureArchive({enabled:$('archiveEnabled').checked});
  $('archiveBackfill').onchange=()=>configureArchive({backfillDays:Number($('archiveBackfill').value)});
  $('archiveFiveEnabled').onchange=()=>configureArchive({fiveMinute:{enabled:$('archiveFiveEnabled').checked}});
  $('archiveFiveBackfill').onchange=()=>configureArchive({fiveMinute:{backfillDays:Number($('archiveFiveBackfill').value)}});
  // EVI scoring itself: suggestions shown, versus what actually happened (see
  // bridge/suggestionOutcomes.mjs). Deliberately reports the misses as plainly as the hits.
  function renderOutcomes(d){
    const s=d.summary,pct=n=>n==null?'—':Math.round(n*100)+'%';
    const mins=n=>n==null?'—':n<90?Math.round(n)+' min':(n/60).toFixed(1)+' h';
    $('outcomeSummary').textContent=s.shown
      ? `${fmt(s.shown)} suggestions shown · acted on ${fmt(s.taken)} (${pct(s.takenShare)}) · ${fmt(s.filledFully)} filled completely, ${fmt(s.stillOpen)} still open · typical time to finish ${mins(s.medianMinutesToComplete)} · used EVI's exact price ${pct(s.followedSuggestedPrice)}`
        + (s.closedFlips?` · ${fmt(s.closedFlips)} closed round trip(s): ${s.realisedProfit>=0?'+':''}${fmt(s.realisedProfit)} GP, ${fmt(s.winners)} up / ${fmt(s.losers)} down`:' · no closed round trips yet')
      : 'No suggestions scored yet.';
    const rows=(d.recent||[]).map(r=>{
      const suggested=`${esc(r.action)} ${fmt(r.quantity)} @ ${fmt(r.action==='buy'?r.buyPrice:r.sellPrice)}`;
      const placed=r.taken?`${fmt(r.actualQuantity)} @ ${fmt(r.actualPrice)}`:'<span class="muted">—</span>';
      const outcome=!r.taken?'<span class="muted">not acted on</span>'
        :r.stillOpen?`open · ${fmt(r.filled)} filled`
        :r.profit!=null?`<span class="${r.profit>=0?'good':'bad'}">closed ${r.profit>=0?'+':''}${fmt(r.profit)} GP</span>`
        :`${r.filledFully?'filled':fmt(r.filled)+' filled'} in ${mins(r.minutesToComplete)}`;
      return `<tr><td>${esc(time(r.ts))}</td><td>${esc(r.name||r.itemId)}</td><td>${suggested}</td><td>${placed}</td><td>${outcome}</td></tr>`;
    }).join('')||'<tr><td colspan="5">Nothing scored yet — EVI records each suggestion as it is shown.</td></tr>';
    if($('outcomeRows').innerHTML!==rows)$('outcomeRows').innerHTML=rows;
  }
  async function pollOutcomes(){try{renderOutcomes(await api('/api/suggestion-outcomes'));}catch(e){$('outcomeSummary').textContent='Suggestion scoring unavailable: '+e.message;}}

  // Settings history with outcomes (bridge/tradingPeriods.mjs). Descriptive only: it never ranks the
  // periods or suggests a setting, because periods are not controlled experiments.
  function renderPeriods(d){
    const p=d.periods||[];
    const closed=p.reduce((n,x)=>n+x.closed,0);
    $('periodStatus').textContent=p.length
      ? `${fmt(p.length)} settings period(s) recorded · ${fmt(closed)} closed round trip(s) across all of them`
      : 'No settings history yet -- it fills in as EVI logs suggestions.';
    const dur=m=>!m?'—':m>=120?Math.round(m/60)+'h':m+' min';
    const rows=p.map(x=>{
      const checks=[x.demoted?fmt(x.demoted)+' demoted':'',x.sellSupportFailed?fmt(x.sellSupportFailed)+' thin sell price':'',x.exitRiskFlagged?fmt(x.exitRiskFlagged)+' exit risk':''].filter(Boolean).join(', ')||'<span class="muted">none</span>';
      const realised=x.closed
        ? `<span class="${x.realisedProfit>=0?'good':'bad'}">${x.realisedProfit>=0?'+':''}${fmt(x.realisedProfit)}</span> (${fmt(x.winners)} up / ${fmt(x.losers)} down)${x.enoughToCompare?'':' <span class="muted">too few to compare</span>'}`
        : '<span class="muted">nothing closed yet</span>';
      return `<tr><td>${esc(time(x.from))}</td><td>${esc(time(x.to))}</td><td>${x.minProfit?fmt(x.minProfit):'<span class="muted">none</span>'}</td><td>${dur(x.durationMinutes)}</td><td>${esc(x.risk||'—')}</td><td>${fmt(x.shown)}</td><td>${fmt(x.taken)}</td><td>${fmt(x.filledFully)}${x.stillOpen?' (+'+fmt(x.stillOpen)+' open)':''}</td><td>${fmt(x.closed)}</td><td>${realised}</td><td>${checks}</td></tr>`;
    }).join('')||'<tr><td colspan="11">Nothing recorded yet.</td></tr>';
    if($('periodRows').innerHTML!==rows)$('periodRows').innerHTML=rows;
  }
  async function pollPeriods(){try{renderPeriods(await api('/api/trading-periods'));}catch(e){$('periodStatus').textContent='Settings history unavailable: '+e.message;}}
  pollPeriods();setInterval(pollPeriods,300000);
  pollOutcomes();setInterval(pollOutcomes,60000);
  // Crash alerts (bridge/crashWatch.mjs). Desktop notifications are opt-in per browser and only fire
  // while this tab is open; which alerts were already announced is remembered in this browser only,
  // so a reload does not announce them twice. Nothing here buys, sells or cancels anything.
  const crashSeen=new Set();
  try{for(const k of JSON.parse(localStorage.getItem('eviCrashSeen')||'[]'))crashSeen.add(k);}catch{}
  try{$('crashNotifyAll').checked=localStorage.getItem('eviCrashNotifyAll')==='1';}catch{}
  $('crashNotifyAll').onchange=()=>{try{localStorage.setItem('eviCrashNotifyAll',$('crashNotifyAll').checked?'1':'0');}catch{}};
  const notifySupported=typeof Notification!=='undefined';
  function crashNotifyLabel(){$('crashNotify').textContent=!notifySupported?'Notifications not supported in this browser':Notification.permission==='granted'?'Notifications on':Notification.permission==='denied'?'Notifications blocked in browser settings':'Notify me on this computer';$('crashNotify').disabled=!notifySupported||Notification.permission!=='default';}
  $('crashNotify').onclick=async()=>{try{await Notification.requestPermission();}catch{}crashNotifyLabel();};
  crashNotifyLabel();
  function renderCrashes(d){
    const live=(d.alerts||[]).filter(a=>!a.ended);
    // A count on the tab itself, so a crash is visible from whichever tab is open.
    const tab=document.querySelector('.tab[data-view="live"]');
    if(tab){const mineLive=live.filter(x=>x.yours).length;const badge=live.length?`<span class="badge">${mineLive?'⚠ ':''}${live.length} crashing</span>`:'';const html='Live RuneLite'+badge;if(tab.innerHTML!==html)tab.innerHTML=html;}
    $('crashStatus').textContent=!d.fiveMinuteOn?'Off: crash alerts need the five-minute price archive (switch it on below). Without it EVI cannot see a crash, which is not the same as there being none.'
      :!d.watching?'Starting: the watch needs the next five-minute price bucket, a few minutes after the bridge starts, and is fully armed after about half an hour.'
      :`Watching ${fmt(d.itemsWithBaseline)} items with a week of steady trading. ${live.length?fmt(live.length)+' crashing now.':'Nothing crashing right now.'}`;
    const rows=(d.alerts||[]).map(a=>{
      const status=a.ended?(a.endedBecause==='recovered'?'<span class="good">recovered</span>':'<span class="muted">'+esc(a.endedBecause||'ended')+'</span>'):'<span class="bad">crashing</span>';
      return `<tr><td>${esc(time(a.since))}</td><td>${a.yours?'<b>':''}${esc(a.name||a.itemId)}${a.yours?'</b> (yours)':''}</td><td>${fmt(a.hi)} gp (-${Math.round(a.drop*100)}%)</td><td>${fmt(a.baseHi)} gp</td><td>${fmt(a.units)}</td><td>${status}</td></tr>`;
    }).join('')||'<tr><td colspan="6">No crashes in the last day.</td></tr>';
    if($('crashRows').innerHTML!==rows)$('crashRows').innerHTML=rows;
    const msgs=live.map(a=>'<p>'+esc(a.message)+'</p>').join('')||'<p>None right now.</p>';
    if($('crashMessages').innerHTML!==msgs)$('crashMessages').innerHTML=msgs;
    if(notifySupported&&Notification.permission==='granted')for(const a of live){
      const key=a.itemId+':'+a.since;
      if(crashSeen.has(key)||!(a.yours||$('crashNotifyAll').checked))continue;
      crashSeen.add(key);
      try{new Notification('EVI: '+(a.name||'Item '+a.itemId)+' is crashing',{body:a.message,tag:'evi-crash-'+a.itemId});}catch{}
    }
    try{localStorage.setItem('eviCrashSeen',JSON.stringify([...crashSeen].slice(-200)));}catch{}
  }
  async function pollCrashes(){try{renderCrashes(await api('/api/crash-alerts'));}catch(e){$('crashStatus').textContent='Crash watch unavailable: '+e.message;}}
  pollCrashes();setInterval(pollCrashes,60000);
  // What you own (bridge/wealth.mjs). A plain inline chart rather than a library: one polyline over the
  // recorded totals, so it works with the page opened straight from disk and adds nothing to load.
  function renderWealth(d){
    const c=d.current,gp=n=>fmt(Math.round(n));
    const parts=[];
    if(c.cash!==null)parts.push('cash '+gp(c.cash));
    parts.push('in buy offers '+gp(c.inBuyOffers));
    parts.push('listed '+gp(c.inSellOffers));
    parts.push('held '+gp(c.held));
    const change=k=>{const x=d.changes[k];return x?`${x.gp>=0?'+':''}${gp(x.gp)} GP`:'not enough history yet';};
    $('wealthSummary').textContent=c.total!==null
      ? `Total ${gp(c.total)} GP (coins read ${d.cashAt?esc(time(d.cashAt)):'just now'}) · last 24h ${change('day')} · last 7 days ${change('week')}`
      : `Coin count not reported yet -- start the bridge and the plugin, then log in. EVI reads the coins in your inventory, so coins left in the bank do not count. Outside your cash stack: ${gp(c.outsideCash)} GP.`;
    $('wealthParts').textContent=parts.join(' · ')
      +(c.unrealised!==null?` · stock cost ${gp(c.stockCost)}, so unrealised ${c.unrealised>=0?'+':''}${gp(c.unrealised)} GP`:'')
      +(c.uncostedUnits?` · ${fmt(c.uncostedUnits)} unit(s) EVI never saw bought, left out of unrealised`:'')
      +(c.unpricedUnits?` · ${fmt(c.unpricedUnits)} unit(s) with no current price, carried at what you paid`:'');
    const h=(d.history||[]).filter(r=>Number.isFinite(r.total));
    if(h.length<2){$('wealthChart').innerHTML='<p class="detail">The chart needs at least two recorded snapshots.</p>';return;}
    const W=720,H=140,lo=Math.min(...h.map(r=>r.total)),hi=Math.max(...h.map(r=>r.total)),span=hi-lo||1;
    const x=i=>(i/(h.length-1))*(W-2)+1,y=v=>H-2-((v-lo)/span)*(H-6);
    const pts=h.map((r,i)=>x(i).toFixed(1)+','+y(r.total).toFixed(1)).join(' ');
    const first=h[0],last=h[h.length-1],up=last.total>=first.total;
    $('wealthChart').innerHTML=`<svg viewBox="0 0 ${W} ${H}" width="100%" height="140" role="img" aria-label="Total wealth over time">`
      +`<polyline fill="none" stroke="${up?'var(--good)':'var(--bad)'}" stroke-width="2" points="${pts}"></polyline></svg>`
      +`<p class="detail">${esc(time(first.at))} ${gp(first.total)} GP → ${esc(time(last.at))} ${gp(last.total)} GP · ${fmt(h.length)} snapshots</p>`;
  }
  // A goal: an item (or a plain GP amount), the gap to it, and how long that gap takes at a rate the
  // player actually achieved -- never a forecast. Two rates are shown side by side and labelled,
  // because wealth growth includes everything (Slayer drops included) while the flip rate is EVI's
  // own contribution; quoting one as the other would flatter whichever suits.
  function renderGoal(g){
    const bar=$('goalBar'),fill=$('goalFill');
    if(!g){$('goalStatus').textContent='No goal set. Name an item, or type a GP amount.';bar.style.display='none';$('goalDetail').textContent='';return;}
    const gp=n=>fmt(Math.round(n));
    const dur=hrs=>hrs==null?null:hrs<48?Math.round(hrs)+' hours':(hrs/24).toFixed(hrs/24<10?1:0)+' days';
    const what=(g.name?`${g.quantity>1?fmt(g.quantity)+' x ':''}${g.name}`:'your target')+(g.targetGp?` (${gp(g.targetGp)} GP at today's price)`:'');
    if(g.gap===0){$('goalStatus').textContent=`${what} -- you have enough. ${g.have!==null?gp(g.have)+' GP in total.':''}`;}
    else if(g.gap===null){$('goalStatus').textContent=`${what} -- ${esc(g.why||'not enough information to compare yet')}`;}
    else {$('goalStatus').textContent=`${what} · you have ${gp(g.have)} GP · ${gp(g.gap)} GP to go`+(g.share!==null?` (${Math.round(g.share*100)}%)`:'');}
    if(g.share!==null){bar.style.display='';fill.style.width=Math.round(g.share*100)+'%';}else bar.style.display='none';
    const parts=[];
    const w=g.rates.wealth,f=g.rates.flips;
    if(w)parts.push(`everything you do: ${w.gpPerHour>=0?'+':''}${gp(w.gpPerHour)} GP/h over ${Math.round(w.spanHours)}h`+(dur(w.hoursToGo)?` → about ${dur(w.hoursToGo)}`:''));
    if(f)parts.push(`EVI's tracked flips: ${f.gpPerHour>=0?'+':''}${gp(f.gpPerHour)} GP/h from ${fmt(f.flips)} flips`+(dur(f.hoursToGo)?` → about ${dur(f.hoursToGo)}`:''));
    if(!parts.length&&g.why)parts.push(g.why);
    $('goalDetail').textContent=parts.join(' · ')+(g.targetGp?" · the item's price moves too, so this is at today's price, not a promise.":'');
  }
  $('goalSave').onclick=async()=>{
    const raw=$('goalItem').value.trim();
    const quantity=Math.max(1,Number($('goalQty').value)||1);
    if(!raw){$('goalStatus').textContent='Name an item, or type a GP amount like 1.2b.';return;}
    const item=typeof market!=='undefined'&&market?.mapping?.find(m=>m.name.toLowerCase()===raw.toLowerCase());
    const amount=item?null:parseGpAmount(raw);
    if(!item&&!(amount&&amount.value)){$('goalStatus').textContent=(amount&&amount.error)||`No item called "${raw}". Pick one from the list, or type a GP amount.`;return;}
    try{await api('/api/goal',item?{itemId:item.id,quantity}:{gp:amount.value});await pollWealth();}
    catch(e){$('goalStatus').textContent='Could not save that goal: '+e.message;}
  };
  $('goalClear').onclick=async()=>{try{await api('/api/goal',{});$('goalItem').value='';await pollWealth();}catch(e){$('goalStatus').textContent=e.message;}};
  // The item list comes from the mapping the Scanner tab already holds; no extra request.
  function fillGoalItems(){
    const list=$('goalItems');
    if(!list||list.children.length||typeof market==='undefined'||!market?.mapping)return;
    list.innerHTML=market.mapping.slice(0,5000).map(m=>`<option value="${esc(m.name)}"></option>`).join('');
  }
  async function pollWealth(){try{const d=await api('/api/wealth');renderWealth(d);renderGoal(d.goal);fillGoalItems();}catch(e){$('wealthSummary').textContent='Wealth view unavailable: '+e.message;}}
  pollWealth();setInterval(pollWealth,60000);
  // Items excluded from the idle-inventory tier (Store.markPersonalUseItem), with an undo. Rendered
  // from the state EVI already polls, so it costs no extra request.
  function renderOwned(){
    const ids=(state&&state.personalUseItems)||[];
    $('ownedStatus').textContent=ids.length?'':"Nothing marked yet. Use the sidebar's \"Personal use\" button on a suggestion to sell gear you actually wear.";
    const name=id=>(typeof market!=='undefined'&&market?.mapping?.find(m=>m.id===id)?.name)||('Item '+id);
    const html=ids.map(id=>`<p>${esc(name(id))} <button data-unown="${id}">EVI may suggest selling this again</button></p>`).join('');
    if($('ownedList').innerHTML!==html)$('ownedList').innerHTML=html;
  }
  // Blocked items (the sidebar's Block button), by name, each with an Unblock -- so undoing a block
  // never needs an item ID either.
  async function renderBlocked(){
    try{
      const p=await api('/api/preferences');
      const items=p.blockedItems||[];
      $('blockedStatus').textContent=items.length?'':'Nothing blocked. Use "Block this item" in the sidebar on a suggestion you never want again.';
      const html=items.map(x=>`<p>${esc(x.name||('Item '+x.itemId))} <button data-unblock="${x.itemId}">Unblock</button></p>`).join('');
      if($('blockedList').innerHTML!==html)$('blockedList').innerHTML=html;
    }catch(e){$('blockedStatus').textContent='Blocked items unavailable: '+e.message;}
  }
  $('blockedList').addEventListener('click',async e=>{
    const id=e.target?.dataset?.unblock;
    if(!id)return;
    try{await api('/api/preferences/block',{itemId:Number(id),blocked:false});await renderBlocked();}
    catch(err){$('blockedStatus').textContent='Could not unblock that: '+err.message;}
  });
  renderBlocked();setInterval(renderBlocked,60000);
  $('ownedList').addEventListener('click',async e=>{
    const id=e.target?.dataset?.unown;
    if(!id)return;
    try{await api('/api/inventory-personal-use',{itemId:Number(id),personal:false});await poll();}
    catch(err){$('ownedStatus').textContent='Could not undo that: '+err.message;}
  });
  // The sharing preview (bridge/sharePreview.mjs): built only when opened, since it reads the price
  // archive, and shown as the raw records so what you read is exactly what would leave the machine.
  $('sharePreview').ontoggle=async()=>{
    if(!$('sharePreview').open)return;
    try{
      const d=await api('/api/share-preview'),k=d.skipped||{};
      const left=(k.marginCheck||0)+(k.notWatchedFromStart||0)+(k.hourNotArchived||0)+(k.noMarketReading||0);
      $('sharePreviewStatus').textContent=`${fmt(d.records.length)} offer(s) would be described · ${fmt(left)} left out (${fmt(k.marginCheck||0)} margin checks, ${fmt(k.notWatchedFromStart||0)} not watched from placement, ${fmt(k.hourNotArchived||0)} with no archived hour, ${fmt(k.noMarketReading||0)} with no usable market reading) · sent anywhere: no`;
      $('sharePreviewBody').textContent=d.records.length?JSON.stringify(d.records,null,1):'';
    }catch(e){$('sharePreviewStatus').textContent='Sharing preview unavailable: '+e.message;}
  };
  pollArchive();setInterval(pollArchive,30000);
  // Slower than everything else on purpose: the answer only changes when Jagex posts news, and the
  // walk behind it is cached for half a day.
  pollNewsItems();setInterval(pollNewsItems,300000);
  poll();setInterval(poll,5000);
})();
