import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../scanner/EVI_Flip_Scanner_V3.html',import.meta.url),'utf8');
const source=html.match(/<script>([\s\S]*?)<\/script>/)[1];
function scanner() {
  const values={bankroll:'150000000',maxPos:'15000000',slots:'8',minScore:'0',mode:'all',search:'',portfolioSort:'profit'};
  const storage=new Map();
  const els=new Map();const element=id=>{if(!els.has(id))els.set(id,{value:values[id]??'',options:[],selectedOptions:[],innerHTML:'',textContent:'',style:{},addEventListener(){},classList:{toggle(){}},querySelectorAll(){return [];}});return els.get(id);};
  const context=vm.createContext({document:{getElementById:element,querySelector:element,querySelectorAll:()=>[],body:{},addEventListener(){}},
    window:{addEventListener(){}},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},MutationObserver:class{observe(){}},requestAnimationFrame(){},setInterval(){},console,AbortSignal,
    fetch:async()=>({ok:true,json:async()=>({data:{}})}),Date,URL,encodeURIComponent});
  // Keep original functions; omit initial network/UI startup for deterministic tests.
  vm.runInContext(source.replace('updateHistCards();renderHistory();renderNews();refresh();',''),context);
  return {context,element,storage,run:code=>vm.runInContext(code,context)};
}
test('the maintainer\'s own history is out of the page and safe in the private folder',()=>{
  // This used to assert the page still embedded the V2.3 baseline byte for byte, which was the right
  // guard while the scanner was private: it protected 638 item profiles and 1,209 trades through every
  // refactor. Publishing the scanner inverts it. That block is the maintainer's own trading record --
  // per-item profit, win rates, hold times and average capital, single items over 113m gp -- and under
  // BSD 2-Clause it would be copyable by anyone, forever. So on 27 Sept 2026 it was exported to
  // data/baseline-history.json, which is never published, and emptied here.
  //
  // The guard's intent is kept, only pointed at the file instead of the page: the data must still exist,
  // and must no longer be in anything that ships.
  assert.match(html,/const DEFAULT_HISTORY = \{\};/,'the page must ship with no history of its own');
  const embedded=html.match(/const DEFAULT_HISTORY = (\{.*?\});/)[1];
  assert.equal(Object.keys(JSON.parse(embedded)).length,0);
  for(const field of ['"trades":','"totalProfit":','"avgCapital":','"winRate":'])
    assert.ok(!html.includes(field),'no profile data may remain in the page ('+field+')');

  // The two checks below read files that are deliberately NOT published -- the export lives in data/
  // and the V2.3 original is archival -- so they are skipped where those are absent. That is what lets
  // this one test file serve both the working copy and the published repository. Everything above runs
  // everywhere, because the part that must never regress is the page itself.
  const exportPath=new URL('../data/baseline-history.json',import.meta.url);
  if(fs.existsSync(exportPath)) {
    // Still exported, still complete. If this fails the export was lost; restore it before anything else.
    const exported=JSON.parse(fs.readFileSync(exportPath,'utf8'));
    assert.equal(Object.keys(exported).length,638,'the exported baseline must still hold every profile');
    assert.equal(Object.values(exported).reduce((n,i)=>n+(i.trades||0),0),1209);
  }
  const v23Path=new URL('../scanner/EVI_Flip_Scanner_V2_3.original.html',import.meta.url);
  if(fs.existsSync(v23Path)) {
    // Kept only as an archival original, and it STILL embeds the same 638 profiles, so it must never be
    // published. Asserted here so the fact is impossible to forget while preparing a release.
    assert.ok(fs.readFileSync(v23Path,'utf8').includes('"totalProfit":'),
      'if this ever stops being true, update the publish exclusions');
  }

  new vm.Script(source);new vm.Script(fs.readFileSync(new URL('../scanner/live.js',import.meta.url),'utf8'));
});
test('bankroll and position safeguards reject expensive units and zero budget',()=>{
  const s=scanner();s.run(`var sampleMapping=[{id:1,name:'Soulreaper axe',limit:8},{id:2,name:'Test',limit:1000}];var sampleLatest={1:{low:423318199,high:440000000},2:{low:100,high:110}};var sampleVolume={1:{lowPriceVolume:100,highPriceVolume:100},2:{lowPriceVolume:1000,highPriceVolume:1000}};`);
  assert.equal(s.run('buildRows(sampleMapping,sampleLatest,sampleVolume,sampleVolume).some(r=>r.id===1)'),false);
  s.element('bankroll').value='0';assert.equal(s.run('buildRows(sampleMapping,sampleLatest,sampleVolume,sampleVolume).length'),0);
  s.element('bankroll').value='150000000';s.element('maxPos').value='0';assert.equal(s.run('buildRows(sampleMapping,sampleLatest,sampleVolume,sampleVolume).length'),0);
});
test('portfolio respects reserve and zero free slots',()=>{
  const s=scanner();s.element('bankroll').value='1000000';
  s.run("rows=[{id:1,name:'Test',mode:'Fast',expected:100000,score:80,buy:100000,sell:120000,net:18000,qty:10,capital:1000000}];buildPortfolio();");
  assert.ok(s.element('portfolioSummary').innerHTML.includes('capital 900.0k'));
  s.element('slots').value='0';s.run('buildPortfolio()');assert.ok(s.element('portfolioSummary').innerHTML.includes('0 suggested'));
});
test('CSV parser preserves quoting and stable fingerprints',()=>{
  const s=scanner();const csv='First buy time,Last sell time,Item,Bought,Sold,Avg. buy price,Profit\n2026-09-01T12:00:00Z,2026-09-01T13:00:00Z,"Rune, test",10,10,100,50';
  s.context.csvInput=csv;assert.equal(s.run('extractCopilotRows(csvInput)[0].item'),'Rune, test');
  assert.equal(s.run('extractCopilotRows(csvInput)[0].fp'),s.run('extractCopilotRows(csvInput)[0].fp'));
  assert.equal(s.run('extractCopilotRows(csvInput)[0].hold'),1);
});

