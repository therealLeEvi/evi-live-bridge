'use strict';
(()=>{const el=id=>document.getElementById(id);try{const saved=JSON.parse(localStorage.getItem('eviSuggestionPreferences')||'null');if(saved){el('planProfit').value=String(saved.profit);el('planTime').value=saved.timeframe;}}catch(_){}
el('planSave').onclick=()=>{
  try{
    const profit=Number(el('planProfit').value)||0, timeframe=el('planTime').value;
    const prefs={version:1,profit,timeframe};
    localStorage.setItem('eviSuggestionPreferences',JSON.stringify(prefs));
    // Update the shared in-memory copy buildRows/filteredRows already read (same top-level scope as
    // the main inline script -- see suggestionPrefs in EVI_Flip_Scanner_V3.html) and re-score/re-render
    // immediately, so Save visibly changes the table instead of only taking effect on the next refresh.
    if(typeof suggestionPrefs!=='undefined')suggestionPrefs=prefs;
    if(typeof market!=='undefined' && market && typeof buildRows==='function'){rows=buildRows(market.mapping,market.latest,market.m5,market.h1);}
    if(typeof render==='function')render();
    el('planStatus').textContent='Preferences saved. EVI score and Suggested GE Slots now reflect your profit target and holding period.';
  }catch(e){el('planStatus').textContent='Could not save preferences: '+e.message;}
};})();
