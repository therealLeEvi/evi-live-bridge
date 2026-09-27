'use strict';
(async()=>{
const {FIELDS,suggestMapping,previewTable}=await import('/import-core.mjs');
const el=id=>document.getElementById(id), esc=escapeHtml;let workbook=null,preview=null,worker=null;
const invalidate=()=>{preview=null;el('logCommit').disabled=true;};
function mapping(){invalidate();const sheet=workbook.sheets[Number(el('logSheet').value)];const headers=sheet.rows[0]||[],guess=suggestMapping(headers);
el('logMapping').innerHTML=FIELDS.map(f=>`<label>${esc(f)} <select data-field="${f}"><option value="">Not supplied</option>${headers.map((h,i)=>`<option value="${i}" ${guess[f]===i?'selected':''}>${esc(h??'Column '+(i+1))}</option>`).join('')}</select></label>`).join('');
el('logStatus').textContent=sheet.formulaCells.length?'Formula cells use saved values only. Save/recalculate the workbook in Excel before importing.':'Choose columns, then preview.';}
el('logRead').onclick=async()=>{invalidate();try{const file=el('logFile').files[0];if(!file)throw Error('Choose a CSV, TSV or XLSX file.');if(file.size>10000000)throw Error('Maximum file size is 10 MB.');if(worker)worker.terminate();worker=new Worker('/import-worker.mjs',{type:'module'});const current=worker;el('logStatus').textContent='Reading locally…';
const timer=setTimeout(()=>{current.terminate();el('logStatus').textContent='Reading timed out. Try a smaller file.';},15000);
current.onmessage=({data})=>{clearTimeout(timer);current.terminate();if(data.error){el('logStatus').textContent=data.error;return;}workbook=data;el('logDate').value=data.dateFormat;el('logSheet').innerHTML=data.sheets.map((s,i)=>`<option value="${i}">${esc(s.name)}</option>`).join('');mapping();};
current.onerror=()=>{clearTimeout(timer);current.terminate();el('logStatus').textContent='Could not read file. Check that all update files were installed.';};
current.postMessage(/\.xlsx$/i.test(file.name)?{xlsx:true,bytes:await file.arrayBuffer()}:{text:await file.text(),delimiter:el('logDelimiter').value});
}catch(e){el('logStatus').textContent=e.message;}};
el('logSheet').onchange=mapping;el('logMapping').onchange=invalidate;
for(const id of ['logSource','logDate','logDecimal','logTax','logOverlap','logOffset'])el(id).onchange=invalidate;
el('logPreview').onclick=()=>{invalidate();try{if(!workbook)throw Error('Read a file first.');if(!el('logOverlap').checked)throw Error('Confirm this file does not overlap other sources or live RuneLite history.');const map={};el('logMapping').querySelectorAll('select').forEach(s=>{if(s.value!=='')map[s.dataset.field]=Number(s.value);});
const result=previewTable(workbook.sheets[Number(el('logSheet').value)].rows,map,{source:el('logSource').value,decimal:el('logDecimal').value,dateFormat:el('logDate').value,timezoneOffsetMinutes:Number(el('logOffset').value),profitMeaning:el('logTax').checked?'after-tax':''});
const fresh=result.records.filter(r=>!r.duplicateOf&&!importedFingerprints[r.fp]);
el('logStatus').textContent=`${fresh.length} new trades; ${result.records.length-fresh.length} duplicates; ${result.errors.length} errors. `+result.errors.slice(0,8).map(e=>`Row ${e.row}: ${e.message}`).join(' ');
el('logRows').innerHTML=fresh.slice(0,30).map(r=>`<tr><td>${esc(r.item)}</td><td>${r.capital??'Unknown'}</td><td>${r.profit}</td><td>${r.hold??'Unknown'}</td></tr>`).join('');
el('logWarnings').textContent=result.warnings.slice(0,8).map(w=>`Row ${w.row}: ${w.message}`).join(' ');
if(!result.errors.length&&fresh.length){preview=fresh;el('logCommit').disabled=false;}
}catch(e){el('logStatus').textContent=e.message;}};
el('logCommit').onclick=()=>{try{if(!preview)return;const additions=preview.filter(r=>!importedFingerprints[r.fp]);const nextExtra=[...extraRows,...additions],nextFP={...importedFingerprints};additions.forEach(r=>nextFP[r.fp]=1);const nextHistory=rawHistoryRows?aggregateRows([...rawHistoryRows,...nextExtra.filter(x=>!rawHistoryRows.some(y=>y.fp===x.fp))]):mergeAggregateProfiles(DEFAULT_HISTORY,aggregateRows(nextExtra));
localStorage.setItem('eviLiveMergeCheckpoint',JSON.stringify({extraRows:nextExtra,importedFingerprints:nextFP,history:nextHistory}));
for(const [k,v] of [['eviExtraRows',nextExtra],['eviImportedFingerprints',nextFP],['eviHistory',nextHistory]])localStorage.setItem(k,JSON.stringify(v));localStorage.removeItem('eviLiveMergeCheckpoint');extraRows=nextExtra;importedFingerprints=nextFP;history=nextHistory;if(market)rows=buildRows(market.mapping,market.latest,market.m5,market.h1);render();invalidate();el('logStatus').textContent=additions.length+' trades added to history.';
}catch(e){invalidate();el('logStatus').textContent='Could not finish saving. Reload to recover the saved checkpoint: '+e.message;}};
})().catch(e=>{document.getElementById('logStatus').textContent='Importer unavailable: '+e.message;});
