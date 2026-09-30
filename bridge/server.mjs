import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {createMarketCache} from './marketCache.mjs';
import {createIconCache} from './icons.mjs';
import {parseLog,buildOffers,flipsFrom,summarise,resolveLogFile} from './exchangeLog.mjs';
import {computeSuggestion,computeMarketSuggestion,computeHoldingSuggestion,holdingPreempts,hasLiveSellOffer,computeInventorySuggestion,computePushedSuggestion,pickPersistentOpenPosition,comparableAsHistoryPick,lookupItemPrice,forecastFromSeries,timestepForHorizon,pickWithForecast,estimateOfferFill,estimateVolatility,marginClearsCushion,marginClearsTax,MARGIN_TAX_MULTIPLE,MARGIN_TAX_NO_HISTORY_MULTIPLE,slotCapacity,slotNote,slotExposure,withCostBasis,heldCostBasis,sellPriceSupport,sellSupportNote,mergeArchiveHours,SELL_SUPPORT_HOURS,robustPrices,ROBUST_PRICE_HOURS,limitAllowance,BULK_MIN_LIMIT,FOCUSES,focusAllows,resolveFocus} from './suggestions.mjs';
import {estimateUnitTax} from './tax.mjs';
import {createSuggestionLog,checksOf} from './suggestionLog.mjs';
import {createAcceptances} from './acceptances.mjs';
import {joinSuggestionOutcomes,summarizeOutcomes} from './suggestionOutcomes.mjs';
import {tradingPeriods} from './tradingPeriods.mjs';
import {createPriceArchive,readArchive} from './priceArchive.mjs';
import {createNewsChains} from './newsChains.mjs';
import {createCorrelationIndex,correlationNote,CORRELATED_THRESHOLD} from './correlation.mjs';
import {buildFillModel,fillChance,fillChanceSentence} from './fillModel.mjs';
import {relistAdvice} from './relist.mjs';
import {holdingsAdvice} from './holdingsAdvice.mjs';
import {sellAdvice} from './sellAdvice.mjs';
import {buyMarginAdvice} from './buyAdvice.mjs';
import {wealthSnapshot,createWealthLog} from './wealth.mjs';
import {suggestionVerdict} from './verdict.mjs';
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
<h1>EVI Live</h1><p>Paste the key labelled <b>Scanner key</b> in the bridge window, not the RuneLite plugin key below it &mdash; both look alike. It opens EVI's setup and history import. Your trade data stays on this computer.</p>
<form id="f"><label>Scanner key<input id="token" type="password" required autocomplete="off"></label><button>Unlock</button></form><p id="status"></p>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();try{const r=await fetch('/api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value.trim()})});if(!r.ok)throw Error('Key not accepted');location.replace('/')}catch(e){document.getElementById('status').textContent=e.message}};</script>`;

// Which of EVI's per-request checks are live, and at what bar, for one GET /api/suggestion.
//
// Pulled out of the request handler and made pure on 27 Sept 2026 so it can be tested directly, after a
// bug of exactly this shape reached a real user: the supported-margin check -- measure the minimum
// against what buyers are really paying rather than the quoted spread -- was gated on the player having
// SET a minimum, and MinProfitTier.AUTO is the shipped default and deliberately sends none. The check
// existed, was tested, was documented, and did nothing for anybody on the factory settings. Nothing in
// the suite could see it, because every test named its own parameters. See tests/defaultPolicy.test.mjs,
// which asserts the defaults from this one function instead.
//
// AUTO_MIN_PROFIT: a player who has set no minimum has not thereby asked to be offered anything at all.
// On 26 Sept EVI suggested 81 gold necklaces on a 53k stack: 324 gp of gross margin, of which the Grand
// Exchange tax took 243, leaving 81 gp for a slot and the attention. Measured against the 74 real
// suggestions ever made with no minimum set, whose median nets 28,208 gp, a 500 gp floor removes 8% of
// them -- exactly that tail and nothing a player would miss. Deliberately a small flat figure rather
// than a share of the cash stack: a share was measured too and would have dropped 71% of the same
// suggestions, because it scales with capital while the absurdity does not.
//
// It is the one flat cutoff in EVI and it exists only where the player expressed no preference. Anyone
// who genuinely wants those trades -- the thin-margin, high-volume flipping a small stack may depend on
// -- sends minProfit=1, which is read as "no minimum at all" and switches off both the floor and the
// margin-over-tax bar with it. See MinProfitTier.NONE in the plugin.
export const AUTO_MIN_PROFIT=500;

// ...and, where no minimum was set, a share of what the player is actually holding.
//
// 500 gp alone is a floor against absurdity, not against irrelevance. On 28 September 2026 novi had
// 89m in hand and EVI was offering trades worth "anywhere from 500 gp to 12k": each one passed the
// floor, each one was real, and none of them was worth a Grand Exchange slot at that size. Their
// words, and the right principle: it should always look at the cash stack.
//
// A share was considered when the floor was first written and rejected, on the grounds that it scales
// with capital while the absurdity does not. That was right about a share ALONE. Taking the larger of
// the two keeps both: a player with 50k is governed by the 500, since 0.1% of anything under 500,000
// is less than that, so the cheap high-volume flipping a small stack lives on is untouched.
//
// 0.1% measured over 420 real buy suggestions that recorded a cash stack:
//
//   floor                     dropped   median kept   median dropped
//   500 flat (before)            2%        612,968             72
//   max(500, 0.05% of stack)    16%        712,400          5,895
//   max(500, 0.10% of stack)    21%        752,060          9,557
//   max(500, 0.25% of stack)    32%        896,748         48,152
//   max(500, 1.00% of stack)    67%        985,103        436,954
//
// The median dropped suggestion at 0.1% is worth 9,557 gp -- exactly the band being complained about --
// and the median kept rises by about a quarter. At 0.25% the median dropped is 48,152, which is a real
// trade on a modest stack, so the line sits where the harm stops rather than where the numbers look
// tidiest. At 89m it asks for 89,000; at 380m, 380,000; at 50k, still just 500.
//
// Only where nothing was chosen. A player who sets 200k means 200k, and an explicit setting is not
// something to quietly raise on them.
export const AUTO_STACK_SHARE=0.001;
export function autoMinProfit(cash) {
  if(!Number.isFinite(cash)||cash<=0)return AUTO_MIN_PROFIT;
  return Math.max(AUTO_MIN_PROFIT,Math.round(cash*AUTO_STACK_SHARE));
}
/**
 * The single profit figure the sidebar leads with: the more cautious of the quoted spread and what
 * buyers have actually been paying, or the quoted spread alone when nothing has been measured.
 *
 * Kept out of the request handler and exported so it can be tested directly. The two checks that
 * have shipped switched off for every default user were both buried in handler code with no test
 * that named the default -- see tests/defaultPolicy.test.mjs for the standing habit.
 *
 * `supported` is null when there is no reading, which is fail-open on purpose: no measurement must
 * never invent a constraint, and the quoted spread is then the only honest answer available.
 */
export function headlineProfit(quoted,supported) {
  if(!Number.isFinite(quoted))return null;
  if(!Number.isFinite(supported))return quoted;
  return Math.min(quoted,supported);
}

/** The most positions EVI will ever suggest at once, whatever a caller asks for. */
export const MAX_POSITIONS=3;
/**
 * How many trades to suggest on this request: 1 unless the player has opted into more.
 *
 * Clamped rather than trusted. The parameter comes from a config dropdown today, but the endpoint is
 * reachable by anything holding the plugin key, and novi's standing objection is to EVI fanning out
 * across the Grand Exchange: allocating a stack across eight trades divides the cash by eight, and an
 * eighth-sized trade cannot make the profit they trade for. So the ceiling lives here, on the server,
 * rather than resting on the dropdown only offering three.
 *
 * Anything absent, unparseable, zero, negative or fractional lands on 1. One is also what an older
 * plugin sends (nothing at all), so the default path is unchanged for everybody who has not asked.
 */
export function positionsWanted(searchParams) {
  const asked=Number(searchParams?.get?.('maxSuggestions'));
  if(!Number.isFinite(asked))return 1;
  return Math.min(MAX_POSITIONS,Math.max(1,Math.floor(asked)));
}

/**
 * The three settings "Bigger positions" turns on together, and the reason they are one switch rather
 * than three. Each measured neutral or worse on its own, because they gate the same class of trade in
 * series: the per-hour liquidity floor keeps a thin item out; if admitted, the ranking's
 * `log(liquidity)` term means it never wins; and if it won, the per-hour cap sizes it to a handful of
 * units so the trade is too small to matter. Moving one leaves the other two still shutting the door.
 *
 * Measured over 14 archived days at 20m, 78m and 200m stacks at a twelve-hour pace
 * (tools/market-tier-ranking.mjs): median profit per trade 150,000 -> 380,000-480,000, median order
 * 6.6m -> 15.2m, share of picks that lose GP 8% -> 9-10%. In the band it exists to reach -- items
 * trading under 25 an hour -- EVI today picks 1 to 3 and loses on 67-100% of them, against 15 to 21
 * picks losing on 10-13% here. Opt-in, never a default: it raises the loss rate, and at a two-day
 * pace the same numbers take it from 8% to 13%, because 10% of two days' volume is a much larger
 * order than 10% of twelve hours'.
 */
export const BIGGER_POSITIONS={minVolumeInWindow:24,rankBy:'profit',volumeWindowShare:0.10};

export function suggestionPolicy(searchParams) {
  const askedFor=Math.max(0,Number(searchParams.get('minProfit'))||0);
  const minProfitChosen=askedFor>0;
  const cash=Number(searchParams.get('cash'));
  const biggerPositions=searchParams.get('sizing')==='bigger';
  return {
    askedFor,
    minProfitChosen,
    biggerPositions,
    // Spread across the tiers below. The sizing half (the window-relative floor and cap) is about how
    // much of a market an order can be, which is the same physics whichever tier picked the item, so
    // it applies to both. The RANKING half was measured on the market tier and is applied only there.
    sizing:biggerPositions?{minVolumeInWindow:BIGGER_POSITIONS.minVolumeInWindow,volumeWindowShare:BIGGER_POSITIONS.volumeWindowShare}:{},
    marketRankBy:biggerPositions?BIGGER_POSITIONS.rankBy:undefined,
    minProfit:minProfitChosen?askedFor:autoMinProfit(cash),
    // An edge thinner than the item's own GE tax is not offered (see marginClearsTax in
    // suggestions.mjs for the 335-hour measurement). Per-item rather than flat: the bar is that item's
    // own tax, and a tax-free item is exempt by construction. On unless NONE asked for everything.
    requireMarginOverTax:askedFor!==1,
    // Starter profile (EviLiveConfig.tradingProfile): market-wide picks restricted to items the GE
    // charges no tax on. See TradingProfile.java for the backtest behind it. Opt-in.
    taxFreeOnly:searchParams.get('profile')==='starter',
    // Opt-in, and correctly so: measured against live data this blocked every candidate (0 of 40
    // market-wide, 0 of 5 personal) because its volatility estimate counts the ordinary bid-ask bounce
    // -- the very margin being flipped -- as price movement. See EviLiveConfig.marginSafetyCushion.
    requireCushion:searchParams.get('cushion')==='1',
  };
}

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
  const suggestionLog=createSuggestionLog(dir),acceptances=createAcceptances(dir),archive=createPriceArchive({dir,log:m=>console.error(m),
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
  // The steady-price reading, built once and shared by every consumer: the suggestion path, the
  // pushed tier, and the scanner route.
  //
  // It has to be cached, and it has to come from readArchive. Both were measured on 29 Sept 2026,
  // when the window widened from 24 hours to two weeks:
  //   * archive.recentHourly() keeps only RECENT_HOURS (26) buckets in memory, so it cannot reach
  //     back two weeks at all. It would quietly return a day of data and look like it had worked,
  //     which is worse than failing.
  //   * a 336-hour median across about 4,000 items takes ~316ms. The plugin polls every couple of
  //     seconds and the suggestion path was recomputing this per request, uncached. At 24 hours that
  //     was 24ms and merely wasteful; at 336 it would have pegged the bridge.
  // The underlying prices move once an hour at most, so a five-minute cache costs nothing real.
  let robustCache=null;
  function robustPricesCached() {
    const now=Date.now();
    if(robustCache&&now-robustCache.at<300000)return robustCache.prices;
    let prices=null;
    try { prices=robustPrices(readArchive(dir,Math.floor(now/1000)-ROBUST_PRICE_HOURS*3600,Infinity,'1h'),ROBUST_PRICE_HOURS); } catch {}
    // A FAILED build is not cached for the full five minutes. An empty reading is not neutral here:
    // every item then falls back to its live spread, which is the behaviour this whole mechanism
    // exists to replace, and pinning that for five minutes after a restart would make the tier
    // quietly revert exactly when a player is most likely to be looking at it. Retried on the next
    // request instead, with a short backoff so a genuinely archive-less install is not re-reading the
    // disk on every poll.
    const empty=!prices||!Object.keys(prices).length;
    robustCache={at:empty?now-270000:now,prices:prices||{}};
    return robustCache.prices;
  }
  // Warmed off the request path shortly after startup, because the FIRST poll after a restart must
  // not pay for a two-week median. The plugin's readTimeout is 2000ms and a timeout there is not
  // reported as slowness -- the sidebar says "Bridge unreachable, check it's running and the pairing
  // key matches", which points at the wrong thing entirely and has already sent one debugging session
  // down the wrong path. A second of delay keeps it clear of the bridge's own startup work.
  setTimeout(()=>{try{robustPricesCached();}catch{}},1000).unref?.();
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
      // "I took this one." The only way EVI can honestly say what following it is worth: every other
      // reading of its track record infers acceptance from an offer appearing soon after a
      // suggestion, which cannot tell a followed pick from a trade the player meant to make anyway.
      // Reversible by posting accepted:false, because a mistaken tap the player cannot undo is a tap
      // they stop making. Records nothing beyond the id, the item and the time -- it goes in the
      // same local journal as everything else and is never sent anywhere.
      if(pathname==='/api/suggestion/accept'&&req.method==='POST') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        const b=await body();
        const result=acceptances.accept({id:b.id,account:b.account,itemId:b.itemId,
          accepted:b.accepted===undefined?true:!!b.accepted});
        return send(result.ok?200:400,result);
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
          // Which checks are live for this request, and at what bar. Read suggestionPolicy for why
          // each default is what it is -- it is a pure function precisely so a test can assert that
          // the plugin's DEFAULT query string leaves the important ones switched on.
          const {minProfit,minProfitChosen,requireMarginOverTax}=suggestionPolicy(url.searchParams);
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
          // >= 0: cash=0 is "carrying nothing", not "did not say". The plugin omits the parameter entirely
          // when the stack is unknown, so absent already covers that case. See the matching note in suggestions.mjs.
          const maxSpend=Number.isFinite(cashParam)&&cashParam>=0?cashParam:undefined;
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
              // What can FILL right now, which is one window's remainder and nothing more. It used to be
              // the whole allowance across every window the player's trade duration spans, and on a
              // 2-day pace that is twelve of them: on 27 Sept EVI asked for 172,266 blood runes, 6.9x a
              // single 25,000 limit.
              //
              // To be accurate about the mechanism, since an earlier version of this comment was not:
              // the Grand Exchange does NOT refuse such an offer. It accepts it and fills up to the
              // limit, then stalls until the four-hour window rolls over, then carries on. So the order
              // is placeable and will eventually complete -- novi's own correction, and it is the reason
              // this cap is a judgement rather than a correctness fix.
              //
              // The judgement: a quantity a player reads as "buy this now" should be the part that can
              // actually fill now. The multi-window version commits the capital (57m in that example) to
              // one slot for two days, grinding in limit-sized steps, and the fill estimate knows
              // nothing about those stalls so it reports a time that cannot happen. The remainder is
              // still reachable -- the wording says the limit resets every four hours -- and anyone who
              // wants the single set-and-forget order can still place a larger one by hand.
              const acrossWindows=limitAllowance({limit,used,windowEndsAt,targetDurationMinutes});
              return {limit,remaining:Math.max(0,limit-(Number.isFinite(used)?used:0)),acrossWindows};
            };
          }
          const gates={membersBlocked,limitFor,focusBlocked,requireMarginOverTax};
          // How much of the cash stack one market-wide suggestion may commit, as a percentage
          // (EviLiveConfig.maxTradeShare, default 25). Only meaningful alongside a known cash stack,
          // and only applied to the market-wide tier -- a suggestion from the player's own history
          // keeps the size that history implies. See MaxTradeShare.java for the backtest behind it.
          const stackShareParam=Number(url.searchParams.get('stackShare'));
          const maxStackShare=Number.isFinite(stackShareParam)&&stackShareParam>0&&stackShareParam<=100?stackShareParam/100:undefined;
          // Starter profile (EviLiveConfig.tradingProfile): market-wide picks restricted to items the
          // GE charges no tax on. See TradingProfile.java for the backtest behind it.
          const {taxFreeOnly,requireCushion,sizing,marketRankBy}=suggestionPolicy(url.searchParams);
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
              // Runs whether or not the player set a minimum. Until 27 Sept it was gated on
              // minProfitChosen, so every player on the default AUTO tier -- which deliberately sends
              // no minProfit at all -- had this skipped entirely, and got the quoted spread with only
              // the 500 gp total floor behind it. That is how 25,000 blood runes were offered on a two
              // gp edge. With no minimum set the bar is the Auto floor, plus the same
              // margin-must-cover-tax test the tiers apply, measured here at the price buyers are
              // really paying rather than the quoted one.
              if(detail&&Number.isFinite(detail.netAtAverage)) {
                const qty=candidate.quantity||1;
                const supportedTotal=detail.netAtAverage*qty;
                const taxAtSupport=estimateUnitTax(candidate.itemId,detail.averagePaid);
                // The warning bar, one times tax, not the tighter bar the tiers drop on.
                // The same bar the tiers apply to the QUOTED margin, applied to the margin that is
                // actually true. On 27 Sept blood runes were offered at a quoted 7 gp against a 6 gp
                // tax -- 1.17x, so the tier let them through -- while 10.4m units had changed hands at
                // 339 over 12 hours, making the real edge 1 gp, or 0.17x the tax. That is the band
                // measured at a 33% loss rate with a negative lower quartile, and 172,266 units turned
                // it into a 172k "profit" that cleared every floor. Held BACK rather than demoted:
                // a demoted pick is still shown when nothing better passes, and this one was.
                const bar=candidate.source==='personal'?MARGIN_TAX_MULTIPLE:MARGIN_TAX_NO_HISTORY_MULTIPLE;
                const thinAtSupport=requireMarginOverTax&&!marginClearsTax(detail.netAtAverage,taxAtSupport,bar);
                if(thinAtSupport) {
                  const gp=n=>Math.round(n).toLocaleString("en-US");
                  return {blocked:true,
                    warning:"Set aside: at the price buyers are actually paying this makes about "
                      +gp(detail.netAtAverage)+" gp a unit, against the "+gp(taxAtSupport)
                      +" gp tax on each one. An edge thinner than its own tax does not survive a single"
                      +" price step -- measured over 335 hours, trades like this lose GP a third of the time,"
                      +" however large the quantity makes the total look.",
                    detail:{...detail,thinnerThanTax:true}};
                }
                if(supportedTotal<minProfit) {
                  const quoted=Math.round((candidate.sellPrice-estimateUnitTax(candidate.itemId,candidate.sellPrice)-candidate.buyPrice)*qty);
                  const gp=n=>Math.round(n).toLocaleString("en-US");
                  return {warning:"Warning: "+(minProfitChosen?"below your "+gp(minProfit)+" gp minimum":"worth under "+gp(minProfit)+" gp")+" at the price buyers are actually paying. "
                      +"The quoted spread makes this look like "+gp(quoted)+" gp, but over the last "+detail.hours
                      +" hours "+detail.units+" buyers paid an average of "+gp(detail.averagePaid)
                      +" gp, which makes it about "+gp(supportedTotal)+" gp.",
                    detail:{...detail,belowMinimumAtSupportedPrice:true}};
                }
              }
              // The detail comes back even when nothing is wrong with it. It used to be dropped on a
              // pass, which is why a clean pick had no reading to show: the sidebar could say what it
              // distrusted and never what it had actually checked. A result with no `warning` changes
              // no behaviour anywhere -- pickWithForecast only acts on `blocked` and `warning`.
              return warning?{warning,detail}:(detail?{detail}:null);
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
          // A position that is ALREADY listed is not waiting to be sold -- it is being sold. Reminding
          // the player to sell it is advice they have taken, and on 28 Sept it was worse than useless:
          // EVI offered to sell one Uncooked dragonfruit pie "near 1,689 gp" while their own offer for
          // it had been standing at 1,856 since 05:14. Lower than their ask, for something already on
          // the market. relist.mjs is what speaks about an offer that is not moving; this tier is only
          // for stock sitting in the bag with no offer behind it.
          // state.active is the plugin's live snapshot of the eight GE slots. The journal is NOT the same
          // thing: it had 64 offers still marked open while the plugin reported 8. See hasLiveSellOffer.
          const state=store.state();
          const listedForSale=itemId=>hasLiveSellOffer(state.active,itemId,account);
          const holdingOf=(...args)=>{
            const s=computeHoldingSuggestion(...args);
            if(!s)return null;
            if(listedForSale(s.itemId))return null;
            // A trivial gain must not outrank the whole catalogue; a loss always speaks. See
            // holdingPreempts, and the 205m-idle-versus-152-gp case behind it.
            return holdingPreempts(s,minProfit)?s:null;
          };
          let suggestion=geFull?null:holdingOf(latest,Number(url.searchParams.get('holdItemId')),Number(url.searchParams.get('holdQty')),url.searchParams.get('holdName')||undefined,url.searchParams.get('holdBuyId')||undefined,holdBuyPrice);
          // The live signal above is necessarily empty right after a RuneLite/plugin restart --
          // it only refills by observing a fresh buy-collect this session. Falls back to the
          // bridge's own persistent, on-disk record of open positions (survives any restart,
          // covers a suggested or an unsuggested buy alike) so a position from an earlier session
          // still gets reminded about instead of silently forgotten. See pickPersistentOpenPosition
          // in suggestions.mjs.
          if(!suggestion && !geFull) {
            const openPosition=pickPersistentOpenPosition(state.autoOpenPositions,account,blocklist,listedForSale);
            if(openPosition) {
              suggestion=holdingOf(latest,openPosition.itemId,openPosition.remaining,openPosition.item,openPosition.buyId,openPosition.unitCost);
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
              // This account's own open positions: the holding tier owns those items, and only it
              // can say what was paid for them. See computeInventorySuggestion.
              const positionItemIds=new Set((state.autoOpenPositions||[])
                .filter(pos=>pos&&pos.account===account&&pos.remaining>0&&Number.isFinite(pos.unitCost))
                .map(pos=>pos.itemId));
              suggestion=computeInventorySuggestion(latest,inventory,mappingCache.list,{blocklist:inventoryBlocklist,positionItemIds,membersBlocked});
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
          // The market/pushed ranking at an arbitrary budget, built once and reused. The primary path
          // below keeps its own copy untouched; this exists so the additional-positions loop further
          // down can re-rank against the cash still unspent without that loop having to reach inside
          // the block below. The two fetches it needs are both already cached (itemIndex, and the 1h
          // volumes behind suggestionPrices' 60s cache), so building it a second time is cheap, and
          // it is only ever built when something actually asks for it.
          let marketDeps=null;
          async function marketRankAt(bl,spend,mp) {
            if(!marketDeps) {
              const [,marketVolumes]=await Promise.all([
                itemIndex(),
                volumes?Promise.resolve(volumes):suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/1h',60000).then(t=>JSON.parse(t).data||{}),
              ]);
              let rankPrices=null;
              rankPrices=robustPricesCached();
              marketDeps={marketVolumes,rankPrices};
            }
            const fresh=pushedSuggestions.length && (Date.now()-pushedSuggestionsAt)<=MAX_PUSHED_AGE_MS;
            return fresh
              ?computePushedSuggestion(pushedSuggestions,{minProfit:mp,blocklist:bl,maxSpend:spend,volumes,targetDurationMinutes,
                  rankPrices:marketDeps.rankPrices,limitOf:id=>mappingCache.index?.get(id)?.limit,rankBy:marketRankBy,...sizing,...gates})
              :computeMarketSuggestion(mappingCache.list,latest,marketDeps.marketVolumes,
                {minProfit:mp,blocklist:bl,maxSpend:spend,targetDurationMinutes,maxStackShare,taxFreeOnly,rankPrices:marketDeps.rankPrices,rankBy:marketRankBy,...sizing,...gates});
          }
          if(!suggestion && !geFull && !buysHeldForExits && wantSource!=='market') {
            suggestion=await pickWithForecast({
              // Imported flips rank alongside observed ones (see Store.importFlips): a player who
              // tracked trades elsewhere for months shouldn't be ranked as if they had no history.
              rank:bl=>computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),{minProfit,blocklist:bl,risk,maxSpend,targetDurationMinutes,volumes,maxStackShare,...sizing,...gates}),
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
          const historyPick=comparableAsHistoryPick(suggestion,wantSource)?suggestion:null;
          if(historyPick)suggestion=null;
          if(!suggestion && !geFull && !buysHeldForExits && url.searchParams.get('includeMarket')==='1') {
            const pushedFresh=pushedSuggestions.length && (Date.now()-pushedSuggestionsAt)<=MAX_PUSHED_AGE_MS;
            // The scanner sends 20 rows with no buy limit and its own quantity. These two give the
            // pushed tier the same footing as the market tier: a steady price to rank on, and the
            // item catalogue to size from. Both fail open -- no archive or no mapping simply returns
            // the tier to ranking on the scanner figures, exactly as before.
            let pushedRankPrices=null;
            if(pushedFresh) {
              pushedRankPrices=robustPricesCached();
              try { await itemIndex(); } catch {}
            }
            const limitOf=id=>mappingCache.index?.get(id)?.limit;
            const pushedOpts={maxSpend,volumes,targetDurationMinutes,rankPrices:pushedRankPrices,limitOf,rankBy:marketRankBy,...sizing,...gates};
            let rank,rankAtMinimum,rankPushedOnly=null;
            // The scanner's shortlist is a CANDIDATE SOURCE now, not a tier that takes precedence.
            //
            // It used to replace the market tier outright whenever the scanner had pushed in the last
            // three minutes, so what a player saw depended on whether a browser tab happened to be
            // open. Measured live at an 85m stack on 28 Sept 2026, with everything else identical:
            // the pushed tier offered 11,000 Ruby bolts for 220,000 gp net on 2.9m committed, and the
            // market tier ranking the whole catalogue offered 9 Blue Moon helms for 453,951 on 6.7m --
            // about twice the profit and a bit over twice the capital. The scanner only ever sends its
            // TOP 20 ROWS, chosen by its own browser-side score, so ranking those 20 well (which it
            // now is) cannot make up for 1,721 rows never being considered.
            //
            // So both are ranked and the better of the two is kept, by the same `worthOf` measure and
            // with the same "here is what was set aside" note as the "Best of both" comparison between
            // the player's history and the market. The scanner keeps its real advantages -- price
            // history, the player's own record, news matching -- and wins whenever they actually
            // amount to a better trade, instead of winning by default.
            if(pushedFresh)
              rankPushedOnly=bl=>computePushedSuggestion(pushedSuggestions,{...pushedOpts,minProfit,blocklist:bl});
            {
              const [,marketVolumes]=await Promise.all([
                itemIndex(),
                volumes?Promise.resolve(volumes):suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/1h',60000).then(t=>JSON.parse(t).data||{}),
              ]);
              // A steady price per item from the local archive, used to decide WHICH item wins rather
              // than what it costs (see robustPrices). Empty when the archive is off or too new, and
              // the tier then ranks on `latest` exactly as it did before -- fail open, as ever.
              //
              // Through robustPricesCached, NOT archive.recentHourly. This exact line was the one call
              // site missed when the window widened on 29 Sept 2026, and the failure was silent in the
              // worst way: recentHourly keeps only RECENT_HOURS (26) buckets, so asking it for two
              // weeks returns a DAY and robustPrices happily takes a median of it. The tier went on
              // believing it had a fortnight of evidence while ranking on 26 hours, which is the old
              // behaviour wearing the new one's clothes. Caught because Mort myre fungus kept being
              // offered: its two-week margin is 2 gp against a 4 gp tax, so the tax bar should have
              // dropped it outright, and on a one-day view it passed.
              const rankPrices=robustPricesCached();
              const marketOpts={blocklist:undefined,maxSpend,targetDurationMinutes,maxStackShare,taxFreeOnly,rankPrices,rankBy:marketRankBy,...sizing,...gates};
              rank=bl=>computeMarketSuggestion(mappingCache.list,latest,marketVolumes,{...marketOpts,minProfit,blocklist:bl});
              // Both sources, at any floor, so the "how far would I have to come down" probe and the
              // empty-case fallbacks stay consistent with what the real request would actually give.
              const marketAt=(bl,mp)=>computeMarketSuggestion(mappingCache.list,latest,marketVolumes,{...marketOpts,minProfit:mp,blocklist:bl});
              rankAtMinimum=(bl,mp)=>{
                const m=marketAt(bl,mp);
                if(!rankPushedOnly)return m;
                const p=computePushedSuggestion(pushedSuggestions,{...pushedOpts,minProfit:mp,blocklist:bl});
                if(!p)return m;
                if(!m)return p;
                // No await available here (the probe calls this synchronously), so the cheap
                // comparison: the quoted margin. `worthOf` does the careful one on the real path.
                const worth=s=>(s.sellPrice-estimateUnitTax(s.itemId,s.sellPrice)-s.buyPrice)*(s.quantity||1);
                return worth(p)>=worth(m)?p:m;
              };
            }
            const checksFor={forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,
              cushionFor:cushionForSuggestion,requireCushion,correlationFor:correlationForSuggestion,
              supportFor:supportForSuggestion,onDemoted};
            // Each pass gets its OWN blocklist copy: pickWithForecast adds to the set it is handed as
            // it rejects candidates, so sharing one would let the first pass hide items from the
            // second and make the comparison depend on which ran first.
            const marketPick=await pickWithForecast({...checksFor,rank,blocklist:new Set(blocklist),
              onBlocked:rows=>{heldBack.push(...rows);}});
            const pushedPick=rankPushedOnly
              ? await pickWithForecast({...checksFor,rank:rankPushedOnly,blocklist:new Set(blocklist),
                  onBlocked:rows=>{heldBack.push(...rows);}})
              : null;
            if(!pushedPick) suggestion=marketPick;
            else if(!marketPick) suggestion=pushedPick;
            else {
              const gp=n=>Math.round(n).toLocaleString('en-US');
              const [scanner,wide]=await Promise.all([worthOf(pushedPick),worthOf(marketPick)]);
              // Ties go to the scanner, which knows things the bridge does not -- the player's own
              // record on that item, its price history and any news attached to it. Only a market
              // pick that is genuinely worth more displaces it, and the loser is named either way.
              if(scanner.value>=wide.value) {
                suggestion=pushedPick;
                if(marketPick.itemId!==pushedPick.itemId)heldBack.push({itemId:marketPick.itemId,
                  reason:'A market-wide '+marketPick.name+' worth about '+gp(wide.value)
                    +' gp, set aside for your scanner’s '+pushedPick.name+' at about '+gp(scanner.value)+' gp.'});
              } else {
                suggestion=marketPick;
                if(marketPick.itemId!==pushedPick.itemId)heldBack.push({itemId:pushedPick.itemId,
                  reason:'Your scanner’s '+pushedPick.name+' is worth about '+gp(scanner.value)
                    +' gp at the price buyers are paying, against '+gp(wide.value)+' gp for a market-wide '
                    +marketPick.name+', so EVI looked past the shortlist this time.'});
              }
            }
            // Say so when the reason the player's own history was passed over is the floor, not an
            // empty history. One extra ranking pass, only on the poll where that actually happened.
            if(suggestion&&!minProfitChosen) {
              try {
                const ownBest=computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),
                  {minProfit:0,blocklist,risk,maxSpend,targetDurationMinutes,volumes,maxStackShare,...sizing,...gates});
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
            // Two faults found on 28 Sept 2026, both of which made this line understate what is
            // available and so talk a player out of a setting they could actually have met.
            //
            // It ranked ONLY the market tier, because the ranking helpers live inside this market
            // block and the personal tier is above it. At a 500k minimum it reported "Amethyst dart, 66,000" while the personal
            // tier was holding a Twisted relic hunter (t3) worth 439,020 -- the same pick Auto was
            // offering at that very moment. Six and a half times understated, and identical at every
            // tier from 100k to 2m, which is what made it look like a fixed answer rather than a
            // measurement. Both tiers are ranked now and the better of the two is reported.
            //
            // And it reported the QUOTED spread, the same fiction the headline used to. The Amethyst
            // dart's 66,000 was really 34,223 at the price buyers were paying. This line exists to
            // tell someone the truth about what is within reach, so it goes through `worthOf` -- the
            // same reading, the same cache -- and reports the cautious figure, exactly as the headline
            // now does. It is still a statement of what exists rather than a suggestion: it goes
            // through none of the safety checks and is never something EVI tells anyone to buy.
            if(!suggestion && minProfit>0) {
              try {
                // Probed down the settings ladder rather than run once at no minimum, because the
                // ranking is not ordered by profit and running it at zero answers a different question
                // than the one asked. At a 500k minimum on 28 Sept this reported "Infinity bottoms,
                // 82,046" -- the top-ranked pick once the floor was removed -- while the very same
                // tier returned a Twisted relic hunter (t3) worth 439,020 at a 200k minimum. Both
                // numbers were true; only the second answers "how far would I have to come down".
                // Lowering the floor admits more candidates, and a newly admitted one can outrank what
                // was already there, so the reported figure does not rise or fall monotonically as the
                // floor drops and no single pass can be trusted to find the best rung.
                //
                // The rungs are MinProfitTier's own, so the answer is always a setting the player can
                // actually pick, and only rungs below their current one are tried. Several ranking
                // passes, but only on a poll that already found nothing, so the normal path is
                // untouched. Still a statement of what exists: it goes through none of the safety
                // checks and is never something EVI tells anyone to buy.
                // Every rung goes through the SAME checks the real path runs, which is the whole
                // point and was got wrong first time round. Reported by novi on 28 Sept 2026, three
                // messages that contradicted one another: on Auto and on 200k it said "set it to
                // 100,000 gp and the best this cash stack can do is 3rd Age robe, at about 441,621",
                // and on 100,000 it said nothing passes and offered a Bronze arrow worth 812.
                //
                // Both were produced by this block, and the first was false. The probe ranked with
                // computeSuggestion/rankAtMinimum directly, so it saw only the floor; the real path
                // ranks through pickWithForecast, which then applies the forecast, cushion,
                // correlation and sell-support checks. The robe cleared 100,000 on margin and was
                // refused by a check, so the advice was to move a setting to reach a trade that would
                // not have been offered there either.
                //
                // A line that exists to stop a player thinking EVI is broken must never send them to
                // a setting that gives them nothing -- that is worse than saying nothing at all. It
                // costs several full passes, but only on a poll that already found nothing, and it
                // stops at the first rung that yields a trade. onBlocked/onDemoted are no-ops here so
                // the probe cannot add to heldBack, which describes the real request.
                const probeChecks={forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,
                  cushionFor:cushionForSuggestion,requireCushion,correlationFor:correlationForSuggestion,
                  supportFor:supportForSuggestion,blocklist,onBlocked:()=>{},onDemoted:()=>{}};
                const rungs=[2000000,1000000,500000,200000,100000,1].filter(r=>r<minProfit);
                for(const rung of rungs) {
                  const candidates=[];
                  if(wantSource!=='market') {
                    try {
                      const own=await pickWithForecast({...probeChecks,
                        rank:bl=>computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),
                          {minProfit:rung,blocklist:bl,risk,maxSpend,targetDurationMinutes,volumes,maxStackShare,...sizing,...gates})});
                      if(own)candidates.push(own);
                    } catch {}
                  }
                  if(url.searchParams.get('includeMarket')==='1') {
                    try {
                      const m=await pickWithForecast({...probeChecks,rank:bl=>marketRankAt(bl,maxSpend,rung)});
                      if(m)candidates.push(m);
                    } catch {}
                  }
                  let best=null;
                  for(const c of candidates) {
                    if(!(Number.isFinite(c.buyPrice)&&Number.isFinite(c.sellPrice)&&Number.isFinite(c.quantity)))continue;
                    const w=await worthOf(c);
                    const profit=headlineProfit(Math.round(w.quoted),Number.isFinite(w.supported)?w.supported:null);
                    // And it has to clear the rung it is being advertised at. A pick can pass the
                    // ranking on its quoted margin and be worth less once sell-support is read, and
                    // naming it under a setting its true figure cannot meet repeats the same lie in
                    // a quieter voice.
                    if(Number.isFinite(profit)&&profit>0&&profit>=rung&&(!best||profit>best.profit))
                      best={name:c.name||null,itemId:c.itemId??null,profit,atMinimum:rung};
                  }
                  if(best){reachable=best;break;}
                }
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
          // Auto never goes silent. Reported by novi on 28 Sept 2026: at Auto and at every explicit
          // tier EVI suggested nothing, and only "No minimum at all" produced anything -- "I think
          // that option should be the auto option but actually look at what's possible."
          //
          // The fault was making the stack-scaled Auto floor a GATE. It was added earlier the same
          // day for a real reason -- with 89m in hand EVI was offering trades worth 500 gp to 12k,
          // and the instruction was that it should always look at the cash stack -- but on a large
          // stack 0.1% can exceed everything the market currently has, and then the floor is not
          // protecting anyone, it is just refusing to answer. A player who has expressed NO
          // preference has not asked to be told nothing; they have asked EVI to decide.
          //
          // So under Auto the stack-scaled figure is a PREFERENCE, not a cutoff: it is tried first,
          // and when nothing clears it EVI steps down and answers with the best trade that still
          // passes every genuine safety check -- margin over tax, sell-support, fill history,
          // correlation, the lot. Only the profit target moves; nothing protective is relaxed. An
          // explicit tier the player chose stays a gate, because that is a decision rather than an
          // absence of one.
          //
          // This also removes the trap that produced the report: if "No minimum at all" is the only
          // setting that yields anything, players will use it -- and MinProfitTier.NONE switches off
          // the margin-over-tax check too, so silence above it was pushing people to give up a real
          // safety net to get any answer at all.
          let steppedDownFrom=null;
          if(!suggestion && !minProfitChosen && !geFull && !buysHeldForExits && minProfit>AUTO_MIN_PROFIT) {
            const stepChecks={forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,
              cushionFor:cushionForSuggestion,requireCushion,correlationFor:correlationForSuggestion,
              supportFor:supportForSuggestion,blocklist,onBlocked:rows=>{heldBack.push(...rows);},onDemoted};
            let stepped=null;
            if(wantSource!=='market') {
              try {
                stepped=await pickWithForecast({...stepChecks,
                  rank:bl=>computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),
                    {minProfit:AUTO_MIN_PROFIT,blocklist:bl,risk,maxSpend,targetDurationMinutes,volumes,maxStackShare,...sizing,...gates})});
              } catch {}
            }
            if(!stepped&&url.searchParams.get('includeMarket')==='1') {
              try { stepped=await pickWithForecast({...stepChecks,rank:bl=>marketRankAt(bl,maxSpend,AUTO_MIN_PROFIT)}); } catch {}
            }
            if(stepped) {
              suggestion=stepped;
              steppedDownFrom=minProfit;
              // Said plainly on the pick itself, so the player knows this is the best available
              // rather than a trade EVI rates as highly as usual. It rides the reasoning text, which
              // every version of the plugin already shows, so no client change is needed for it.
              const gp=n=>Math.round(n).toLocaleString('en-US');
              suggestion.belowUsualBar=minProfit;
              suggestion.reasoning=(suggestion.reasoning?suggestion.reasoning+' ':'')
                +'Smaller than usual: nothing reached the '+gp(minProfit)
                +' gp Auto is aiming for with this cash stack, so this is the best trade available'
                +' right now. Every safety check still applies to it.';
            }
          }

          // More than one position at a time, only when the player has asked for it.
          //
          // The default is 1 and at 1 not a line of this runs, so the single-suggestion path above is
          // exactly what it was. novi's objection to the original "plan all eight slots" idea still
          // governs the design and is worth restating: allocating a stack across eight trades divides
          // the cash by eight, and an eighth-sized trade cannot make the profit they trade for. The
          // only form they would accept was "up to N, where the player chooses N, defaulting to 1",
          // and that is what this is.
          //
          // Why it exists at all, measured 28 Sept 2026: at an 89m stack the market tier's median
          // suggestion commits about 3.6m, leaving the overwhelming majority idle, and no ranking
          // change fixes that -- the median trade is roughly 600k gp whatever the ranking rule,
          // because one order is held to about 4% of the volume that will trade in the player's
          // window and tools/fill-by-size.mjs measured that cap's limit rather than guessing it. More
          // capital can only be deployed through more positions, never through bigger ones.
          //
          // Nothing here is a split of the stack. Each further pick is ranked on the cash still
          // UNSPENT after the ones before it and has to earn its place on its own merits: the same
          // tiers, the same minimum profit, the same forecast, cushion, correlation and sell-support
          // checks. When the remaining cash cannot buy anything that passes, the loop simply stops,
          // which is the honest answer and the common one.
          const wantPositions=positionsWanted(url.searchParams);
          const additional=[];
          if(suggestion&&wantPositions>1&&!geFull&&!buysHeldForExits) {
            // A further buy may never take a slot the exits already owed are going to need, so the
            // sell reserve is honoured here exactly as it is for the first pick -- and one slot is
            // already spoken for by that first pick. An unknown free-slot count (the plugin sends
            // none) falls back to the player's own ceiling rather than inventing capacity.
            let slotsLeft=capacity.free===null
              ?wantPositions-1
              :Math.max(0,capacity.free-sellSlotsOwed-1);
            let budget=maxSpend===undefined
              ?undefined
              :Math.max(0,maxSpend-(suggestion.buyPrice||0)*(suggestion.quantity||0));
            let previous=suggestion;
            while(additional.length<wantPositions-1&&slotsLeft>0) {
              // The item just taken is now exposure, so the correlation check refuses a second
              // position correlated with the first -- two slots in correlated items are one bet
              // wearing two hats, which was novi's own objection. And it is blocked from being
              // picked again, since the same item twice is one position, not two.
              if(Number.isFinite(previous.itemId)) { exposure.add(previous.itemId); blocklist.add(previous.itemId); }
              const spend=budget;
              if(spend!==undefined&&!(spend>0))break;
              const checks={forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,
                cushionFor:cushionForSuggestion,requireCushion,correlationFor:correlationForSuggestion,
                supportFor:supportForSuggestion,blocklist,onBlocked:()=>{},onDemoted:()=>{}};
              let next=null;
              if(wantSource!=='market')
                next=await pickWithForecast({...checks,
                  rank:bl=>computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),
                    {minProfit,blocklist:bl,risk,maxSpend:spend,targetDurationMinutes,volumes,maxStackShare,...gates})});
              if(!next&&url.searchParams.get('includeMarket')==='1')
                next=await pickWithForecast({...checks,rank:bl=>marketRankAt(bl,spend,minProfit)});
              if(!next)break;
              additional.push(next);
              if(budget!==undefined)budget=Math.max(0,budget-(next.buyPrice||0)*(next.quantity||0));
              slotsLeft--;
              previous=next;
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
          const logged=suggestionLog.record({account:url.searchParams.get('account')||undefined,suggestion,
            context:{cash:maxSpend??null,durationMinutes:targetDurationMinutes??null,minProfit:minProfit||null,risk,
              heldBack:heldBack.length?heldBack.map(h=>({itemId:h.itemId,reason:h.reason})):null,
              demotedPicks:demotedPicks.length?demotedPicks:null,
              // The fill odds behind the pick, kept so these calls can be scored later like every other check.
              fillHistory:thinStats?{hoursTraded:thinStats.hoursTraded,hours:thinStats.hours,
                cadence:Math.round(thinStats.cadence*1000)/1000,
                recurrence:thinStats.recurrence[windowFor(targetDurationMinutes)],
                unitsAvailable:thinStats.unitsWithin[windowFor(targetDurationMinutes)]}:null,
              buysHeldForExits:!!buysHeldForExits}});
          // The handle the plugin echoes back when the player says they took this pick, which turns
          // the track record from an inference into an observation (see acceptances.mjs). A repeat
          // of the same pick keeps its first id, so accepting one that has been on screen a while
          // still refers to a real log entry. Absent only if the log could not be written, in which
          // case the plugin simply shows no button rather than offering one that cannot work.
          if(suggestion&&logged&&logged.id){suggestion.id=logged.id;suggestion.accepted=acceptances.wasAccepted(logged.id);}
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
          // What this account is HOLDING, stated whatever the profit setting says -- novi, 30 Sept:
          // "it should be able to see it no matter the profit setting since it is a item we bought".
          // A separate question from "what should I do next", so a separate channel: the suggestion
          // slot still decides what to ADVISE, and holdingPreempts still governs that, unchanged.
          // See holdingsAdvice.mjs for why the bar was not lowered instead.
          const holdingNotes=holdingsAdvice({
            positions:(state.autoOpenPositions||[]).filter(p=>!account||p.account===account),
            prices:latest,
            listedItemIds:new Set(state.active.filter(o=>o.state==='SELLING'&&(!account||o.account===account)).map(o=>o.itemId)),
            suggestedItemId:suggestion?suggestion.itemId:null,
          }).map(n=>({itemId:n.itemId,name:n.name,message:n.message,level:n.level,label:n.label,
            figures:n.figures,holding:true,belowBreakEven:false}));
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
              crashNotes.push({itemId,name,message:crashMessage(c,{name,mine}),belowBreakEven:false,
              level:'warn',label:'Crashing',figures:mine?'One of yours':'Watch before buying'});
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
          // What EVI makes of its own pick, as something the sidebar can draw rather than prose to be
          // read (see verdict.mjs). The reasoning is unchanged and still sent: this summarises it and
          // invents nothing. Null when nothing was measured, which a panel reads as "no opinion" and
          // falls back to the prose -- so an older bridge and a newer plugin still agree.
          // Applied to the primary pick and, identically, to every additional one: an extra position
          // gets the same verdict and the same cautious headline, or it would be the one card on the
          // panel whose number nobody had checked.
          const enrich=(s,stats)=>{
          if(s) {
            const suggestion=s;
            // The fill-history reading was already computed for the log (thinStats, above). Carrying it
            // onto the suggestion is what lets the card say "traded 312 of the last 335 hours" instead
            // of that figure living only in a file nobody reads.
            if(stats&&Number.isFinite(stats.hoursTraded)&&Number.isFinite(stats.hours))
              suggestion.fillHistory={hoursTraded:stats.hoursTraded,hours:stats.hours};
            const v=suggestionVerdict(suggestion);
            if(v)suggestion.verdict=v;
            // The panel should not have to know the tax rules to print the headline figure.
            //
            // The headline is the CAUTIOUS of two figures, not the quoted spread, whenever a
            // sell-support reading exists. Measured 28 Sept 2026: an Ape atoll teleport (tablet) was
            // headlined at 92,356 gp because the Wiki's `latest.high` of 28,756 was a single print --
            // every hourly average that day sat between 6,000 and 6,300, and EVI's own sell-support
            // had already read 1,115 buyers paying an average of 6,379, making the trade worth 4,641.
            // Every downstream check behaved: the pick was demoted, the reasoning said so in full, and
            // the verdict card read "Worth less than it looks". The one number a player actually acts
            // on was still the one EVI itself did not believe -- and, worse, it was what the Auto stack
            // floor got compared against, so a 92,356 fiction cleared an 89,000 floor that the true
            // 4,641 could never have cleared. Never fabricate a number is the standing rule here.
            //
            // `implausibleSpread` does not catch this case and is not the place to: it requires that
            // NOTHING traded in the hour, which is right for a stale print on a dead item, while this
            // tablet trades about a hundred an hour. An outlier print in a liquid market needs the
            // measured average, which sell-support already had.
            //
            // The LOWER of the two on purpose, rather than simply preferring the supported figure. The
            // average buyers paid can sit above the player's own ask (an Ornate maul handle the same
            // day quoted 2,474 and supported 9,865), and EVI must not headline a number that depends
            // on selling higher than it is telling them to list. The quoted spread caps the promise;
            // the supported reading caps the optimism. `quotedProfit` is kept beside it so nothing
            // downstream loses the figure the spread implies.
            if(Number.isFinite(suggestion.buyPrice)&&Number.isFinite(suggestion.sellPrice)) {
              const q=suggestion.quantity>0?suggestion.quantity:1;
              const quoted=Math.round(
                (suggestion.sellPrice-suggestion.buyPrice-estimateUnitTax(suggestion.itemId,suggestion.sellPrice))*q);
              const support=suggestion.sellSupport;
              const supported=support&&Number.isFinite(support.netAtAverage)
                ?Math.round(support.netAtAverage*q):null;
              suggestion.quotedProfit=quoted;
              // Stock EVI never saw bought has NO cost basis, so the spread between today's low and
              // high is not a profit -- it is what a round trip WOULD have made, on an item the
              // player already owns and did not buy at the low. Sending it would put a confident
              // green "+171,735" on a card whose own prose says "worth an estimated 4,442,921 ...
              // no buy EVI ever observed". Null instead: the panel omits the figure entirely
              // (it already guards on null) and the verdict states the worth as a fact instead.
              // Never estimated, the same rule breakEvenPrice follows in the holding tier.
              suggestion.expectedProfit=suggestion.source==='inventory'
                ?null
                :headlineProfit(quoted,supported);
            }
          }
          };
          enrich(suggestion,thinStats);
          // No thinStats for the extra picks: that reading is computed once, for the primary, and
          // costs an archive pass each. They get every other check, and the panel shows no fill-history
          // line for them rather than a figure borrowed from a different item.
          for(const a of additional)enrich(a,null);
          return send(200,{suggestion,additional,openItemPrice,slotPrices,slotFill,relistAdvice:[...crashNotes,...sellNotes,...buyNotes,...relist,...holdingNotes],
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
        const rows=joinSuggestionOutcomes(suggestionLog.recent(2000),[...store.offers.values()],[...state.flips,...state.autoFlips],{wasAccepted:acceptances.wasAccepted});
        return send(200,{periods:tradingPeriods(rows)});
      }
      if(pathname==='/api/suggestion-outcomes') {
        const state=store.state();
        const rows=joinSuggestionOutcomes(suggestionLog.recent(500),[...store.offers.values()],[...state.flips,...state.autoFlips],{wasAccepted:acceptances.wasAccepted});
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
      // Each item's steady price -- the median of both sides over the last day of archived hours, the
      // same reading the market tier ranks on (see robustPrices). Served so the scanner can show the
      // cautious figure the sidebar now shows, instead of the quoted spread alone.
      //
      // Why the scanner needs a route rather than working it out itself: the honest figure the bridge
      // puts on a single suggestion comes from sell-support, which fetches that item's 12-hour
      // timeseries from the Wiki. The scanner ranks 1,741 rows at once, so per-row timeseries is not
      // available to it at any price. The archive answers the same question -- what has this item
      // steadily been worth, rather than what did one person last pay -- in one local pass.
      //
      // An empty object when the archive is off or too new, which the scanner reads as "no steady
      // reading" and falls back to the quoted spread exactly as before. Cached for five minutes: it
      // moves once an hour at most.
      if(pathname==='/api/robust-prices') {
        return send(200,{hours:ROBUST_PRICE_HOURS,prices:robustPricesCached()});
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
        else if(name==='timeseries'&&/^\d{1,8}$/.test(url.searchParams.get('id')||'')&&['5m','1h','6h','24h'].includes(url.searchParams.get('timestep'))) {
          upstream='https://prices.runescape.wiki/api/v1/osrs/timeseries?'+new URLSearchParams({id:url.searchParams.get('id'),timestep:url.searchParams.get('timestep')});
          // Set here on purpose rather than inherited from the default above. The scanner's
          // prediction button leans on it: pressing it again inside this window costs the Wiki
          // nothing, and that promise should not rest on what some other route's default happens
          // to be. A price series moves slowly enough that five minutes is generous either way.
          ttl=300000;
        }
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
      // Setup, and the only page that ships WITH the bridge rather than with the browser scanner.
      // The scanner is not part of the published bridge, which left a plugin-only user with no way to
      // do two things that are not optional extras: import the trade history they already have (the
      // Exchange Logger importer had routes but no interface), and switch on the price archive, which
      // is off until something asks for it -- so the fill-history and sell-support checks had nothing
      // to read and silently stayed quiet for every Hub user. A player's own history is meant to be an
      // extra safety layer, never a prerequisite, and it cannot be either if there is no way to hand
      // it over. See the 2026-09-27 README entry.
      const setupPage=()=>send(200,fs.readFileSync(path.join(root,'bridge','setup.html'),'utf8'),'text/html');
      if(pathname==='/setup')return setupPage();
      // The CSV parser ships with the bridge (see csvImport.mjs) and is served to the browser, because
      // both the setup page here and the scanner's own importer run it there rather than uploading a
      // file. scanner/import-core.mjs re-exports this path, so the scanner keeps working unchanged.
      if(pathname==='/csvImport.mjs')
        return send(200,fs.readFileSync(path.join(root,'bridge','csvImport.mjs'),'utf8'),'text/javascript');
      if(files[pathname]) {
        // The browser scanner is optional: the bridge is useful on its own (the RuneLite plugin
        // talks to the API above). Fall back to the setup page rather than a bare 404 when the
        // scanner folder isn't installed alongside it -- that is the normal case for anyone who
        // installed the bridge from its own repository or from a packaged bundle.
        try {return send(200,fs.readFileSync(path.join(root,'scanner',files[pathname]),'utf8'),pathname==='/'?'text/html':'text/javascript');}
        catch {
          if(pathname==='/')return setupPage();
          return send(404,{error:'The browser scanner is not installed next to this bridge. The RuneLite plugin works without it.'});
        }
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
