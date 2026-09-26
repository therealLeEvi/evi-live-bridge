import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {createMarketCache} from './marketCache.mjs';
import {createIconCache} from './icons.mjs';
import {parseLog,buildOffers,flipsFrom,summarise,resolveLogFile} from './exchangeLog.mjs';
import {computeSuggestion,computeMarketSuggestion,computeHoldingSuggestion,computeInventorySuggestion,computePushedSuggestion,pickPersistentOpenPosition,lookupItemPrice,forecastFromSeries,timestepForHorizon,pickWithForecast,estimateOfferFill,estimateVolatility,marginClearsCushion,slotCapacity,slotNote,slotExposure,withCostBasis,heldCostBasis,sellPriceSupport,sellSupportNote,mergeArchiveHours,SELL_SUPPORT_HOURS,limitAllowance,BULK_MIN_LIMIT,FOCUSES,focusAllows,resolveFocus} from './suggestions.mjs';
import {estimateUnitTax} from './tax.mjs';
import {createSuggestionLog,checksOf} from './suggestionLog.mjs';
import {joinSuggestionOutcomes,summarizeOutcomes} from './suggestionOutcomes.mjs';
import {tradingPeriods} from './tradingPeriods.mjs';
import {createPriceArchive,readArchive} from './priceArchive.mjs';
import {createNewsChains} from './newsChains.mjs';
import {createCorrelationIndex,correlationNote,CORRELATED_THRESHOLD} from './correlation.mjs';
import {buildFillModel,fillChance,fillChanceSentence} from './fillModel.mjs';
import {relistAdvice} from './relist.mjs';
import {sellAdvice} from './sellAdvice.mjs';
import {buyMarginAdvice} from './buyAdvice.mjs';
import {wealthSnapshot,createWealthLog} from './wealth.mjs';
import {goalStatus} from './goal.mjs';
import {userAgent} from './userAgent.mjs';
import {sharePreview} from './sharePreview.mjs';
import {createCrashWatch,crashMessage} from './crashWatch.mjs';
import {buildThinMarketIndex,thinMarketNote,thinMarketContext,windowFor,MIN_HOURS as MIN_ARCHIVE_HOURS} from './thinMarket.mjs';

// How stale a scanner-pushed shortlist (POST /api/scanner-suggestions) can be before GET
// /api/suggestion stops trusting it and falls back to computeMarketSuggestion instead -- roughly
// 3x the scanner's own 60-second auto-refresh interval, generous enough to ride out one missed
// refresh (a slow Wiki API response, a backgrounded tab throttled by the browser) without either
// serving a badly stale pick or flapping between the two sources every request.
const MAX_PUSHED_AGE_MS=180000;
// Caps how many candidates a single scanner push can store, and how large that one request body can
// be -- generous for a real shortlist (the scanner only ever pushes its own top 20, see
// EVI_Flip_Scanner_V3.html's pushSuggestions()) while bounding memory if something misbehaves.
const MAX_PUSHED_ITEMS=50;
// The plugin-bridge API version served by GET /api/version. See that route for when to bump it.
export const BRIDGE_API=1;

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const same=(a,b)=>typeof a==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const login=`<!doctype html><meta charset="utf-8"><title>EVI Live · Unlock</title>
<style>body{background:#0b0f14;color:#eef4fb;font:18px system-ui;max-width:650px;margin:12vh auto;padding:24px}input,button{font:inherit;padding:12px;margin:8px 0}input{width:95%}</style>
<h1>EVI Live</h1><p>Paste the Scanner key shown in the bridge window. Your trade data stays on this computer.</p>
<form id="f"><label>Scanner key<input id="token" type="password" required autocomplete="off"></label><button>Open scanner</button></form><p id="status"></p>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value.trim()})});if(!r.ok)throw Error('Key not accepted');location.replace('/')}catch(e){document.getElementById('status').textContent=e.message}};</script>`;

