'use strict';
(() => {
  const el=id=>document.getElementById(id),esc=escapeHtml;
  let catalogue=[],prices={},busy=false;
  const normalize=s=>String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  function renderLookup(){
    const query=normalize(el('lookupQuery').value),terms=query.split(' ').filter(Boolean);
    const access=el('lookupAccess').value;
    const matches=catalogue.filter(i=>(!access||access==='all'||(access==='free'&&i.members===false)||(access==='members'&&i.members===true))&&(String(i.id)===query||terms.every(t=>normalize(i.name).includes(t))));
    const gp=x=>Number.isFinite(x)&&x>0?x.toLocaleString()+' GP':'Unknown';
    const stamp=x=>Number.isFinite(x)&&x>0?esc(new Date(x*1000).toLocaleString()):'Unknown';
    el('lookupResults').innerHTML=matches.slice(0,100).map(i=>{
      const p=prices[i.id]||{};
      const link='https://oldschool.runescape.wiki/w/Special:Lookup?type=item&id='+encodeURIComponent(i.id);
      return `<tr><td>${esc(i.name)} <small>#${i.id}</small><br><small>${i.members===true?'Members':i.members===false?'Free-to-play':'Access unknown'}</small></td><td>${gp(p.high)}</td><td>${stamp(p.highTime)}</td><td>${gp(p.low)}</td><td>${stamp(p.lowTime)}</td><td>${Number.isFinite(i.limit)?i.limit.toLocaleString():'Unknown'}</td><td><a href="${link}" target="_blank" rel="noopener noreferrer">Wiki</a></td></tr>`;
    }).join('')||'<tr><td colspan="7">No catalogue match. Try a shorter name, such as Avernic.</td></tr>';
    el('lookupStatus').textContent=`${catalogue.length.toLocaleString()} catalogue items · ${matches.length.toLocaleString()} matches${matches.length>100?' · showing first 100; narrow your search':''}`;
  }
  async function refreshLookup(){
    if(busy)return;busy=true;el('lookupRefresh').disabled=true;el('lookupStatus').textContent='Loading Wiki catalogue and prices…';
    try{
      const read=async route=>{const r=await fetch('/api/market/'+route,{signal:AbortSignal.timeout(20000)});if(!r.ok)throw Error('Source unavailable ('+r.status+')');return r.json();};
      const [mapping,latest]=await Promise.all([read('mapping'),read('latest')]);
      if(!Array.isArray(mapping)||!latest.data)throw Error('Unexpected price response');
      catalogue=mapping.filter(i=>Number.isSafeInteger(i.id)&&typeof i.name==='string').sort((a,b)=>a.name.localeCompare(b.name));prices=latest.data;renderLookup();
    }catch(e){el('lookupStatus').textContent='Could not refresh: '+e.message+'. Previously loaded prices, if shown, may be stale.';}
    finally{busy=false;el('lookupRefresh').disabled=false;}
  }
  el('lookupQuery').addEventListener('input',renderLookup);
  el('lookupAccess').addEventListener('change',renderLookup);
  el('lookupRefresh').onclick=refreshLookup;
  document.querySelector('[data-view="lookup"]').addEventListener('click',()=>{if(!catalogue.length)refreshLookup();});
})();