test('holdFitScore reproduces the original fixed weights when no preference is saved',()=>{
  const s=scanner();
  assert.equal(s.run("holdFitScore('Medium',null)"),10);
  assert.equal(s.run("holdFitScore('Overnight',null)"),10);
  assert.equal(s.run("holdFitScore('Fast',null)"),7);
  assert.equal(s.run("holdFitScore('Slow',null)"),2);
});
test('holdingPeriodMode maps every holding-period bucket to a scanner mode',()=>{
  const s=scanner();
  assert.equal(s.run("holdingPeriodMode('5m')"),'Fast');
  assert.equal(s.run("holdingPeriodMode('1h')"),'Fast');
  assert.equal(s.run("holdingPeriodMode('6h')"),'Medium');
  assert.equal(s.run("holdingPeriodMode('12h')"),'Overnight');
  assert.equal(s.run("holdingPeriodMode('24h')"),'Overnight');
  assert.equal(s.run("holdingPeriodMode('72h')"),'Slow');
  assert.equal(s.run("holdingPeriodMode('168h')"),'Slow');
  assert.equal(s.run("holdingPeriodMode('bogus')"),null);
});
test('holdFitScore rewards an exact preference match and falls off with distance',()=>{
  const s=scanner();
  assert.equal(s.run("holdFitScore('Slow','Slow')"),10);
  assert.equal(s.run("holdFitScore('Overnight','Slow')"),6);
  assert.equal(s.run("holdFitScore('Medium','Slow')"),3);
  assert.equal(s.run("holdFitScore('Fast','Slow')"),1);
});
test('a saved holding-period preference shifts a row\'s own score toward its own preferred mode',()=>{
  const s=scanner();
  s.run(`var sampleMapping=[{id:1,name:'SlowItem',limit:100}];var sampleLatest={1:{low:1000,high:1200}};var slowVol={1:{highPriceVolume:1,lowPriceVolume:1}};`);
  const withoutPref=s.run('buildRows(sampleMapping,sampleLatest,slowVol,slowVol)[0]');
  assert.equal(withoutPref.mode,'Slow');
  const defaultScore=withoutPref.score;
  s.run("suggestionPrefs={version:1,profit:0,timeframe:'168h'}"); // Slow-matching preference
  const matchedScore=s.run('buildRows(sampleMapping,sampleLatest,slowVol,slowVol)[0].score');
  s.run("suggestionPrefs={version:1,profit:0,timeframe:'5m'}"); // Fast preference, opposite end from Slow
  const oppositeScore=s.run('buildRows(sampleMapping,sampleLatest,slowVol,slowVol)[0].score');
  assert.ok(matchedScore>defaultScore,`expected matched (${matchedScore}) > default (${defaultScore})`);
  assert.ok(defaultScore>oppositeScore,`expected default (${defaultScore}) > opposite (${oppositeScore})`);
});
test('a saved profit target filters rows out of filteredRows (and therefore Suggested GE Slots)',()=>{
  const s=scanner();
  s.run("rows=[{id:1,name:'AboveTarget',members:null,score:80,mode:'Medium',expected:40000},{id:2,name:'BelowTarget',members:null,score:80,mode:'Medium',expected:5000}];");
  assert.equal(s.run('filteredRows().length'),2); // suggestionPrefs.profit defaults to 0 (Auto) -- no filter
  s.run("suggestionPrefs={version:1,profit:20000,timeframe:null};");
  const filtered=s.run('filteredRows()');
  assert.equal(filtered.length,1);
  assert.equal(filtered[0].name,'AboveTarget');
});
test('preferences.js Save wires the shared suggestionPrefs global, rebuilds rows and re-renders',()=>{
  const s=scanner();
  s.run(fs.readFileSync(new URL('../scanner/preferences.js',import.meta.url),'utf8'));
  s.run(`var sampleMapping=[{id:1,name:'SlowItem',limit:100}];var sampleLatest={1:{low:1000,high:1200}};var slowVol={1:{highPriceVolume:1,lowPriceVolume:1}};market={mapping:sampleMapping,latest:sampleLatest,m5:slowVol,h1:slowVol};rows=buildRows(sampleMapping,sampleLatest,slowVol,slowVol);`);
  const before=s.run('rows[0].score');
  s.element('planProfit').value='0';
  s.element('planTime').value='168h';
  s.element('planSave').onclick();
  assert.equal(s.run('suggestionPrefs.timeframe'),'168h');
  assert.equal(JSON.parse(s.storage.get('eviSuggestionPreferences')).timeframe,'168h');
  assert.ok(s.run('rows[0].score')>before);
  assert.match(s.element('planStatus').textContent,/EVI score and Suggested GE Slots/);
});

