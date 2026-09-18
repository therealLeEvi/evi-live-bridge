import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {Store} from './store.mjs';
import {createMarketCache} from './marketCache.mjs';
import {computeSuggestion,computeMarketSuggestion,computeHoldingSuggestion,computeInventorySuggestion,computePushedSuggestion,pickPersistentOpenPosition,lookupItemPrice,forecastFromSeries,timestepForHorizon,pickWithForecast,estimateOfferFill,estimateVolatility,marginClearsCushion,slotCapacity,slotNote} from './suggestions.mjs';
import {estimateUnitTax} from './tax.mjs';
import {createSuggestionLog} from './suggestionLog.mjs';
import {joinSuggestionOutcomes,summarizeOutcomes} from './suggestionOutcomes.mjs';
import {createPriceArchive,readArchive} from './priceArchive.mjs';
import {buildFillModel,fillChance,fillChanceSentence} from './fillModel.mjs';
import {relistAdvice} from './relist.mjs';

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
  const suggestionLog=createSuggestionLog(dir),archive=createPriceArchive({dir,log:m=>console.error(m)});
  // The player's own fill record (see fillModel.mjs), rebuilt at most hourly and only from the
  // archived hours their own offers actually fall in -- reading 90 days of archive on every
  // suggestion would be absurd. Never fatal: any failure just means suggestions carry no fill
  // sentence, exactly as before this existed.
  let fillModelCache={at:0,model:null};
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
  let mappingCache={text:null,list:null,index:null};
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
      if(pathname==='/api/suggestion/personal-use'&&req.method==='POST') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        const b=await body();
        return send(200,store.markPersonalUse({buyId:b.buyId,personal:b.personal===undefined?true:b.personal}));
      }
      if(pathname==='/api/suggestion'&&req.method==='GET') {
        if(!same(req.headers.authorization,`Bearer ${secrets.plugin}`))return send(401,{error:'Plugin key required'});
        try {
          const text=await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/latest',60000);
          const latest=JSON.parse(text).data||{};
          // Optional per-request tuning from the plugin's own config (min predicted profit, an item
          // blocklist, a risk tier); all default to the original unfiltered/medium behaviour.
          const minProfit=Math.max(0,Number(url.searchParams.get('minProfit'))||0);
          const blocklist=new Set((url.searchParams.get('blocklist')||'').split(',').map(s=>parseInt(s,10)).filter(Number.isFinite));
          // Session-only exclusions from the plugin, not a config setting: items already occupying
          // an active/uncollected GE slot (so the same item isn't suggested again right after you've
          // acted on it) and items the player manually skipped via the sidebar. Folded straight into
          // the same blocklist set the ranking already respects -- no separate exclusion path needed.
          for(const id of (url.searchParams.get('exclude')||'').split(',').map(s=>parseInt(s,10)).filter(Number.isFinite))blocklist.add(id);
          const riskParam=url.searchParams.get('risk');
          const risk=['low','medium','high'].includes(riskParam)?riskParam:'medium';
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
          async function itemIndex() {
            const text=await suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/mapping',3600000);
            // The market cache hands back the same string for an hour, so this reparses only when
            // the mapping itself was refetched.
            if(mappingCache.text!==text) {
              const list=JSON.parse(text);
              mappingCache={text,list,index:new Map(list.filter(i=>i&&Number.isFinite(i.id)).map(i=>[i.id,i]))};
            }
            return mappingCache.index;
          }
          // Only built when something could actually use them: a free-to-play world needs the
          // members flag, and the buy-limit check needs to know whose journal to read.
          let membersBlocked, limitFor;
          if(freeToPlayWorld||account) {
            const index=await itemIndex();
            if(freeToPlayWorld)membersBlocked=itemId=>index.get(itemId)?.members===true;
            if(account)limitFor=itemId=>{
              const limit=index.get(itemId)?.limit;
              if(!Number.isFinite(limit)||limit<=0)return null; // unknown limit: no constraint
              const {used}=store.buyLimitUsage(account,itemId);
              return {limit,remaining:Math.max(0,limit-used)};
            };
          }
          const gates={membersBlocked,limitFor};
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
          if(!suggestion && !geFull) {
            suggestion=await pickWithForecast({
              // Imported flips rank alongside observed ones (see Store.importFlips): a player who
              // tracked trades elsewhere for months shouldn't be ranked as if they had no history.
              rank:bl=>computeSuggestion([...state.flips,...state.importedFlips],latest,Date.now(),{minProfit,blocklist:bl,risk,maxSpend,targetDurationMinutes,volumes,maxStackShare,...gates}),
              forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,
              cushionFor:cushionForSuggestion,requireCushion,blocklist,
            });
          }
          // Only reached when personal history has nothing eligible right now, and only when the
          // plugin's own config opted in: an item-catalogue-wide fallback, not gated on any
          // reviewed flip for that item. Prefers a recent scanner-pushed shortlist (richer -- price
          // history, liquidity, this account's own trades, see computePushedSuggestion) when one's
          // available and not stale; otherwise falls back to computeMarketSuggestion exactly as
          // before scanner-pushing existed, so a plugin user who never opens the scanner sees no
          // change and pays no extra mapping/volume fetch for a tier that will just fall through.
          if(!suggestion && !geFull && url.searchParams.get('includeMarket')==='1') {
            const pushedFresh=pushedSuggestions.length && (Date.now()-pushedSuggestionsAt)<=MAX_PUSHED_AGE_MS;
            let rank;
            if(pushedFresh) {
              rank=bl=>computePushedSuggestion(pushedSuggestions,{minProfit,blocklist:bl,maxSpend,...gates});
            } else {
              const [,marketVolumes]=await Promise.all([
                itemIndex(),
                volumes?Promise.resolve(volumes):suggestionPrices.get('https://prices.runescape.wiki/api/v1/osrs/1h',60000).then(t=>JSON.parse(t).data||{}),
              ]);
              rank=bl=>computeMarketSuggestion(mappingCache.list,latest,marketVolumes,{minProfit,blocklist:bl,maxSpend,targetDurationMinutes,maxStackShare,taxFreeOnly,...gates});
            }
            suggestion=await pickWithForecast({rank,forecastFor:forecastForSuggestion,policy:forecastPolicy,horizon:forecastHorizon,cushionFor:cushionForSuggestion,requireCushion,blocklist});
          }
          // Independent of the ranked `suggestion` above: a plain live-market price for whatever
          // item the plugin says is currently open in a GE offer (openItemId, sent whenever a slot
          // is open, buy or sell -- see EviLivePlugin's own openOfferItemId), regardless of flip
          // history or ranking. Reuses the same `latest` data already fetched above, so this costs
          // nothing extra. Lets the plugin's hint/hotkey work for any item being traded, not only
          // the single top-ranked pick returned as `suggestion`.
          const openItemId=Number(url.searchParams.get('openItemId'));
          const openItemPrice=Number.isFinite(openItemId)?lookupItemPrice(latest,openItemId):null;
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
          suggestionLog.record({account:url.searchParams.get('account')||undefined,suggestion,
            context:{cash:maxSpend??null,durationMinutes:targetDurationMinutes??null,minProfit:minProfit||null,risk}});
          // Time-based relist advice for sell offers that have been sitting (see relist.mjs). Built
          // from the bridge's own journal, which knows when each offer was placed and what its stock
          // cost, so the plugin needs to send nothing extra for it.
          const liveSells=state.active.filter(o=>['SELLING','CANCELLED_SELL'].includes(o.state)&&o.filled<o.total&&(!account||o.account===account));
          const costBasis=new Map((state.autoOpenPositions||[]).filter(p=>!account||p.account===account).map(p=>[p.itemId,p.unitCost]));
          const relistPrices=Object.fromEntries(liveSells.map(o=>[String(o.itemId),lookupItemPrice(latest,o.itemId)]).filter(([,p])=>p));
          const relist=relistAdvice({
            offers:liveSells.map(o=>({itemId:o.itemId,name:o.name,price:o.price,remaining:Math.max(0,o.total-o.filled),firstSeen:o.firstSeen})),
            prices:relistPrices,costBasis,targetDurationMinutes:targetDurationMinutes??1440,
          });
          // slots: what the GE's own capacity allowed on this call, echoed back so the sidebar (and
          // anything else reading this endpoint) can tell "nothing passed your settings" apart from
          // "your settings were never consulted, because there was nowhere to place an offer".
          return send(200,{suggestion,openItemPrice,slotPrices,slotFill,relistAdvice:relist,slots:capacity});
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
        if(pathname==='/api/price-archive')return send(200,archive.configure(await body()));
        // Completed flips from another tracker, sent in small batches by tools/import-copilot.mjs
        // (the request-body cap here is deliberately small). Ranking history only -- see
        // Store.importFlips for why these never touch the observed-profit total.
        if(pathname==='/api/flips/import')return send(200,store.importFlips(await body()));
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
      if(pathname==='/api/state')return send(200,store.state());
      if(pathname==='/api/price-archive')return send(200,archive.status());
      // How EVI's own suggestions actually turned out (see suggestionOutcomes.mjs). Scanner-gated
      // like every other view of the player's own data.
      if(pathname==='/api/suggestion-outcomes') {
        const state=store.state();
        const rows=joinSuggestionOutcomes(suggestionLog.recent(500),[...store.offers.values()],[...state.flips,...state.autoFlips]);
        return send(200,{summary:summarizeOutcomes(rows),recent:rows.slice(-25).reverse()});
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
            const r=await fetch(upstream,{headers:{'User-Agent':'EVI-Live/3.0 (personal local OSRS market scanner)'},signal:AbortSignal.timeout(15000),redirect:'error'});
            if(!r.ok)throw Error('Public source returned HTTP '+r.status);
            const text=await r.text();if(text.length>10000000)throw Error('Public response too large');return text;
          })();
          hit={until:Date.now()+ttl,pending};cache.set(upstream,hit);
          pending.catch(()=>cache.delete(upstream));
        }
        try {const text=await hit.pending;res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});return res.end(text);}
        catch(e){return send(502,{error:e.message});}
      }
      const files={'/':'EVI_Flip_Scanner_V3.html','/live.js':'live.js','/performance.js':'performance.js','/performance-core.mjs':'performance-core.mjs','/preferences.js':'preferences.js','/lookup.js':'lookup.js','/import-ui.js':'import-ui.js','/import-core.mjs':'import-core.mjs','/import-worker.mjs':'import-worker.mjs','/workbook-import.mjs':'workbook-import.mjs','/vendor/xlsx.mjs':'vendor/xlsx.mjs'};
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