export function createBridge({dir=path.join(root,'data'),port=51743}={}) {
  fs.mkdirSync(dir,{recursive:true});
  const secretsFile=path.join(dir,'keys.json');
  if(!fs.existsSync(secretsFile))fs.writeFileSync(secretsFile,JSON.stringify({scanner:randomBytes(32).toString('hex'),plugin:randomBytes(32).toString('hex')},null,2),{mode:0o600,flag:'wx'});
  const secrets=JSON.parse(fs.readFileSync(secretsFile,'utf8')),store=new Store(dir),cache=new Map(),suggestionPrices=createMarketCache();
  // Scoring data for future accuracy checks (see suggestionLog.mjs), and the optional, off-by-default
  // hourly Wiki price archive (see priceArchive.mjs). The archive only runs once start() is called,
  // which the standalone entry point below does; tests never start it.
  // Crash alerts (see crashWatch.mjs), fed by the five-minute archive as each bucket is stored, so they
  // cost no requests of their own. Only buckets from the last 45 minutes are fed in: a backfill
  // storing last week's buckets must never read as a crash happening now. Starts with an empty
  // window rather than reading the (large) five-minute files back, so it is fully armed about half an
  // hour after the bridge starts. Every alert start and end is appended to data/crash-log.jsonl.
  const crashLogFile=path.join(dir,'crash-log.jsonl');
  const crashWatch=createCrashWatch({
    loadHourly:from=>readArchive(dir,from,Infinity,'1h'),
    loadFiveMinute:()=>[],
    log:m=>console.error(m),
    record:e=>{try{fs.appendFileSync(crashLogFile,JSON.stringify(e)+'\n');}catch{}},
  });
  const suggestionLog=createSuggestionLog(dir),archive=createPriceArchive({dir,log:m=>console.error(m),
    onStored:(step,bucket)=>{if(step==='5m'&&bucket.ts>=Date.now()/1000-45*60)crashWatch.addFiveMinute(bucket);}});
  // News-to-item linkage (see newsChains.mjs / newsChain.mjs). Reads the mapping and volume caches
  // this server already keeps, so it costs no extra price fetches -- only wiki lookups, which are
  // cached per post on disk and walked in the background, never during a request. Volumes are only
  // consulted when this server has already fetched them for something else; unknown volume never
  // filters a chain out, the same fail-open rule used everywhere else here.
  const newsChains=createNewsChains({dir,log:m=>console.error(m),
    itemIndexByName:name=>mappingCache.byName?.get(String(name).toLowerCase())||null,
    volumeOf:id=>{
      const v=lastVolumes?.[String(id)];
      return v?Math.min(v.highPriceVolume||0,v.lowPriceVolume||0):null;
    }});
  // The player's own fill record (see fillModel.mjs), rebuilt at most hourly and only from the
  // archived hours their own offers actually fall in -- reading 90 days of archive on every
  // suggestion would be absurd. Never fatal: any failure just means suggestions carry no fill
  // sentence, exactly as before this existed.
  // Per-pair price correlation from the archive (see correlation.mjs), rebuilt at most hourly like
  // the fill model beside it and for the same reason: reading 90 days of archive on every
  // suggestion would be absurd. Six-hourly steps, because the same measurement showed hourly
  // returns are pure noise. Never fatal -- any failure just means no correlation check, exactly as
  // before this existed.
  let correlationCache={at:0,index:null};
  function correlationIndex(now=Date.now()) {
    if(correlationCache.index && now-correlationCache.at<3600000)return correlationCache.index;
    try {
      const buckets=readArchive(dir,Math.floor(now/1000)-90*86400,Infinity,'1h').filter((_,i)=>i%6===0);
      correlationCache={at:now,index:buckets.length>60?createCorrelationIndex(buckets):null};
    } catch { correlationCache={at:now,index:null}; }
    return correlationCache.index;
  }
  // How often each item trades at all, and how often a price of its own came back (see thinMarket.mjs).
  // Built in one pass over a fortnight of archived hours and cached six hours, so a suggestion only does
  // a lookup. Never fatal: any failure simply means no thin-market check, exactly as before it existed.
  // Item pictures, fetched once each and then served from this machine (see icons.mjs). The scanner's
  // own Content-Security-Policy forbids loading them from the wiki directly, which is the rule that
  // keeps EVI free of outbound requests a code reader would have to discover.
  // Where the Exchange Logger plugin and its fork keep their logs. A closed list on purpose: the
  // import reads only from these folders, so no request can ask the bridge to open an arbitrary file.
  const exchangeLogDirs=()=>{
    const home=process.env.USERPROFILE||process.env.HOME||'';
    if(!home)return [];
    return ['exchange-logger','improved-exchange-logger']
      .map(name=>path.join(home,'.runelite',name))
      .filter(p=>{try{return fs.statSync(p).isDirectory();}catch{return false;}});
  };
  // A file the player named, resolved inside one of those folders or not at all. The guard itself
  // lives in exchangeLog.mjs so it can be tested without a disk (see resolveLogFile).
  const exchangeLogFile=name=>resolveLogFile(exchangeLogDirs().map(d=>path.resolve(d)),name,
    full=>{try{return fs.statSync(full).isFile();}catch{return false;}},path.sep);
  let iconMapping={at:0,rows:[]};
  const iconCache=createIconCache({dir,
    mapping:()=>{
      if(mappingCache.list&&mappingCache.list.length)return mappingCache.list;
      if(Date.now()-iconMapping.at<3600000)return iconMapping.rows;
      try {
        const raw=JSON.parse(fs.readFileSync(path.join(dir,'mapping.json'),'utf8'));
        iconMapping={at:Date.now(),rows:Array.isArray(raw)?raw:Object.values(raw)};
      } catch { iconMapping={at:Date.now(),rows:[]}; }
      return iconMapping.rows;
    },
    fetchBuffer:async url=>{
      const res=await fetch(url,{headers:{'User-Agent':userAgent('item icons for the local scanner, cached on disk after the first fetch')}});
      if(!res.ok)throw new Error('the wiki answered '+res.status);
      return Buffer.from(await res.arrayBuffer());
    },
    log:m=>console.error(m)});
  let thinCache={at:0,index:null};
  function thinMarketIndex(now=Date.now()) {
    if(thinCache.index && now-thinCache.at<6*3600000)return thinCache.index;
    try {
      const buckets=readArchive(dir,Math.floor(now/1000)-14*86400,Infinity,'1h');
      thinCache={at:now,index:buckets.length>=MIN_ARCHIVE_HOURS?buildThinMarketIndex(buckets):null};
    } catch(e) { console.error('Thin-market index: '+e.message); thinCache={at:now,index:null}; }
    return thinCache.index;
  }
  let fillModelCache={at:0,model:null};
  let sharePreviewCache={at:0,body:null};
  function playerFillModel(now=Date.now()) {
    if(fillModelCache.model && now-fillModelCache.at<3600000)return fillModelCache.model;
    try {
      const offers=[...store.offers.values()].filter(o=>o.knownStart&&Number.isFinite(o.firstSeen));
      if(!offers.length)return null;
      const from=Math.floor(Math.min(...offers.map(o=>o.firstSeen))/1000)-3600;
      const model=buildFillModel(offers,readArchive(dir,from),{now});
      fillModelCache={at:now,model};
      return model;
    } catch { fillModelCache={at:now,model:null}; return null; }
  }
  // In-memory only, deliberately not journaled to disk -- a bridge restart just means the next
  // scanner auto-refresh (within 60s, if the scanner tab is open) repopulates it. See POST
  // /api/scanner-suggestions and computePushedSuggestion in suggestions.mjs.
  let pushedSuggestions=[],pushedSuggestionsAt=0;
  // Parsed once per mapping refresh (the fetch itself is cached an hour), keyed by identity of the
  // cached text's parse so a refreshed mapping rebuilds it. See itemIndex() in GET /api/suggestion.
  let mappingCache={text:null,list:null,index:null,byName:null};
  // The most recent /1h volumes this server fetched for any reason, so the news-to-item walk can
  // drop chains ending at items nobody trades without ever fetching prices of its own. Null until
  // something else has fetched them, which reads as "unknown" and filters nothing.
  let lastVolumes=null;
  // The plugin's latest inventory confirmation per account (see heldPositions in /api/suggestion).
  // In memory only: it describes the inventory right now, so it is worthless after a restart anyway.
  const inventoryChecks=new Map();
  // What the player owns, over time (see wealth.mjs). Recorded from the plugin's own polls, since those
  // are the only place the coin count is known, at most once every fifteen minutes per account.
  const wealthLog=createWealthLog(dir);
  // The player's own target (see goal.mjs), kept in its own small file so it survives restarts and is
  // trivial to clear by hand. {itemId, quantity} or {gp}; absent until one is set.
  const goalFile=path.join(dir,'goal.json');
  // The player's trading preferences that the bridge applies to every suggestion, chosen in the
  // scanner (see /api/preferences). Kept in their own file so nothing else can overwrite them.
  const preferencesFile=path.join(dir,'preferences.json');
  // blocked: items the player never wants suggested, chosen with the sidebar's Block button instead
  // of typing item IDs into the plugin's blocklist setting (which still works, and is merged in).
  // Realised profit since this moment (ms). Null means "everything EVI has ever matched", which is what
  // a player sees before they ever press Reset.
  function profitSince(now=Date.now()) {
    const since=readPreferences().profitSince;
    const st=store.state(now);
    const flips=[...st.flips.filter(x=>!x.removed),...st.autoFlips].filter(x=>Number.isFinite(x.profit)&&Number.isFinite(x.lastSell));
    const counted=flips.filter(x=>!Number.isFinite(since)||x.lastSell>=since);
    const health=st.dataHealth||{};
    return {since:Number.isFinite(since)?since:null,
      gp:Math.round(counted.reduce((n,x)=>n+x.profit,0)),trades:counted.length,
      winners:counted.filter(x=>x.profit>0).length,losers:counted.filter(x=>x.profit<0).length,
      // Said out loud rather than folded in: sales EVI never matched to a purchase are not profit, and a
      // player comparing this with their own coin count deserves to know the gap exists.
      unmatchedSales:health.unmatchedSales||0,openPositions:health.openPositions||0};
  }
  function resetProfit(now=Date.now()) {
    const p=readPreferences();
    writePreferences({...p,profitSince:now});
    return profitSince(now);
  }
  const readPreferences=()=>{try{const p=JSON.parse(fs.readFileSync(preferencesFile,'utf8'));
    return {focus:FOCUSES.includes(p.focus)?p.focus:'any',blocked:Array.isArray(p.blocked)?p.blocked.filter(id=>Number.isSafeInteger(id)&&id>0):[],
      profitSince:Number.isFinite(p.profitSince)?p.profitSince:null};}
    catch{return {focus:'any',blocked:[],profitSince:null};}};
  const writePreferences=next=>fs.writeFileSync(preferencesFile,JSON.stringify(next));
  // Block or unblock one item. Returns the new list; an unknown or invalid id is refused, never stored.
  function setBlocked(itemId,blocked){
    const id=Number(itemId);
    if(!Number.isSafeInteger(id)||id<=0)throw Error('Invalid itemId');
    const p=readPreferences();
    const set=new Set(p.blocked);
    if(blocked===false)set.delete(id);else set.add(id);
    writePreferences({...p,blocked:[...set].sort((a,b)=>a-b)});
    return [...set];
  }
  const readGoal=()=>{try{return JSON.parse(fs.readFileSync(goalFile,'utf8'));}catch{return null;}};
  // The coin count the plugin last reported, per account, with when it was read. Kept even when it is
  // zero: "you are carrying no coins" is a real reading, and treating it as "not reported" left the
  // wealth view saying it did not know. cashFor falls back to the newest reading across accounts,
  // because the scanner asks without naming one -- looking up its own empty key was why the goal
  // reported an unknown coin count while the player was logged in.
  const lastCash=new Map();
  function cashFor(account) {
    const own=lastCash.get(account||'');
    if(own)return own;
    if(account)return null;
    let newest=null;
    for(const entry of lastCash.values())if(!newest||entry.at>newest.at)newest=entry;
    return newest;
  }
  // Shared by the suggestion ranking and the news-to-item walk, so both read one parsed copy of the
  // item mapping rather than each keeping their own.
  async function itemIndex() {
    const text=await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/mapping',3600000);
    // The market cache hands back the same string for an hour, so this reparses only when the
    // mapping itself was refetched.
    if(mappingCache.text!==text) {
      const list=JSON.parse(text);
      mappingCache={text,list,index:new Map(list.filter(i=>i&&Number.isFinite(i.id)).map(i=>[i.id,i])),
        byName:new Map(list.filter(i=>i&&i.name).map(i=>[String(i.name).toLowerCase(),i]))};
    }
    return mappingCache.index;
  }
  if(!/^[a-f0-9]{64}$/.test(secrets.scanner)||!/^[a-f0-9]{64}$/.test(secrets.plugin))throw Error('Invalid keys.json');
  const origin=`http://127.0.0.1:${port}`;
  const server=http.createServer(async(req,res)=>{
    const send=(status,body,type='application/json')=>{res.writeHead(status,{'Content-Type':type+'; charset=utf-8'});res.end(type==='application/json'?JSON.stringify(body):body);};
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if(req.socket.remoteAddress!=='127.0.0.1'||req.headers.host!==`127.0.0.1:${port}`)return send(403,{error:'Loopback host required'});
      if(req.headers.origin && req.headers.origin!==origin)return send(403,{error:'Origin rejected'});
      const url=new URL(req.url,origin),pathname=url.pathname;
      if(req.headers['sec-fetch-site']==='cross-site') {
        // Opening a link from the setup file/chat is a legitimate navigation.
        // Only expose the public unlock page; never private data or API access.
        if(req.method==='GET' && pathname==='/' && req.headers['sec-fetch-mode']==='navigate' && req.headers['sec-fetch-dest']==='document')return send(200,login,'text/html');
        return send(403,{error:'Cross-site request rejected'});
      }
      const cookie=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('evi='))?.slice(4);
      const ui=same(cookie,secrets.scanner);
      const body=async()=>{
        // Media type only: a Content-Type may legitimately carry parameters, and an exact-match
        // check rejected "application/json; charset=utf-8" with a 400 -- which is exactly what
        // OkHttp sends for a string body, and what broke every observation the moment the plugin
        // moved to RuneLite's HTTP client. Still strict about the type itself.
        if((req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')throw Error('JSON required');
        let n=0;const chunks=[];
        for await(const chunk of req){n+=chunk.length;if(n>32768)throw Error('Request too large');chunks.push(chunk);}
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      };
      if(pathname==='/api/unlock'&&req.method==='POST') {
        if(req.headers.origin!==origin)return send(403,{error:'Origin required'});
        if(!same((await body()).token,secrets.scanner))return send(401,{error:'Wrong key'});
        res.setHeader('Set-Cookie',`evi=${secrets.scanner}; HttpOnly; SameSite=Strict; Path=/`);return send(200,{ok:true});
      }
      if(pathname==='/api/events'&&req.method==='POST') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        return send(200,store.ingest(await body()));
      }
      // The plugin's own "I don't have this anymore" button (EviLivePlugin.flagNotHeld), the
      // in-game counterpart of the scanner's "Still held" close buttons -- same Store.closePosition,
      // same journal record, just reachable with the plugin key instead of the scanner cookie, so a
      // stale holding reminder can be dismissed for good without opening the browser.
      if(pathname==='/api/suggestion/not-held'&&req.method==='POST') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        const b=await body();
        return send(200,store.closePosition({buyId:b.buyId,reason:b.reason==='used'?'used':'sold-untracked'}));
      }
      // The sidebar's "Reset" next to its profit line: start counting realised profit from now.
      if(pathname==='/api/profit/reset'&&req.method==='POST') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        return send(200,{ok:true,profit:resetProfit()});
      }
      // The sidebar's Block button: never suggest this item again. Plugin key, like the other buttons;
      // undone from the scanner, which lists blocked items by name.
      if(pathname==='/api/suggestion/block'&&req.method==='POST') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        const b=await body();
        return send(200,{ok:true,blocked:setBlocked(b.itemId,b.blocked===undefined?true:b.blocked)});
      }
      if(pathname==='/api/suggestion/personal-use'&&req.method==='POST') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        const b=await body();
        const personal=b.personal===undefined?true:b.personal;
        // An idle-inventory suggestion has no buy behind it (EVI never saw the item bought), so the
        // button sends the item instead and the exclusion is keyed by item. See markPersonalUseItem.
        if(b.buyId===undefined||b.buyId===null)return send(200,store.markPersonalUseItem({itemId:b.itemId,personal}));
        return send(200,store.markPersonalUse({buyId:b.buyId,personal}));
      }
      // Which version of the plugin-bridge API this bridge speaks. The plugin and the bridge are
      // updated separately (one through the Plugin Hub, the other by hand), so a future plugin that
      // needs something new can ask this first and tell the player plainly to update the bridge,
      // instead of failing with a bare HTTP error. A bridge from before this existed answers 401 here
      // (the route falls through to the scanner gate), which a plugin should read as API 0. Bump
      // BRIDGE_API only when the plugin-facing endpoints change in a way a plugin must know about;
      // the event packet's own version field (validatePacket) is separate and unchanged.
      if(pathname==='/api/version'&&req.method==='GET') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        return send(200,{api:BRIDGE_API,packet:1});
      }
      if(pathname==='/api/suggestion'&&req.method==='GET') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        try {
          const text=await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/latest',60000);
          const latest=JSON.parse(text).data||{};
          // Optional per-request tuning from the plugin's own config (min predicted profit, an item
          // blocklist, a risk tier); all default to the original unfiltered/medium behaviour.
          // A player who has set no minimum has not asked to be offered anything at all. On
          // 26 Sept EVI suggested 81 gold necklaces on a 53k stack: 324 gp of gross margin, of
          // which the Grand Exchange tax took 243, leaving **81 gp** for a slot and the attention.
          // Measured against the 74 real suggestions ever made with no minimum set, whose median
          // nets 28,208 gp, a 500 gp floor removes 8% of them -- exactly that tail and nothing a
          // player would miss. Deliberately a small flat figure rather than a share of the cash
          // stack: a share was measured too and would have dropped 71% of the same suggestions,
          // because it scales with capital while the absurdity does not.
          //
          // This is the one flat cutoff in EVI, and it exists only where the player expressed no
          // preference. Anyone who genuinely wants those trades -- the thin-margin, high-volume
          // flipping a small stack may depend on -- sends minProfit=1, which is honoured as
          // "no minimum at all" and turns this off. See MinProfitTier.NONE in the plugin.
          const AUTO_MIN_PROFIT=500;
          const askedFor=Math.max(0,Number(url.searchParams.get('minProfit'))||0);
          const minProfitChosen=askedFor>0;
          const minProfit=minProfitChosen?askedFor:AUTO_MIN_PROFIT;
          const blocklist=new Set((url.searchParams.get('blocklist')||'').split(',').map(s=>parseInt(s,10)).filter(Number.isFinite));
          // Session-only exclusions from the plugin, not a config setting: items already occupying
          // an active/uncollected GE slot (so the same item isn't suggested again right after you've
          // acted on it) and items the player manually skipped via the sidebar. Folded straight into
          // the same blocklist set the ranking already respects -- no separate exclusion path needed.
          for(const id of (url.searchParams.get('exclude')||'').split(',').map(s=>parseInt(s,10)).filter(Number.isFinite))blocklist.add(id);
          const riskParam=url.searchParams.get('risk');
          // Low is the default: replaying the real personal ranking over 90 days, the old Medium default
          // showed no edge over picking an eligible item at random, because a single lucky flip could
          // carry an item (Dragon pickaxe was chosen in 44 of 83 decisions on one imported +1.9m flip,
          // the same pattern as the chestplate loss). Low -- 3+ trades and a 75% win rate required --
          // did best on every risk measure: 87% won, 24% of capital stuck, worst trade -167,518. The
          // plugin sends Medium explicitly now, so choosing it still means Medium.
          const risk=['low','medium','high'].includes(riskParam)?riskParam:'low';
          // The player's actual current cash stack, read from their inventory's coins by the plugin
          // (never assumed) -- caps and re-ranks suggestions so a trade too big to afford right now
          // is never suggested. Omitted entirely when the plugin hasn't observed it yet (e.g. just
          // logged in), which behaves exactly as before this existed.
          const cashParam=Number(url.searchParams.get('cash'));
          const maxSpend=Number.isFinite(cashParam)&&cashParam>0?cashParam:undefined;
          // The player's own preferred trade length (a plugin config setting, e.g. "~10 minutes"),
          // checked against the Wiki's /1h recent-volume data -- fetched here (once, cached 60s,
          // shared with the market fallback below and the existing /api/market/1h proxy) only when
          // a duration preference is actually set, so leaving it at "no preference" costs nothing
          // extra. See estimatedFillMinutes in suggestions.mjs for what this estimate is (and isn't).
          const durationParam=Number(url.searchParams.get('duration'));
          const targetDurationMinutes=Number.isFinite(durationParam)&&durationParam>0?durationParam:undefined;
          // Fetched on every request now, not only when a trade duration is set: the volume-share
          // cap and the player's own fill record both need it. Cached for 60 seconds and shared with
          // every other market route here, so it costs at most one upstream call a minute.
          const volumes=await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/1h',60000)
            .then(t=>JSON.parse(t).data||{}).catch(()=>undefined);
          if(volumes)lastVolumes=volumes;
          // Price-direction forecast for a "buy" suggestion only (see ForecastHorizon/ForecastPolicy
          // on the plugin side). forecastHorizon is null -- meaning skip this entirely, no extra
          // Wiki calls, no change to reasoning -- unless the plugin's own config turned it on. The
          // actual decision logic (keep vs. retry the next-best candidate) lives in suggestions.mjs's
          // pickWithForecast, used below for both the personal-history and market-wide tiers.
          const forecastParam=url.searchParams.get('forecast');
          const forecastHorizon=['1h','6h','overnight'].includes(forecastParam)?forecastParam:null;
          const forecastPolicy=url.searchParams.get('onForecast')==='skip'?'skip':'warn';
          // Fetches the matching Wiki /timeseries window (cached 60s, same cache every other market
          // route here shares) and runs it through the same forecastFromSeries model the scanner's
          // Predict button uses. Never throws -- a network hiccup or missing data just means no
          // forecast gets attached, the same as if forecasting were off for that one call.
          async function forecastForSuggestion(itemId) {
            const timestep=timestepForHorizon(forecastHorizon);
            if(!timestep)return null;
            try {
              const url2=`https://prices.runescape.wiki/api/v1/osrs/timeseries?id=${itemId}&timestep=${timestep}`;
              const series=JSON.parse(await suggestionPrices.get(url2,60000)).data||[];
              return forecastFromSeries(series,forecastHorizon);
            } catch { return null; }
          }
          // Opt-in pre-buy safety check for a "buy" suggestion only (EviLiveConfig.marginSafetyCushion(),
          // off by default -- see marginSafetyCushion's doc on the plugin side for why). Fetches a
          // fine-grained (5-minute) Wiki /timeseries window for the one candidate actually picked
          // (cached 60s, same cache/URL shape as forecastForSuggestion above -- a request with both
          // forecast and cushion on for the same item reuses one cached fetch, not two), and compares
          // the candidate's own predicted per-unit margin against that item's own recent price
          // volatility via marginClearsCushion. Never throws and never blocks on missing/insufficient
          // data -- a network hiccup or a thinly-traded item with too little history just means this
          // candidate is kept with no note, exactly as if the cushion check were off for it.
          // Two safety gates every tier below shares, both fail-open (see gateCandidate in
          // suggestions.mjs). They need the item mapping, which is cached an hour by the same market
          // cache everything else here uses and parsed at most once an hour (parsing ~4,000 items on
          // every 2-second poll would be pure waste).
          //
          // members: sent by the plugin as 1/0 from the world it's actually logged into. A
          // members-only item cannot be traded at all on a free-to-play world, so suggesting one
          // there wastes the player's time. Absent (e.g. before login) means no filtering.
          const membersParam=url.searchParams.get('members');
          const freeToPlayWorld=membersParam==='0';
          const account=url.searchParams.get('account')||undefined;

          // Only built when something could actually use them: a free-to-play world needs the
          // members flag, and the buy-limit check needs to know whose journal to read.
          let membersBlocked, limitFor, focusBlocked;
          // The plugin's own "Suggestion focus" setting wins when it names one; its default ("Same as
          // scanner") sends nothing, and then the scanner's stored Focus switch applies.
          const focusParam=url.searchParams.get('focus');
          const focus=resolveFocus(focusParam,readPreferences().focus);
          if(freeToPlayWorld||account||focus!=='any') {
            const index=await itemIndex();
            // Gear or bulk focus, by the item's own buy limit (see focusAllows).
            if(focus!=='any')focusBlocked=itemId=>!focusAllows(focus,index.get(itemId)?.limit);
            if(freeToPlayWorld)membersBlocked=itemId=>index.get(itemId)?.members===true;
            if(account)limitFor=itemId=>{
              const limit=index.get(itemId)?.limit;
              if(!Number.isFinite(limit)||limit<=0)return null; // unknown limit: no constraint
              const {used,windowEndsAt}=store.buyLimitUsage(account,itemId);
              // Across the player's own trade duration, not just the window running now: a 12-hour
              // trade spans three buy-limit windows (see limitAllowance).
              return {limit,remaining:limitAllowance({limit,used,windowEndsAt,targetDurationMinutes})};
            };
          }
          const gates={membersBlocked,limitFor,focusBlocked};
          // How much of the cash stack one market-wide suggestion may commit, as a percentage
          // (EviLiveConfig.maxTradeShare, default 25). Only meaningful alongside a known cash stack,
          // and only applied to the market-wide tier -- a suggestion from the player's own history
          // keeps the size that history implies. See MaxTradeShare.java for the backtest behind it.
          const stackShareParam=Number(url.searchParams.get('stackShare'));
          const maxStackShare=Number.isFinite(stackShareParam)&&stackShareParam>0&&stackShareParam<=100?stackShareParam/100:undefined;
          // Starter profile (EviLiveConfig.tradingProfile): market-wide picks restricted to items the
          // GE charges no tax on. See TradingProfile.java for the backtest behind it.
          const taxFreeOnly=url.searchParams.get('profile')==='starter';
          const requireCushion=url.searchParams.get('cushion')==='1';
          async function cushionForSuggestion(candidate) {
            try {
              const url2=`https://prices.runescape.wiki/api/v1/osrs/timeseries?id=${candidate.itemId}&timestep=5m`;
              const series=JSON.parse(await suggestionPrices.get(url2,60000)).data||[];
              const volEstimate=estimateVolatility(series);
              if(!volEstimate)return null;
              const tax=estimateUnitTax(candidate.itemId,candidate.sellPrice);
              const marginPerUnit=candidate.sellPrice-candidate.buyPrice-tax;
              const {blocked,noiseGp}=marginClearsCushion(marginPerUnit,candidate.sellPrice,volEstimate);
              if(blocked)return {blocked:true};
              return noiseGp!=null?{blocked:false,note:`Margin also clears this item's own recent price wobble (~${Math.round(noiseGp).toLocaleString()} gp) with room to spare -- not a guarantee, just a sanity check against its own recent volatility.`}:null;
            } catch { return null; }
          }
          // Takes priority over everything below: an item the plugin has observed the player
          // already bought and collected this session, still sitting unsold. See
          // computeHoldingSuggestion in suggestions.mjs -- returns null (falls through to the
          // normal ranking) when nothing is being held or its price isn't available right now.
          // holdBuyPrice (the real average price this was actually bought at, when the plugin
          // knows it) is what lets that reminder say whether selling right now is a profit or a
          // loss, instead of a plain "sell near X gp" that reads the same either way.
          // How much room the Grand Exchange itself has right now, as counted by the plugin from the
          // 8 real slots (see EviLivePlugin's freeSlots/collectableSlots). OSRS allows 8 simultaneous
          // offers and no more, so with every slot occupied and nothing finished waiting to be
          // collected, there is nowhere to put anything EVI might rank -- it stops ranking and says
          // so, rather than suggesting a trade the player cannot place.
          //
          // A slot holding a finished offer is deliberately NOT treated as no room: collecting it is
          // one click, so ranking continues and the suggestion simply carries a note to collect
          // first. Same for an absent/unparseable count, which means the plugin hasn't established a
          // slot snapshot yet -- unknown never invents a constraint here, exactly like cash= and
          // members=.
          const capacity=slotCapacity(url.searchParams.get('freeSlots'),url.searchParams.get('collectable'));
          const geFull=capacity.full;
          // Stock with nowhere to sell from is how capital gets stuck -- the backtests traced stuck
          // capital to the sell side. So a new BUY is held back while the free slots are only enough
          // for the exits already owed. What counts as owed is the subtle part and was wrong once:
          // see slotExposure in suggestions.mjs. Only stock sitting in the inventory with no slot at
          // all owes an exit; a buy still in a slot vacates that slot for its own sell.
          //
          // Counted, never a fixed fraction of the Grand Exchange. Sell-side suggestions are
          // unaffected -- they are what the reserve exists for -- and an unknown slot count reserves
          // nothing at all.
          // Candidates set aside for a stated reason, so the response can say which -- distinct from
          // nothing being eligible at all.
          const heldBack=[];
          // Where a buy may come from (see SuggestionSource in the plugin). The default, "history",
          // is what EVI has always done: the player's own history first, the market only if that had
          // nothing. "market" skips the history tier; "both" ranks them together and keeps whichever
          // is actually worth more, so a one-flip history can no longer veto a better market trade.
          const sourceParam=url.searchParams.get('source');
          const wantSource=sourceParam==='market'||sourceParam==='both'?sourceParam:'history';
          // Set when the player's own history did have something but it fell under the floor above,
          // so the answer that comes back is a market-wide pick instead. The player asked to be told
          // that in so many words rather than quietly handed a different kind of suggestion.
          let fellThroughFromHistory=null;
          // The best profit available with this cash stack when the player's minimum filtered
          // everything out -- null whenever there is a suggestion, or no minimum, or nothing at all.
          let reachable=null;
          // Buy picks the sell-support check pushed down on this poll, whichever pick ended up shown.
          const demotedPicks=[];
          const onDemoted=p=>demotedPicks.push({itemId:p.itemId,name:p.name,buyPrice:p.buyPrice,sellPrice:p.sellPrice,sellSupport:checksOf(p).sellSupport});
          // Does a buy's margin survive at what buyers have actually been paying (see sellPriceSupport)?
          // Passed into the ranking so a failing pick is demoted below the next candidates rather than
          // merely labelled -- see pickWithForecast. From the Wiki's hourly history for this one item,
          // so it works for every player with or without the archive, cached ten minutes so a pick that
          // stays on screen costs one fetch rather than one per poll. The warning goes FIRST in the
          // reasoning, since it is the one thing there saying the trade itself may not work. A failed
          // fetch means no view, which demotes nothing -- fail open, like every other check here.
          async function supportForSuggestion(candidate) {
            // A pick that is crashing right now is demoted with the crash alert as its warning,
            // before any other reading: its recent average says nothing about where it is heading.
            const crashing=crashWatch.isCrashing(candidate.itemId);
            if(crashing)return {warning:'Warning: '+crashMessage(crashing,{name:candidate.name}),
              detail:{supported:false,units:null,hours:null,averagePaid:null,netAtAverage:null,crashing:true}};
            // Can this price even be bought again? EVI quotes the last price sellers accepted, and on an
            // item that trades a handful of hours a week that price may never come back -- measured at 7%
            // within 4 hours for the Berserker icon that prompted this. Checked before the sell-support
            // reading because there is no point judging the exit on a trade that cannot be entered.
            try {
              const thin=thinMarketIndex();
              const note=thin&&thinMarketNote(thin.byItem.get(candidate.itemId),
                {name:candidate.name,windowHours:windowFor(targetDurationMinutes),quantity:candidate.quantity,archivedHours:thin.hours});
              if(note)return {warning:note,
                detail:{supported:false,units:null,hours:null,averagePaid:null,netAtAverage:null,thinMarket:true}};
            } catch {}
            try {
              // The Wiki's per-item series lags by about an hour, so the archive's hours are merged
              // in (see mergeArchiveHours). If the series cannot be fetched, the archive alone is
              // used only when it covers every hour of the window; otherwise there is no reading.
              const from=Math.floor(Date.now()/3600000)*3600-SELL_SUPPORT_HOURS*3600;
              let archived=[];
              try { archived=archive.recentHourly(from); } catch {}
              let series=null;
              try { series=JSON.parse(await suggestionPrices.get(`https://prices.runescape.wiki/api/v1/osrs/timeseries?id=${candidate.itemId}&timestep=1h`,600000)).data||[]; } catch {}
              if(!series && archived.length<SELL_SUPPORT_HOURS)return null;
              const detail=sellPriceSupport(mergeArchiveHours(series||[],archived,candidate.itemId),candidate.itemId,candidate.buyPrice);
              const warning=sellSupportNote(detail,candidate.sellPrice);
              // A minimum profit is meant to mean "do not show me trades smaller than this", and the
              // quoted spread is the wrong thing to measure it against. On 26 Sept an Uncharged toxic
              // trident (e) was suggested at a quoted 1,300,613 gp against a 1m minimum, while over the
              // previous 12 hours 37 buyers had paid an average of 5,438,710 -- at which the trade is
              // worth 64,559, twenty times less, and would never have cleared that minimum. So where
              // there IS a reading, the minimum is applied to it instead. Only when the player set one
              // themselves: with no minimum there is nothing to fail, and this stays a plain warning.
              if(detail&&Number.isFinite(detail.netAtAverage)&&minProfitChosen) {
                const qty=candidate.quantity||1;
                const supportedTotal=detail.netAtAverage*qty;
                if(supportedTotal<minProfit) {
                  const quoted=Math.round((candidate.sellPrice-estimateUnitTax(candidate.itemId,candidate.sellPrice)-candidate.buyPrice)*qty);
                  const gp=n=>Math.round(n).toLocaleString("en-US");
                  return {warning:"Warning: below your "+gp(minProfit)+" gp minimum at the price buyers are actually paying. "
                      +"The quoted spread makes this look like "+gp(quoted)+" gp, but over the last "+detail.hours
                      +" hours "+detail.units+" buyers paid an average of "+gp(detail.averagePaid)
                      +" gp, which makes it about "+gp(supportedTotal)+" gp.",
                    detail:{...detail,belowMinimumAtSupportedPrice:true}};
                }
              }
              return warning?{warning,detail}:null;
            } catch { return null; }
          }
          // Holding both halves of a correlated pair is closer to one larger position than two
          // trades. Compares the candidate against every item currently held or being bought, using
          // measured price correlation (see correlation.mjs); null -- no archive, too little shared
          // history, or nothing held -- never blocks anything.
          // What a candidate is really worth, for comparing one tier against another: the margin at
          // the price buyers have actually been paying over the last 12 hours, or the quoted spread
          // when there is no reading. Same data and same cache as the sell-support check above.
          async function worthOf(candidate) {
            const qty=candidate.quantity||1;
            const quoted=(candidate.sellPrice-estimateUnitTax(candidate.itemId,candidate.sellPrice)-candidate.buyPrice)*qty;
            try {
              const from=Math.floor(Date.now()/3600000)*3600-SELL_SUPPORT_HOURS*3600;
              let archived=[];
              try { archived=archive.recentHourly(from); } catch {}
              let series=null;
              try { series=JSON.parse(await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/timeseries?id='+candidate.itemId+'&timestep=1h',600000)).data||[]; } catch {}
              if(!series && archived.length<SELL_SUPPORT_HOURS)return {value:quoted,quoted,supported:null};
              const detail=sellPriceSupport(mergeArchiveHours(series||[],archived,candidate.itemId),candidate.itemId,candidate.buyPrice);
              if(detail&&Number.isFinite(detail.netAtAverage))
                return {value:detail.netAtAverage*qty,quoted,supported:Math.round(detail.netAtAverage*qty)};
            } catch {}
            return {value:quoted,quoted,supported:null};
          }
          async function correlationForSuggestion(candidate) {
            try {
              if(!candidate||candidate.action!=='buy')return null;
              const index=correlationIndex();
              if(!index)return null;
              const held=[...exposure].filter(id=>id!==candidate.itemId);
              if(!held.length)return null;
              const hit=index.strongestAgainst(candidate.itemId,held);
              if(!hit||hit.correlation<CORRELATED_THRESHOLD)return null;
              await itemIndex().catch(()=>{});
              return {blocked:true,note:correlationNote(hit,id=>mappingCache.index?.get(id)?.name)};
            } catch { return null; }
          }
          const accountState=store.state();
          // Only positions the plugin has CONFIRMED are in the inventory right now count. The journal
          // alone is not enough: it only sees the Grand Exchange, so stock sold, used or dropped
          // outside it stays "held" forever -- reported live, when two long-gone positions (adamant
          // darts, adamant keel parts) reserved the last two slots. The plugin already verifies
          // persisted holdings against its inventory snapshot the same way.
          //
          // The exchange is deliberately one-sided: the bridge names the items its journal believes
          // are held (positionItems, in the response), and the plugin echoes back only those that
          // are really there (heldPositions=). No inventory contents reach the bridge beyond items
          // it already knew about. With no confirmation at all -- an older plugin, or before the
          // inventory has loaded -- nothing is verified and nothing is reserved, which is the
          // fail-open direction: an unconfirmed position never invents a constraint.
          const accountPositions=(accountState.autoOpenPositions||[]).filter(p=>!account||p.account===account);
          const confirmedHeld=new Set((url.searchParams.get('heldPositions')||'').split(',').map(s=>parseInt(s,10)).filter(Number.isInteger));
          const positionItems=[...new Set(accountPositions.map(p=>p.itemId))].sort((a,b)=>a-b);
          // Remembered for the scanner's data-health line (see /api/state): which of this account's
          // held positions the plugin actually found in the inventory, and when. Presence of the
          // parameter, even empty, is what says a check happened -- "checked, found none" is the most
          // useful answer of all, since it is what exposes a stale position.
          if(url.searchParams.has('heldPositions'))
            inventoryChecks.set(account||'',{account:account||null,at:Date.now(),confirmed:[...confirmedHeld]});
          const {exposure,sellSlotsOwed}=slotExposure(accountPositions.filter(p=>confirmedHeld.has(p.itemId)),accountState.occupied,account);
          const buysHeldForExits=capacity.free!==null&&!geFull&&capacity.free<=sellSlotsOwed;
          const holdBuyPriceParam=Number(url.searchParams.get('holdBuyPrice'));
          const holdBuyPrice=Number.isFinite(holdBuyPriceParam)&&holdBuyPriceParam>0?holdBuyPriceParam:undefined;
          let suggestion=geFull?null:computeHoldingSuggestion(latest,Number(url.searchParams.get('holdItemId')),Number(url.searchParams.get('holdQty')),url.searchParams.get('holdName')||undefined,url.searchParams.get('holdBuyId')||undefined,holdBuyPrice);
          // The live signal above is necessarily empty right after a RuneLite/plugin restart --
          // it only refills by observing a fresh buy-collect this session. Falls back to the
          // bridge's own persistent, on-disk record of open positions (survives any restart,
          // covers a suggested or an unsuggested buy alike) so a position from an earlier session
          // still gets reminded about instead of silently forgotten. See pickPersistentOpenPosition
          // in suggestions.mjs.
          const state=store.state();
          if(!suggestion && !geFull) {
            const openPosition=pickPersistentOpenPosition(state.autoOpenPositions,account,blocklist);
            if(openPosition) {
              suggestion=computeHoldingSuggestion(latest,openPosition.itemId,openPosition.remaining,openPosition.item,openPosition.buyId,openPosition.unitCost);
              // Marks this specifically as a reconstruction from the journal, not something the
              // plugin actually watched happen this session -- the plugin checks the player's real
              // current inventory before trusting it, and quietly excludes+retries (like a manual
              // skip) when the item genuinely isn't there. See pickPersistentOpenPosition's own doc
              // in suggestions.mjs for why that check exists.
              if(suggestion)suggestion.persisted=true;
            }
          }
          // Only reached when there's no live or persisted holding to remind about, and only when
          // the plugin's own config opted in (EviLiveConfig.suggestIdleInventory()): a scan of the
          // player's actual current inventory for anything with meaningful GE value and no
          // observed buy behind it at all -- see computeInventorySuggestion in suggestions.mjs for
          // why this exists (it's the fallback for exactly the "bought outside any tracked GE buy,
          // so nothing above ever notices it" gap). Outranks computeSuggestion/computeMarketSuggestion
          // below on the same "something you're already holding beats starting something brand new"
          // principle as the holding checks above it. The blocklist used here additionally excludes
          // every item behind a personal-use-flagged buy (state.personalUseItemIds) -- kept local to
          // this call only, never merged into the shared `blocklist` used by the ranking functions
          // below, since personal-use on one past purchase must never block a genuinely new flip of
          // the same item.
          if(!suggestion && !geFull && url.searchParams.get('includeInventory')==='1') {
            const inventory={};
            for(const pair of (url.searchParams.get('inventory')||'').split(',')) {
              const [idPart,qtyPart]=pair.split(':');
              const itemId=parseInt(idPart,10),qty=parseInt(qtyPart,10);
              if(Number.isFinite(itemId)&&itemId>0&&Number.isFinite(qty)&&qty>0)inventory[itemId]=qty;
            }
            if(Object.keys(inventory).length) {
              await itemIndex();
              const inventoryBlocklist=new Set([...blocklist,...(state.personalUseItemIds||[])]);
              suggestion=computeInventorySuggestion(latest,inventory,mappingCache.list,{blocklist:inventoryBlocklist,membersBlocked});
            }
          }
          // Items blocked with the sidebar's Block button (see setBlocked) are never suggested to BUY
          // again -- added here, after the sell-side tiers above, on purpose: stock the player already
          // holds of a blocked item still gets its sell reminder, because going quiet about something
          // they own is how GP ends up stuck. The plugin's own ID blocklist setting keeps its older,
          // broader behaviour.
          for(const id of readPreferences().blocked)blocklist.add(id);
          // Both ranking tiers below produce BUY suggestions, so both are held back while the free
          // slots are only enough for the exits already owed. The holding, persisted and inventory
          // tiers above are sell-side reminders and deliberately still run.
          if(!suggestion && !geFull && !buysHeldForExits && wantSource!=='market') {
            suggestion=await pickWithForecast({
              // Imported flips rank alongside observed ones (see Store.importFlips): a player who
              // tracked trades elsewhere for months shouldn't be ranked as if they had no history.
              rank:bl=>computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),{minProfit,blocklist:bl,risk,maxSpend,targetDurationMinutes,volumes,maxStackShare,...gates}),
              forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,
              cushionFor:cushionForSuggestion,requireCushion,correlationFor:correlationForSuggestion,supportFor:supportForSuggestion,blocklist,
              onBlocked:rows=>{heldBack.push(...rows);},onDemoted,
            });
          }
          // Only reached when personal history has nothing eligible right now, and only when the
          // plugin's own config opted in: an item-catalogue-wide fallback, not gated on any
          // reviewed flip for that item. Prefers a recent scanner-pushed shortlist (richer -- price
          // history, liquidity, this account's own trades, see computePushedSuggestion) when one's
          // available and not stale; otherwise falls back to computeMarketSuggestion exactly as
          // before scanner-pushing existed, so a plugin user who never opens the scanner sees no
          // change and pays no extra mapping/volume fetch for a tier that will just fall through.
          // With "both", the history pick is set aside here and compared against the market pick
          // below, rather than ending the search. Its own checks have already run on it.
          const historyPick=wantSource==='both'?suggestion:null;
          if(historyPick)suggestion=null;
          if(!suggestion && !geFull && !buysHeldForExits && url.searchParams.get('includeMarket')==='1') {
            const pushedFresh=pushedSuggestions.length && (Date.now()-pushedSuggestionsAt)<=MAX_PUSHED_AGE_MS;
            let rank,rankWithoutMinimum;
            if(pushedFresh) {
              rank=bl=>computePushedSuggestion(pushedSuggestions,{minProfit,blocklist:bl,maxSpend,volumes,targetDurationMinutes,...gates});
              rankWithoutMinimum=bl=>computePushedSuggestion(pushedSuggestions,{minProfit:0,blocklist:bl,maxSpend,volumes,targetDurationMinutes,...gates});
            } else {
              const [,marketVolumes]=await Promise.all([
                itemIndex(),
                volumes?Promise.resolve(volumes):suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/1h',60000).then(t=>JSON.parse(t).data||{}),
              ]);
              rank=bl=>computeMarketSuggestion(mappingCache.list,latest,marketVolumes,{minProfit,blocklist:bl,maxSpend,targetDurationMinutes,maxStackShare,taxFreeOnly,...gates});
              rankWithoutMinimum=bl=>computeMarketSuggestion(mappingCache.list,latest,marketVolumes,{minProfit:0,blocklist:bl,maxSpend,targetDurationMinutes,maxStackShare,taxFreeOnly,...gates});
            }
            suggestion=await pickWithForecast({rank,forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,
              cushionFor:cushionForSuggestion,requireCushion,correlationFor:correlationForSuggestion,supportFor:supportForSuggestion,blocklist,onBlocked:rows=>{heldBack.push(...rows);},onDemoted});
            // Say so when the reason the player's own history was passed over is the floor, not an
            // empty history. One extra ranking pass, only on the poll where that actually happened.
            if(suggestion&&!minProfitChosen) {
              try {
                const ownBest=computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),
                  {minProfit:0,blocklist,risk,maxSpend,targetDurationMinutes,volumes,maxStackShare,...gates});
                if(ownBest&&ownBest.itemId!==suggestion.itemId)fellThroughFromHistory={name:ownBest.name};
              } catch {}
            }
            // Nothing to show AND a minimum profit set: the player is owed the reason. A new player
            // with a small cash stack who picks a target out of its reach otherwise sees the same
            // blank panel as someone whose market genuinely has nothing, concludes EVI is broken, and
            // never finds out that lowering the target by one step would have given them trades all
            // along. So the same ranking is run once more with no minimum, purely to report the best
            // figure actually reachable. It runs only in the empty case, so the normal path is
            // unchanged, and it is a statement of what exists rather than a suggestion: it goes
            // through none of the checks and is never something EVI tells anyone to buy.
            if(!suggestion && minProfit>0) {
              try {
                const best=rankWithoutMinimum(blocklist);
                const profit=best&&Number.isFinite(best.buyPrice)&&Number.isFinite(best.sellPrice)&&Number.isFinite(best.quantity)
                  ?(best.sellPrice-estimateUnitTax(best.itemId,best.sellPrice)-best.buyPrice)*best.quantity:null;
                if(Number.isFinite(profit)&&profit>0)reachable={name:best.name||null,itemId:best.itemId??null,profit:Math.round(profit)};
              } catch {}
            }
          }
          // "Best of both": keep whichever tier's pick is actually worth more. Ties go to the
          // player's own history, since an item they have traded before is evidence about what they
          // can really trade; only a market pick that is genuinely better displaces it, and the one
          // set aside is named so the sidebar can say what was passed over and why.
          if(historyPick) {
            if(!suggestion) suggestion=historyPick;
            else {
              const [own,market]=await Promise.all([worthOf(historyPick),worthOf(suggestion)]);
              if(own.value>=market.value) {
                heldBack.push({itemId:suggestion.itemId,reason:'A market-wide pick worth about '
                  +Math.round(market.value).toLocaleString('en-US')+' gp, set aside for your own '
                  +historyPick.name+' at about '+Math.round(own.value).toLocaleString('en-US')+' gp.'});
                suggestion=historyPick;
              } else {
                heldBack.push({itemId:historyPick.itemId,reason:'Your own '+historyPick.name
                  +' is worth about '+Math.round(own.value).toLocaleString('en-US')
                  +' gp at the price buyers are paying, against '+Math.round(market.value).toLocaleString('en-US')
                  +' gp for this market-wide pick, so EVI set your history aside this time.'});
              }
            }
          }
          // Independent of the ranked `suggestion` above: a plain live-market price for whatever
          // item the plugin says is currently open in a GE offer (openItemId, sent whenever a slot
          // is open, buy or sell -- see EviLivePlugin's own openOfferItemId), regardless of flip
          // history or ranking. Reuses the same `latest` data already fetched above, so this costs
          // nothing extra. Lets the plugin's hint/hotkey work for any item being traded, not only
          // the single top-ranked pick returned as `suggestion`.
          const openItemId=Number(url.searchParams.get('openItemId'));
          let openItemPrice=Number.isFinite(openItemId)?lookupItemPrice(latest,openItemId):null;
          // What the player paid for the item they have open, so the offer prompt can warn before a
          // sale loses GP (see withCostBasis). This session's own observed buy comes first -- it is
          // the exact price paid -- then the journal's open positions for this account, averaged
          // over what remains. Opening a sell offer for an item is itself good evidence it is held,
          // and this only ever adds a warning, so the journal's cost is used without the inventory
          // confirmation the slot reserve needs. Unknown cost changes nothing.
          if(openItemPrice) {
            let unitCost=null,heldQty=1;
            const holdItemParam=Number(url.searchParams.get('holdItemId'));
            if(holdItemParam===openItemId&&holdBuyPrice) {
              unitCost=holdBuyPrice;
              heldQty=Number(url.searchParams.get('holdQty'))||1;
            } else {
              // Finished purchases still held, plus buy orders still running that have filled some
              // units -- so selling part of a large order before it completes still warns. See
              // heldCostBasis.
              const basis=heldCostBasis(accountState.autoOpenPositions,accountState.active,openItemId,account);
              if(basis){unitCost=basis.unitCost;heldQty=basis.quantity;}
            }
            openItemPrice=withCostBasis(openItemPrice,unitCost,heldQty);
          }
          // Live market prices for every item behind a still-in-progress GE offer the plugin is
          // already tracking (slots=itemId:remainingQty,... -- see EviLivePlugin's
          // activeOffers/suggestionQuery()) -- reuses the same `latest` data already fetched above,
          // so a plugin user who never touches this (the param is simply absent) pays nothing extra.
          // Each price entry is exactly the same {itemId,buyPrice,sellPrice} shape as openItemPrice
          // above (see lookupItemPrice), purely so the sidebar's cancel/relist hint (offerDriftHint)
          // can compare an offer's own set price against today's market for that same item. Missing/
          // unpriced items are silently skipped rather than sent as null entries.
          const slotQuantities=(url.searchParams.get('slots')||'').split(',').map(pair=>{
            const [idPart,qtyPart]=pair.split(':');
            return {itemId:parseInt(idPart,10),remaining:parseInt(qtyPart,10)};
          }).filter(s=>Number.isFinite(s.itemId)&&s.itemId>0&&Number.isFinite(s.remaining)&&s.remaining>0);
          const slotPrices=slotQuantities.map(s=>lookupItemPrice(latest,s.itemId)).filter(Boolean);
          // How long the REMAINING quantity of each in-progress offer typically takes to trade at
          // recent volume, purely so the sidebar can note when that's running noticeably longer than
          // the player's own "Target trade duration" -- see estimateOfferFill in suggestions.mjs for
          // exactly what this is (a rough volume-based estimate, never a fill guarantee) and why. Only
          // computed when a target duration is actually set (targetDurationMinutes, same setting and
          // same already-fetched `volumes` the brand-new-suggestion sizing above uses) -- with no
          // preference set, this costs nothing extra and sends nothing, exactly like every other
          // setting-gated addition here.
          const slotFill=targetDurationMinutes!==undefined
            ?slotQuantities.map(s=>{
                const fill=estimateOfferFill(s.remaining,volumes?.[String(s.itemId)],targetDurationMinutes);
                return fill?{itemId:s.itemId,...fill}:null;
              }).filter(Boolean)
            :[];
          // A "you're holding this" reminder is never hidden on a free-to-play world -- the position
          // and any loss on it are real, and the player may be about to hop -- but it does say that
          // the item can't actually be traded here, so the advice isn't silently unusable.
          // What the player's own past offers of this size actually did -- their record, not a
          // forecast, and only when there are enough of them to mean anything (see fillModel.mjs).
          if(suggestion&&suggestion.action==='buy') {
            const itemVolumes=volumes?.[String(suggestion.itemId)]
              ??(await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/1h',60000).then(t=>(JSON.parse(t).data||{})[String(suggestion.itemId)]).catch(()=>null));
            const window=targetDurationMinutes??1440;
            const sentence=fillChanceSentence(fillChance(playerFillModel(),suggestion.quantity,itemVolumes,window),window);
            if(sentence)suggestion.reasoning=(suggestion.reasoning||'')+' '+sentence;
          }
          // Every slot is occupied, but at least one holds a finished offer (or the plugin couldn't
          // say). The suggestion is still shown -- it may well be the right trade -- with the one
          // thing standing between the player and placing it.
          const capacityNote=slotNote(capacity);
          if(suggestion&&capacityNote)suggestion.reasoning=(suggestion.reasoning||'')+' '+capacityNote;
          if(suggestion&&suggestion.action==='sell'&&membersBlocked?.(suggestion.itemId))
            suggestion.reasoning=(suggestion.reasoning||'')+' Note: this is a members item, so it can only be traded on a members world -- not this one.';
          // The fill history behind whichever buy pick survived, stated rather than warned: the warning
          // above only fires past the measured cliff, and an item just inside it is exactly where a
          // player still wants the number. Appended once, and never when a warning already said it.
          let thinStats=null;
          if(suggestion&&suggestion.action==='buy') {
            try {
              const thin=thinMarketIndex();
              thinStats=thin?thin.byItem.get(suggestion.itemId)||null:null;
              const context=thinStats&&thinMarketContext(thinStats,{windowHours:windowFor(targetDurationMinutes),quantity:suggestion.quantity});
              if(context&&!/barely trades|did not trade at all|Fill history:/.test(suggestion.reasoning||''))
                suggestion.reasoning=(suggestion.reasoning?suggestion.reasoning+' ':'')+context;
            } catch {}
          }
          // Besides the settings, what the slot and correlation checks did on this poll (see checksOf in
          // suggestionLog.mjs for the per-suggestion verdicts), so their calls can be judged later.
          suggestionLog.record({account:url.searchParams.get('account')||undefined,suggestion,
            context:{cash:maxSpend??null,durationMinutes:targetDurationMinutes??null,minProfit:minProfit||null,risk,
              heldBack:heldBack.length?heldBack.map(h=>({itemId:h.itemId,reason:h.reason})):null,
              demotedPicks:demotedPicks.length?demotedPicks:null,
              // The fill odds behind the pick, kept so these calls can be scored later like every other check.
              fillHistory:thinStats?{hoursTraded:thinStats.hoursTraded,hours:thinStats.hours,
                cadence:Math.round(thinStats.cadence*1000)/1000,
                recurrence:thinStats.recurrence[windowFor(targetDurationMinutes)],
                unitsAvailable:thinStats.unitsWithin[windowFor(targetDurationMinutes)]}:null,
              buysHeldForExits:!!buysHeldForExits}});
          // Time-based relist advice for sell offers that have been sitting (see relist.mjs). Built
          // from the bridge's own journal, which knows when each offer was placed and what its stock
          // cost, so the plugin needs to send nothing extra for it.
          const liveSells=state.active.filter(o=>['SELLING','CANCELLED_SELL'].includes(o.state)&&o.filled<o.total&&(!account||o.account===account));
          const costBasis=new Map((state.autoOpenPositions||[]).filter(p=>!account||p.account===account).map(p=>[p.itemId,p.unitCost]));
          const relistPrices=Object.fromEntries(liveSells.map(o=>[String(o.itemId),lookupItemPrice(latest,o.itemId)]).filter(([,p])=>p));
          // The same for BUY offers still filling: the margin that justified them may be gone (see
          // buyAdvice.mjs). Cancelling is free on every unfilled unit, so this is the cheapest
          // warning there is -- and the one EVI had no equivalent of.
          const liveBuys=state.active.filter(o=>o.state==='BUYING'&&o.filled<o.total&&(!account||o.account===account));
          const buyPricesFor=Object.fromEntries(liveBuys.map(o=>[String(o.itemId),lookupItemPrice(latest,o.itemId)]).filter(([,p])=>p));
          // And the other half of the same idea: a sell already standing below what its stock cost
          // (see sellAdvice.mjs). Five of the six losing flips in the player's own Copilot week lost
          // to the tax on a flat price rather than to the market, which nothing here had been saying.
          const sellNotes=sellAdvice({offers:liveSells.map(o=>({itemId:o.itemId,name:o.name,price:o.price,remaining:Math.max(0,(o.total||0)-(o.filled||0))})),costBasis})
            .map(n=>({itemId:n.itemId,message:n.message,belowBreakEven:true}));
          const buyNotes=buyMarginAdvice({offers:liveBuys.map(o=>({itemId:o.itemId,name:o.name,price:o.price,total:o.total,filled:o.filled,spent:o.spent})),prices:buyPricesFor})
            .map(n=>({itemId:n.itemId,name:n.name,message:n.message,belowBreakEven:false}));
          // A snapshot of everything this account owns, for the scanner's own wealth view. Uses the
          // prices and positions already in hand here, so it costs nothing extra.
          if(Number.isFinite(cashParam)&&cashParam>=0)lastCash.set(account||'',{gp:cashParam,at:Date.now()});
          try {
            const mine=o=>!account||o.account===account;
            const snapshot=wealthSnapshot({
              cash:cashFor(account)?.gp,
              buyOffers:state.active.filter(o=>o.state==='BUYING'&&mine(o)),
              sellOffers:state.active.filter(o=>o.state==='SELLING'&&mine(o)).map(o=>({...o,unitCost:(state.autoOpenPositions||[]).find(p=>p.itemId===o.itemId&&mine(p))?.unitCost})),
              positions:(state.autoOpenPositions||[]).filter(mine),
              priceOf:id=>lookupItemPrice(latest,id),
            });
            wealthLog.record({account,snapshot});
          } catch {}
          const relist=relistAdvice({
            offers:liveSells.map(o=>({itemId:o.itemId,name:o.name,price:o.price,remaining:Math.max(0,o.total-o.filled),firstSeen:o.firstSeen})),
            prices:relistPrices,costBasis,targetDurationMinutes:targetDurationMinutes??1440,
          });
          // Crash alerts for this player's own items -- running offers and stock EVI knows is held --
          // appended to relistAdvice, the list the published plugin already shows in full in its
          // sidebar, so they reach the player in game with no plugin change. Each is one complete
          // sentence from crashMessage: what is happening, why the player is being told, and the
          // measured history, with no forecast. Nothing is cancelled or relisted for them.
          const crashNotes=[];
          {
            const told=new Set();
            const note=(itemId,name,mine)=>{
              const c=crashWatch.isCrashing(itemId);
              if(!c||told.has(itemId))return;
              told.add(itemId);
              crashNotes.push({itemId,name,message:crashMessage(c,{name,mine}),belowBreakEven:false});
            };
            for(const o of state.active.filter(o=>!account||o.account===account)) {
              const left=Math.max(0,o.total-o.filled);
              if(['BUYING'].includes(o.state)&&left>0)note(o.itemId,o.name,`Your buy offer for ${o.total.toLocaleString('en-US')} is still running (${o.filled.toLocaleString('en-US')} bought so far).`);
              else if(['SELLING'].includes(o.state)&&left>0)note(o.itemId,o.name,`Your sell offer has ${left.toLocaleString('en-US')} still listed at ${o.price.toLocaleString('en-US')} gp.`);
            }
            for(const p of (state.autoOpenPositions||[]).filter(p=>!account||p.account===account))
              note(p.itemId,p.item,`You hold ${p.remaining.toLocaleString('en-US')} bought at ${Math.round(p.unitCost).toLocaleString('en-US')} gp each.`);
          }
          // slots: what the GE's own capacity allowed on this call, echoed back so the sidebar (and
          // anything else reading this endpoint) can tell "nothing passed your settings" apart from
          // "your settings were never consulted, because there was nowhere to place an offer".
          // slots additionally carries the sell-side reserve, and heldBack names anything set aside
          // for a stated reason -- both so the sidebar can explain a missing suggestion instead of
          // falling back on "nothing passes your settings", which would be untrue here.
          return send(200,{suggestion,openItemPrice,slotPrices,slotFill,relistAdvice:[...crashNotes,...sellNotes,...buyNotes,...relist],
            slots:{...capacity,sellSlotsOwed,buysHeldForExits,positionItems},
            profit:profitSince(),
            reachable,
            fellThroughFromHistory,
            heldBack:heldBack.slice(0,3)});
        } catch(e) {return send(502,{error:e.message});}
      }
      if(!ui) {
        if(pathname==='/'&&req.method==='GET')return send(200,login,'text/html');
        return send(401,{error:'Unlock EVI in this browser first'});
      }
      if(req.method==='POST') {
        if(req.headers.origin!==origin || req.headers['x-evi-ui']!=='1')return send(403,{error:'UI origin and request header required'});
        if(pathname==='/api/flips')return send(200,store.confirm(await body()));
        if(pathname==='/api/flips/removal')return send(200,store.setRemoved(await body()));
        if(pathname==='/api/flips/reopen')return send(200,store.reopen(await body()));
        // Scanner's "Still held" table: the rest of a purchase was used or sold outside EVI's view
        // (or undo that). See Store.closePosition.
        if(pathname==='/api/positions/close')return send(200,store.closePosition(await body()));
        // A purchase that filled while the bridge was stopped, told to EVI afterwards so the stock
        // has a cost basis again (see Store.recordPurchase). Marked as stated, never as observed.
        if(pathname==='/api/positions/record')return send(200,store.recordPurchase(await body()));
        // The scanner's own "I own this, never suggest selling it" list, for gear the idle-inventory
        // fallback keeps offering (see markPersonalUseItem). Item-level, reversible.
        // The goal itself: {itemId, quantity} or {gp}, or null to clear it. Nothing is validated into
        // existence here -- an unusable body clears the goal rather than storing something half-set.
        // Trading preferences applied by the bridge itself, so the plugin needs no new setting.
        if(pathname==='/api/preferences') {
          const b=await body();
          const next={...readPreferences(),focus:FOCUSES.includes(b.focus)?b.focus:'any'};
          try{writePreferences(next);}catch(e){return send(500,{error:e.message});}
          return send(200,{ok:true,...next,bulkMinLimit:BULK_MIN_LIMIT});
        }
        if(pathname==='/api/profit/reset')return send(200,{ok:true,profit:resetProfit()});
        if(pathname==='/api/preferences/block') {
          const b=await body();
          return send(200,{ok:true,blocked:setBlocked(b.itemId,b.blocked===undefined?true:b.blocked)});
        }
        if(pathname==='/api/goal') {
          const b=await body();
          const itemId=Number(b.itemId),quantity=Number(b.quantity),gp=Number(b.gp);
          let next=null;
          if(Number.isFinite(itemId)&&itemId>0)next={itemId:Math.trunc(itemId),quantity:Number.isFinite(quantity)&&quantity>0?Math.trunc(quantity):1};
          else if(Number.isFinite(gp)&&gp>0)next={gp:Math.round(gp)};
          try{if(next)fs.writeFileSync(goalFile,JSON.stringify(next));else fs.rmSync(goalFile,{force:true});}catch(e){return send(500,{error:e.message});}
          return send(200,{ok:true,goal:next});
        }
        if(pathname==='/api/inventory-personal-use') {
          const b=await body();
          return send(200,store.markPersonalUseItem({itemId:b.itemId,personal:b.personal===undefined?true:b.personal}));
        }
        if(pathname==='/api/price-archive')return send(200,archive.configure(await body()));
        // Completed flips from another tracker, sent in small batches by tools/import-copilot.mjs
        // (the request-body cap here is deliberately small). Ranking history only -- see
        // Store.importFlips for why these never touch the observed-profit total.
        if(pathname==='/api/flips/import')return send(200,store.importFlips(await body()));
        // Reading another plugin's Grand Exchange log into EVI's own records (see exchangeLog.mjs).
        // Always previewed first: the same request with preview:true reports exactly what it would
        // add, and what it cannot account for, before anything is written.
        if(pathname==='/api/exchange-log/import') {
          const req_=await body();
          const names=Array.isArray(req_?.files)?req_.files.slice(0,40):[];
          if(!names.length)return send(400,{error:'Name at least one log file to read'});
          const account=typeof req_?.account==='string'&&req_.account.trim()?req_.account.trim().slice(0,40):'exchange-logger';
          let records=[],unreadable=0;
          const read=[],missed=[];
          for(const name of names) {
            const full=exchangeLogFile(name);
            if(!full){missed.push(name);continue;}
            try {
              const parsed=parseLog(fs.readFileSync(full,'utf8'));
              records=records.concat(parsed.records);
              unreadable+=parsed.unreadable;
              read.push(name);
            } catch(e) { missed.push(name); }
          }
          records.sort((a,b)=>a.at-b.at);
          const offers=buildOffers(records,{account});
          const {flips,openPositions,unmatchedSells}=flipsFrom(offers);
          const summary={...summarise({records,unreadable,offers,flips,openPositions,unmatchedSells}),
            filesRead:read,filesSkipped:missed,account};
          if(req_?.preview!==false)return send(200,{preview:true,...summary});
          // Store.importFlips takes 500 at a time and refuses a fingerprint it has already seen, so a
          // second import of the same log adds nothing.
          let accepted=0,duplicates=0;
          for(let i=0;i<flips.length;i+=500) {
            const res=store.importFlips({source:'exchange-logger',flips:flips.slice(i,i+500)});
            accepted+=res.accepted;duplicates+=res.duplicates;
          }
          return send(200,{preview:false,...summary,accepted,duplicates});
        }
        if(pathname==='/api/logout'){res.setHeader('Set-Cookie','evi=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
        // The scanner's own top-ranked shortlist (its EVI Score V1 -- personal history, liquidity,
        // stability, and prediction when loaded), pushed from EVI_Flip_Scanner_V3.html's
        // pushSuggestions() after every auto-refresh while the tab is open. Never trusted blindly:
        // computePushedSuggestion re-validates and re-sorts every field before this is ever used for
        // a real suggestion. Requires the same unlocked-scanner-cookie + UI-origin gate as every
        // other scanner POST above -- the plugin never calls this, only the browser scanner does.
        if(pathname==='/api/scanner-suggestions') {
          const b=await body();
          const items=Array.isArray(b.items)?b.items.slice(0,MAX_PUSHED_ITEMS):[];
          pushedSuggestions=items.filter(c=>c&&Number.isFinite(c.itemId)&&c.itemId>0
            &&Number.isFinite(c.buy)&&c.buy>0&&Number.isFinite(c.sell)&&c.sell>0&&Number.isFinite(c.net)
            &&typeof c.name==='string'&&c.name.length>0&&c.name.length<=200)
            .map(c=>({itemId:Math.trunc(c.itemId),name:c.name.slice(0,200),buy:c.buy,sell:c.sell,net:c.net,
              qty:Number.isFinite(c.qty)&&c.qty>0?c.qty:1,score:Number.isFinite(c.score)?c.score:0,
              mode:typeof c.mode==='string'?c.mode.slice(0,20):undefined}));
          pushedSuggestionsAt=Date.now();
          return send(200,{ok:true,accepted:pushedSuggestions.length});
        }
      }
      if(req.method!=='GET')return send(405,{error:'Method not allowed'});
      if(pathname==='/api/state') {
        const st=store.state();
        // How many of the held positions the plugin actually found in the inventory, when it checked
        // within the last ten minutes -- older than that says nothing about now. Counted against that
        // account's own positions, since a player with two accounts has two inventories. Items in the
        // bank are not "found", so this is phrased in the scanner as seen in the inventory, never as
        // proof that the rest are gone.
        const check=[...inventoryChecks.values()].sort((a,b)=>b.at-a.at)[0];
        if(check&&Date.now()-check.at<600000) {
          const mine=(st.autoOpenPositions||[]).filter(p=>!check.account||p.account===check.account);
          const items=new Set(mine.map(p=>p.itemId));
          st.dataHealth={...st.dataHealth,inventoryCheck:{at:check.at,positions:items.size,
            seenInInventory:check.confirmed.filter(id=>items.has(id)).length}};
        }
        return send(200,st);
      }
      // Everything the scanner needs to open one item: the last 24 hours at five minutes, the player's
      // own offers over the same window, and EVI's own two readings on it. Built from the local archive
      // first -- the scanner used to fetch the Wiki once per click, and the archive already holds this --
      // with the Wiki's own series only as a fallback when the archive does not cover the window.
      // Every part is optional: a missing piece is reported as null so the panel can say so rather than
      // draw a chart out of nothing.
      if(pathname==='/api/item-detail') {
        const itemId=Number(url.searchParams.get('itemId'));
        if(!Number.isSafeInteger(itemId)||itemId<=0)return send(400,{error:'itemId required'});
        const hours=Math.min(72,Math.max(1,Number(url.searchParams.get('hours'))||24));
        const fromSec=Math.floor(Date.now()/1000)-hours*3600;
        let series=[],source=null;
        try {
          series=readArchive(dir,fromSec,Infinity,'5m')
            .map(b=>{const r=b.d&&b.d[itemId];return r?{timestamp:b.ts,avgHighPrice:r[0],highPriceVolume:r[1],avgLowPrice:r[2],lowPriceVolume:r[3]}:null;})
            .filter(p=>p&&(p.avgHighPrice||p.avgLowPrice));
          if(series.length)source='archive';
        } catch { series=[]; }
        // The archive only starts when the player turned it on, so a thin result falls back to the Wiki.
        if(series.length<12) {
          try {
            const j=JSON.parse(await suggestionPrices.get(`https://prices.runescape.wiki/api/v1/osrs/timeseries?id=${itemId}&timestep=5m`,300000));
            const rows=(j.data||[]).filter(p=>p.timestamp>=fromSec&&(p.avgHighPrice||p.avgLowPrice));
            if(rows.length>series.length){series=rows;source='wiki';}
          } catch {}
        }
        // The player's own offers on this item inside the window, so the chart can show where they
        // actually bought and sold rather than only where the market was.
        const yours=[...store.offers.values()]
          .filter(o=>o.itemId===itemId&&Number.isFinite(o.price)&&(o.firstSeen||0)>=fromSec*1000)
          .map(o=>({at:o.firstSeen,price:o.price,buy:['BUYING','BOUGHT','CANCELLED_BUY'].includes(o.state),filled:o.filled||0,total:o.total||0,state:o.state}))
          .sort((x,y)=>x.at-y.at);
        // EVI's own two readings, exactly as a suggestion would get them. Both fail open to null.
        let fillHistory=null;
        try {
          const thin=thinMarketIndex();
          const stats=thin&&thin.byItem.get(itemId);
          const ctx=stats&&thinMarketContext(stats,{windowHours:windowFor(720),quantity:1});
          if(ctx)fillHistory={text:ctx,archivedHours:thin.hours};
        } catch {}
        let sellSupport=null;
        try {
          const latest=JSON.parse(await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/latest',60000)).data||{};
          const price=lookupItemPrice(latest,itemId);
          if(price&&Number.isFinite(price.buyPrice)) {
            let archived=[];
            try { archived=archive.recentHourly(Math.floor(Date.now()/3600000)*3600-SELL_SUPPORT_HOURS*3600); } catch {}
            let hourly=null;
            try { hourly=JSON.parse(await suggestionPrices.get(`https://prices.runescape.wiki/api/v1/osrs/timeseries?id=${itemId}&timestep=1h`,600000)).data||[]; } catch {}
            if(hourly||archived.length>=SELL_SUPPORT_HOURS) {
              const detail=sellPriceSupport(mergeArchiveHours(hourly||[],archived,itemId),itemId,price.buyPrice);
              sellSupport={...detail,note:sellSupportNote(detail,price.sellPrice)};
            } else sellSupport={note:null,reason:'not enough recent hours to judge the exit'};
          }
        } catch {}
        return send(200,{itemId,hours,source,series,yours,fillHistory,sellSupport});
      }
      // One item's picture, same-origin so the page's own policy allows it. Cached hard: the file
      // never changes for a given item, and a miss is a 404 the scanner's <img> quietly removes.
      if(pathname==='/api/icon') {
        const itemId=Number(url.searchParams.get('itemId'));
        const icon=Number.isSafeInteger(itemId)?await iconCache.get(itemId):null;
        if(!icon)return send(404,{error:'No icon for this item'});
        res.setHeader('Content-Type',icon.contentType);
        res.setHeader('Cache-Control','public, max-age=604800, immutable');
        res.statusCode=200;
        return res.end(icon.body);
      }
      // What Exchange Logger has written on this machine, if anything. Read-only, and it reports the
      // folders it looked in so "nothing found" can be told apart from "not installed".
      if(pathname==='/api/exchange-log/scan') {
        const dirs=exchangeLogDirs();
        const files=[];
        for(const dir of dirs) {
          let names=[];
          try { names=fs.readdirSync(dir); } catch {}
          for(const name of names) {
            if(!/\.(log|csv|json|txt|jsonl)$/i.test(name))continue;
            try {
              const st=fs.statSync(path.join(dir,name));
              if(st.isFile())files.push({name,bytes:st.size,modified:st.mtimeMs,folder:dir});
            } catch {}
          }
        }
        files.sort((a,b)=>b.modified-a.modified);
        return send(200,{folders:dirs,files,installed:dirs.length>0});
      }
      if(pathname==='/api/price-archive')return send(200,archive.status());
      // How EVI's own suggestions actually turned out (see suggestionOutcomes.mjs). Scanner-gated
      // like every other view of the player's own data.
      // The player's own settings history with what happened under each (see tradingPeriods.mjs).
      // Built from the same join as the scorecard below, so it costs one extra pass over the log.
      if(pathname==='/api/trading-periods') {
        const state=store.state();
        const rows=joinSuggestionOutcomes(suggestionLog.recent(2000),[...store.offers.values()],[...state.flips,...state.autoFlips]);
        return send(200,{periods:tradingPeriods(rows)});
      }
      if(pathname==='/api/suggestion-outcomes') {
        const state=store.state();
        const rows=joinSuggestionOutcomes(suggestionLog.recent(500),[...store.offers.values()],[...state.flips,...state.autoFlips]);
        return send(200,{summary:summarizeOutcomes(rows),recent:rows.slice(-25).reverse()});
      }
      // Which tradeable items each recent news post connects to, and the chain of game mechanics
      // that links them (see newsChain.mjs for why this follows the wiki's own links rather than
      // matching item names in the article). Answers from cache immediately and refreshes in the
      // background when stale, so a request never waits on dozens of wiki lookups. Needs the item
      // mapping to name anything at all, so it is warmed here on the first call rather than left to
      // whichever other route happens to run first.
      // What a future, opt-in sharing feature WOULD send, shown locally so the player can read it
      // before any such feature exists (see sharePreview.mjs). Nothing is sent. Scanner-gated like
      // every other view of the player's own data, and cached ten minutes because it reads the
      // archive back to the oldest watched offer.
      if(pathname==='/api/share-preview') {
        const now=Date.now();
        if(!sharePreviewCache.body||now-sharePreviewCache.at>600000) {
          const offers=[...store.offers.values()];
          const starts=offers.filter(o=>o.knownStart&&Number.isFinite(o.firstSeen)).map(o=>o.firstSeen);
          const buckets=starts.length?readArchive(dir,Math.floor(Math.min(...starts)/1000)-3600):[];
          sharePreviewCache={at:now,body:sharePreview(offers,buckets)};
        }
        return send(200,sharePreviewCache.body);
      }
      // Crash alerts for the scanner (see crashWatch.mjs): everything detected in the last day, each
      // marked when it touches this player's offers or holdings. Scanner-gated like the rest.
      // What the player owns now and how it has changed (see wealth.mjs). Scanner-gated; the history is
      // whatever the plugin's own polls have recorded, so it starts empty and fills in over time.
      if(pathname==='/api/preferences') {
        await itemIndex().catch(()=>{});
        const p=readPreferences();
        return send(200,{...p,bulkMinLimit:BULK_MIN_LIMIT,
          blockedItems:p.blocked.map(id=>({itemId:id,name:mappingCache.index?.get(id)?.name||null}))});
      }
      if(pathname==='/api/wealth') {
        const st=store.state();
        const account=url.searchParams.get('account')||undefined;
        const mine=o=>!account||o.account===account;
        let latestPrices={};
        try { latestPrices=JSON.parse(await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/latest',60000)).data||{}; } catch {}
        const positions=(st.autoOpenPositions||[]).filter(mine);
        const current=wealthSnapshot({
          cash:cashFor(account)?.gp,
          buyOffers:st.active.filter(o=>o.state==='BUYING'&&mine(o)),
          sellOffers:st.active.filter(o=>o.state==='SELLING'&&mine(o)).map(o=>({...o,unitCost:positions.find(p=>p.itemId===o.itemId)?.unitCost})),
          positions,
          priceOf:id=>lookupItemPrice(latestPrices,id),
        });
        const history=wealthLog.recent(2000).filter(r=>!account||r.account===account);
        const cashRead=cashFor(account);
        const goal=goalStatus({goal:readGoal(),wealth:current,priceOf:id=>lookupItemPrice(latestPrices,id),
          itemName:id=>mappingCache.index?.get(id)?.name||null,history,
          flips:[...st.flips,...st.autoFlips].filter(mine)});
        return send(200,{current,goal,cashKnown:current.cash!==null,cashAt:cashRead?cashRead.at:null,
          changes:{day:wealthLog.changeOver(24,{account}),week:wealthLog.changeOver(24*7,{account})},
          history:history.map(r=>({at:r.at,total:r.total,cash:r.cash,inBuyOffers:r.inBuyOffers,inSellOffers:r.inSellOffers,held:r.held}))});
      }
      if(pathname==='/api/crash-alerts') {
        await itemIndex().catch(()=>{});
        const st=store.state();
        const mine=new Set([...st.active.filter(o=>['BUYING','SELLING'].includes(o.state)&&o.filled<o.total).map(o=>o.itemId),...(st.autoOpenPositions||[]).map(p=>p.itemId)]);
        const fiveMinuteOn=archive.status().steps['5m'].enabled;
        return send(200,{fiveMinuteOn,...crashWatch.status(),alerts:crashWatch.recent().map(a=>{
          const name=mappingCache.index?.get(a.itemId)?.name||null;
          return {itemId:a.itemId,name,since:a.since,updated:a.updated,ended:a.ended,endedBecause:a.endedBecause,yours:mine.has(a.itemId),
            hi:a.crash.hi,baseHi:a.crash.baseHi,drop:a.crash.drop,units:a.crash.units,message:crashMessage(a.crash,{name})};
        })});
      }
      if(pathname==='/api/news-items') {
        await itemIndex().catch(()=>{});
        return send(200,newsChains.get());
      }
      // Only public market/news endpoints. No arbitrary URL proxy and no trade data in requests.
      const routes={mapping:['mapping',3600000],latest:['latest',60000],'5m':['5m',60000],'1h':['1h',60000]};
      let upstream,ttl=300000,type='application/json';
      if(pathname.startsWith('/api/market/')) {
        const name=pathname.slice('/api/market/'.length);
        if(routes[name]){upstream='https://prices.runescape.wiki/api/v1/osrs/'+routes[name][0];ttl=routes[name][1];}
        else if(name==='timeseries'&&/^\d{1,8}$/.test(url.searchParams.get('id')||'')&&['5m','1h','6h','24h'].includes(url.searchParams.get('timestep')))upstream='https://prices.runescape.wiki/api/v1/osrs/timeseries?'+new URLSearchParams({id:url.searchParams.get('id'),timestep:url.searchParams.get('timestep')});
      }
      if(pathname==='/api/news'){upstream='https://secure.runescape.com/m=news/latest_news.rss?oldschool=true';ttl=900000;type='application/xml';}
      if(upstream) {
        let hit=cache.get(upstream);
        if(!hit||hit.until<Date.now()) {
          const pending=(async()=>{
            const r=await fetch(upstream,{headers:{'User-Agent':userAgent('scanner and plugin requests')},signal:AbortSignal.timeout(15000),redirect:'error'});
            if(!r.ok)throw Error('Public source returned HTTP '+r.status);
            const text=await r.text();if(text.length>10000000)throw Error('Public response too large');return text;
          })();
          hit={until:Date.now()+ttl,pending};cache.set(upstream,hit);
          pending.catch(()=>cache.delete(upstream));
        }
        try {const text=await hit.pending;res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(text);}
        catch(e){return send(502,{error:e.message});}
      }
      const files={'/':'EVI_Flip_Scanner_V3.html','/live.js':'live.js','/performance.js':'performance.js','/performance-core.mjs':'performance-core.mjs','/preferences.js':'preferences.js','/lookup.js':'lookup.js','/import-ui.js':'import-ui.js','/exchange-log-import.js':'exchange-log-import.js','/import-core.mjs':'import-core.mjs','/import-worker.mjs':'import-worker.mjs','/workbook-import.mjs':'workbook-import.mjs','/vendor/xlsx.mjs':'vendor/xlsx.mjs'};
      if(files[pathname]) {
        // The browser scanner is optional: the bridge is useful on its own (the RuneLite plugin
        // talks to the API above). Say so plainly instead of failing with a stack trace when the
        // scanner folder isn't installed alongside it.
        try {return send(200,fs.readFileSync(path.join(root,'scanner',files[pathname]),'utf8'),pathname==='/'?'text/html':'text/javascript');}
        catch {return send(404,{error:'The browser scanner is not installed next to this bridge. The RuneLite plugin works without it.'});}
      }
      return send(404,{error:'Not found'});
    } catch(e) {if(!res.headersSent)send(400,{error:e.message});else res.end();}
  });
  server.requestTimeout=10000;server.headersTimeout=10000;
  return {server,store,secrets,origin,archive};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const app=createBridge();
  app.server.on('error',e=>{console.error('Bridge could not start:',e.message);process.exitCode=1;});
  app.server.listen(51743,'127.0.0.1',()=>{
    app.archive.start(); // does nothing until switched on in the scanner's Live RuneLite tab
    console.log(`EVI Live — local only\nOpen ${app.origin}\nScanner key: ${app.secrets.scanner}\nRuneLite plugin key: ${app.secrets.plugin}\nKeep this window open. Press Ctrl+C to stop.\nPrivate records and keys are saved in the data folder. Do not share that folder.`);
  });
}