test('pushSuggestions posts the top rows to the bridge in the shape it expects',async()=>{
  const s=scanner();
  const calls=[];
  s.context.fetch=async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>({ok:true,accepted:2})};};
  s.run(`rows=[{id:1,name:'A',buy:100,sell:130,net:25,qty:10,score:80,mode:'Medium'},{id:2,name:'B',buy:50,sell:70,net:15,qty:5,score:60,mode:'Fast'}];`);
  await s.run('pushSuggestions()');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/api/scanner-suggestions');
  assert.equal(calls[0].opts.method,'POST');
  assert.equal(calls[0].opts.headers['X-EVI-UI'],'1');
  const body=JSON.parse(calls[0].opts.body);
  assert.equal(body.items.length,2);
  assert.deepEqual(body.items[0],{itemId:1,name:'A',buy:100,sell:130,net:25,qty:10,score:80,mode:'Medium'});
});
test('pushSuggestions sends nothing when there are no rows yet, and never throws on a failed push',async()=>{
  const s=scanner();
  let calls=0;
  s.context.fetch=async()=>{calls++;throw new Error('bridge unreachable');};
  s.run('rows=[];');
  await s.run('pushSuggestions()'); // no rows: must not even attempt a call
  assert.equal(calls,0);
  s.run(`rows=[{id:1,name:'A',buy:100,sell:130,net:25,qty:10,score:80,mode:'Medium'}];`);
  await s.run('pushSuggestions()'); // fetch rejects: must resolve quietly, not throw
  assert.equal(calls,1);
});

test('reviewed live flip merges once and keeps the embedded baseline',async()=>{
  const s=scanner();
  const state={sessions:[],active:[],completed:[],flips:[{id:'reviewed-test-id',account:'testaccount',itemId:1,item:'Synthetic verification item',quantity:10,capital:1000,netProceeds:1180,profit:180,hold:1,firstBuy:Date.now()-3600000,buyId:'buy',sellId:'sell'}]};
  s.context.fetch=async()=>({ok:true,json:async()=>state});
  s.run(fs.readFileSync(new URL('../scanner/live.js',import.meta.url),'utf8'));
  await new Promise(resolve=>setImmediate(resolve));
  s.element('mergeFlips').onclick();
  assert.match(s.element('liveAction').textContent,/1 reviewed flip/);
  assert.equal(JSON.parse(s.storage.get('eviExtraRows')).length,1);
  assert.equal(JSON.parse(s.storage.get('eviImportedFingerprints'))['runelite:reviewed-test-id'],1);
  assert.equal(s.run('Object.keys(history).length'),s.run('Object.keys(DEFAULT_HISTORY).length')+1);
  const first=s.storage.get('eviHistory');
  s.element('mergeFlips').onclick();
  assert.match(s.element('liveAction').textContent,/0 reviewed flip/);
  assert.equal(s.storage.get('eviHistory'),first);
  assert.equal(s.storage.has('eviLiveMergeCheckpoint'),false);
});

test('parseGpAmount accepts grouped and k/m/b amounts and rejects ambiguous ones instead of guessing',()=>{
  const s=scanner();const v=x=>s.run(`parseGpAmount(${JSON.stringify(x)})`);
  for(const [input,value] of [['1500000',1500000],['1,500,000',1500000],['1.500.000',1500000],['1 500 000',1500000],['1.5m',1500000],['1,5m',1500000],['750k',750000],['2b',2000000000],[' 4617544 gp',4617544]])
    assert.equal(v(input).value,value,input);
  for(const input of ['','0','1.5','1500000.5','1.2345k','1.500k1','abc','1,500.000','-5'])
    assert.ok(v(input).error,input+' must be rejected');
});

// Asked for after typing a nine-digit bankroll by hand once too often: the amount fields take
// "380m", "1.5b", "750k" and grouped digits, using the same parser the flip-review field already had.
test('bankroll and max-position accept shorthand amounts, and unreadable text is never guessed at',()=>{
  const s=scanner();
  const read=(id,text)=>{s.element(id).value=text;return s.run(`gpFieldValue('${id}')`);};
  assert.equal(read('bankroll','380m'),380000000);
  assert.equal(read('bankroll','1.5b'),1500000000);
  assert.equal(read('bankroll','750K'),750000);
  assert.equal(read('bankroll','380000000'),380000000,'plain digits still work exactly as before');
  assert.equal(read('bankroll','1.500.000'),1500000,'grouped digits too');
  assert.equal(read('maxPos','15m'),15000000);
  // Anything unreadable reads as 0 -- the same as an empty field, never a number EVI made up.
  assert.equal(read('bankroll',''),0);
  assert.equal(read('bankroll','abc'),0);
  assert.equal(read('bankroll','1.5'),0,'ambiguous without a suffix: rejected rather than read as 1 or 15');
  // And it flows through to the ranking: 380m of bankroll buys what 380,000,000 buys.
  s.run(`var sampleMapping=[{id:2,name:'Test',limit:1000}];var sampleLatest={2:{low:100,high:130}};var sampleVolume={2:{highPriceVolume:5000,lowPriceVolume:5000}};`);
  s.element('maxPos').value='15m';
  s.element('bankroll').value='380m';
  const typed=s.run('buildRows(sampleMapping,sampleLatest,sampleVolume,sampleVolume).map(r=>r.qty)');
  s.element('bankroll').value='380000000';
  assert.deepEqual(s.run('buildRows(sampleMapping,sampleLatest,sampleVolume,sampleVolume).map(r=>r.qty)'),typed);
});

// Asked for after scrolling the list looking for the cheapest capital: the column headers sort.
test('scanner: clicking a column header sorts the list, and missing values always sink',()=>{
  const s=scanner();
  s.run(`var sampleMapping=[{id:1,name:'Bravo',limit:10},{id:2,name:'Alpha',limit:10},{id:3,name:'Charlie',limit:10}];
    var sampleLatest={1:{low:100,high:130},2:{low:200,high:260},3:{low:50,high:70}};
    var sampleVolume={1:{highPriceVolume:5000,lowPriceVolume:5000},2:{highPriceVolume:5000,lowPriceVolume:5000},3:{highPriceVolume:5000,lowPriceVolume:5000}};
    rows=buildRows(sampleMapping,sampleLatest,sampleVolume,sampleVolume);`);
  const names=()=>Array.from(s.run('filteredRows().map(r=>r.name)'));
  const capitals=()=>Array.from(s.run('filteredRows().map(r=>r.capital)'));
  // Default: untouched, which is the EVI score, best first.
  assert.deepEqual(names(), Array.from(s.run('rows.map(r=>r.name)')), 'the default order is what buildRows ranked');
  s.run(`setSort('name')`);
  assert.deepEqual(names(),['Alpha','Bravo','Charlie'],'text starts A-Z');
  s.run(`setSort('name')`);
  assert.deepEqual(names(),['Charlie','Bravo','Alpha'],'clicking the same column flips it');
  s.run(`setSort('capital')`);
  const desc=capitals();
  assert.deepEqual(desc,[...desc].sort((a,b)=>b-a),'a number column starts high-first');
  s.run(`setSort('capital')`);
  assert.deepEqual(capitals(),[...desc].reverse());
  // A row with no trade history of its own must sink whichever way the column points.
  s.run(`rows[0].hist={trades:3,totalProfit:900,winRate:1,medianHoldH:2};rows[1].hist=null;rows[2].hist=null;`);
  s.run(`setSort('histProfit')`);
  assert.equal(s.run('filteredRows()[0].hist.totalProfit'),900);
  s.run(`setSort('histProfit')`);
  assert.equal(s.run('filteredRows()[0].hist&&filteredRows()[0].hist.totalProfit'),900,'still first: blanks never win by being empty');
});

// The bulk focus in the scanner's own list: the same line the bridge draws (a buy limit of 1,000+).
test('scanner: the bulk focus keeps only items the GE sells by the thousand, and is off by default',()=>{
  const s=scanner();
  s.run(`var sampleMapping=[{id:1,name:'Steel cannonball',limit:11000},{id:2,name:'Twisted horns',limit:5},{id:3,name:'Prayer potion(4)',limit:2000}];
    var sampleLatest={1:{low:100,high:130},2:{low:200,high:260},3:{low:50,high:70}};
    var sampleVolume={1:{highPriceVolume:5000,lowPriceVolume:5000},2:{highPriceVolume:5000,lowPriceVolume:5000},3:{highPriceVolume:5000,lowPriceVolume:5000}};
    rows=buildRows(sampleMapping,sampleLatest,sampleVolume,sampleVolume);`);
  const names=()=>Array.from(s.run('filteredRows().map(r=>r.name)')).sort();
  const all=names();
  assert.ok(all.length>=2,'without the focus every eligible row shows');
  s.element('focusPick').value='bulk';
  const bulk=names();
  assert.ok(!bulk.includes('Twisted horns'),'gear with a buy limit of 5 is left out');
  assert.ok(bulk.every(n=>n==='Steel cannonball'||n==='Prayer potion(4)'),'only items bought by the thousand remain: '+bulk);
  s.element('focusPick').value='gear';
  const gear=names();
  assert.ok(gear.every(n=>n==='Twisted horns'),'gear keeps only the small-limit items: '+gear);
});

// The drawer's two break-even numbers decide whether a trade is worth placing at all, so they are
// checked against the scanner's own tax function rather than against a flat 2%: the Grand Exchange
// tax is floored per unit and capped, so rate arithmetic is wrong at both ends of the price range.
test("break-even sell price is the lowest price that actually clears the purchase",()=>{
  const s=scanner();
  for(const buy of [1,57,999,100000,1000000,19425332,600000000]){
    const min=s.run('minSellForBreakEven('+buy+')');
    assert.ok(Number.isFinite(min),'a break-even price must exist for '+buy);
    const net=s.run('(function(x){return x-geTax(x);})('+min+')');
    assert.ok(net>=buy,'selling at '+min+' must cover '+buy+', got '+net);
    const below=s.run('(function(x){return x-geTax(x);})('+(min-1)+')');
    assert.ok(below<buy,'one gp lower must NOT cover '+buy+', so '+min+' is the lowest: '+below);
  }
});
test("the most you can pay is the sale price less its tax, and the two agree with each other",()=>{
  const s=scanner();
  for(const sell of [5000,250000,20767293]){
    const maxBuy=s.run('(function(x){return x-geTax(x);})('+sell+')');
    // Paying exactly that much and selling at this price breaks even, so the minimum sell price
    // computed back from it can never be higher than the price we started with.
    const back=s.run('minSellForBreakEven('+maxBuy+')');
    assert.ok(back<=sell,'round trip must not drift upward: '+maxBuy+' -> '+back+' vs '+sell);
  }
});
test("an item icon is asked of the bridge, never of another host",()=>{
  const s=scanner();
  const html=s.run('iconImg({id:28316,icon:"Bellator ring.png"},28)');
  assert.ok(html.includes('src="/api/icon?itemId=28316"'),html);
  assert.ok(!/https?:/.test(html),'the page may not load an image from another host: '+html);
  assert.ok(html.includes('loading="lazy"'),'icons must not block the list rendering');
  assert.equal(s.run('iconImg({id:1,icon:null},28)'),'','an item with no icon renders nothing at all');
  assert.equal(s.run('iconImg({icon:"x.png"},28)'),'','without an id there is nothing to ask for');
});

// The item's picture belongs between the score and its name, where the eye lands first. Checked on a
// rendered row rather than on the helper alone, because the helper being right is not the same as the
// row carrying it.
test("the icon is rendered in the row, before the item's name",()=>{
  const s=scanner();
  s.run(`history={};feedback={};predictions={};
    const mapping=[{id:4151,name:'Abyssal whip',members:true,limit:70,icon:"Abyssal whip.png"},
      {id:99001,name:'Nameless thing',members:true,limit:70,icon:null}];
    const latest={'4151':{high:1600000,low:1500000,highTime:Math.floor(Date.now()/1000),lowTime:Math.floor(Date.now()/1000)},
      '99001':{high:1600000,low:1500000,highTime:Math.floor(Date.now()/1000),lowTime:Math.floor(Date.now()/1000)}};
    const vol={'4151':{avgHighPrice:1600000,avgLowPrice:1500000,highPriceVolume:400,lowPriceVolume:400},
      '99001':{avgHighPrice:1600000,avgLowPrice:1500000,highPriceVolume:400,lowPriceVolume:400}};
    rows=buildRows(mapping,latest,vol,vol);render();`);
  const body=s.element('#scannerTable tbody').innerHTML;
  assert.ok(body.includes("/api/icon?itemId=4151"),"the row must carry the item image: "+body.slice(0,400));
  const cell=body.slice(body.indexOf('itemcell'));
  assert.ok(cell.indexOf('<img')<cell.indexOf('Abyssal whip'),'the picture comes before the name');
  assert.ok(body.includes('data-id="4151"'),'each row identifies its item so a click can open it');
  // An item the wiki has no picture for still renders, just without one.
  assert.ok(body.includes('Nameless thing'),'a missing icon must not drop the row');
});
