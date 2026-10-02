import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {saleProceeds} from './tax.mjs';

const states = new Set(['EMPTY','BUYING','SELLING','BOUGHT','SOLD','CANCELLED_BUY','CANCELLED_SELL']);
const id = x => typeof x === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(x);
const integer = (x, min=0, max=2147483647) => Number.isSafeInteger(x) && x >= min && x <= max;

// Identifies an imported flip by what it IS rather than by which tool described it, so the same trade
// cannot be imported twice through two routes with incompatible fingerprints. See the comment on
// this.importedContent for how that was found. The account is part of the key because the same flip on
// two accounts is two flips; the item name is not, because two tools may spell it differently while
// meaning the same id.
const importedContentKey = f =>
  [f.itemId, (f.account ?? ''), f.quantity, f.profit, f.firstBuy, f.lastSell].join('|');
export const finished = o => o && (['BOUGHT','SOLD','CANCELLED_BUY','CANCELLED_SELL'].includes(o.state) || (o.total > 0 && o.filled === o.total));

// A "margin check": the one-item probe a flipper places at a deliberately bad price to find out what
// an item really buys and sells for. It is not a trade, and counting it as one is actively harmful --
// a probe buys high and sells low, so each pair looks like a small losing flip, dragging down win
// rates, the fill-time model and EVI's own scorecard for something the player never intended as a flip.
//
// Recognised the same way Flipping Utilities does (BSD-2, idea only, not code): exactly one item,
// filled almost immediately. MARGIN_CHECK_TICKS is deliberately tight -- a real one-item flip of an
// expensive item (a Voidwaker, a Crimson kisten) can take hours, and this account's own history is
// full of genuine single-item trades, so anything slower than a couple of ticks must never be caught
// by this.
//
// `ticksToFill` comes from the plugin (see EviLivePlugin.capture) and is -1 when unknown -- including
// for every offer journalled before this existed. Unknown is never treated as a margin check: an
// offer is only excluded on positive evidence, never on a guess about what the player meant.
//
// Speed alone turned out NOT to be enough, and the failure was a real one. The first time this rule
// ever fired on live data it was wrong: a genuine one-item sale of an Eclipse Moon chestplate (broken)
// into a waiting buyer filled in 1 tick and was classed as a probe. That silently erased a real
// -11,907 loss from the books and left the journal believing the item was still held, so EVI
// suggested selling it again after it had already been sold. A single fast fill is what a real trade
// looks like whenever someone is already bidding at your price.
//
// So a probe must ALSO carry the fingerprint it has by construction: it is priced deliberately
// off-market -- a buy well above, a sell well below -- and the Grand Exchange fills at the older
// offer's price, so a probe gets a strictly BETTER price than it asked. The chestplate sale filled at
// exactly its own asking price. Requiring both can only make fewer offers count as probes, which is
// the safe direction: mistaking a probe for a trade adds one small losing flip the player can remove
// in review, while mistaking a trade for a probe hides a real loss and invents a phantom position.
export const MARGIN_CHECK_TICKS = 2;
const filledBetterThanAsked = o => {
  if (!(o.filled > 0) || !(o.price > 0) || !Number.isFinite(o.spent)) return false;
  const actual = o.spent / o.filled;
  return side(o) === 'buy' ? actual < o.price : actual > o.price;
};
export const isMarginCheck = o => !!o && o.total === 1 && o.filled === 1 &&
  Number.isInteger(o.ticksToFill) && o.ticksToFill >= 0 && o.ticksToFill <= MARGIN_CHECK_TICKS &&
  filledBetterThanAsked(o);
export const side = o => ['BUYING','BOUGHT','CANCELLED_BUY'].includes(o.state) ? 'buy' : 'sell';

// Automatic FIFO matching so realized profit shows up without the manual "Review a completed
// flip" step: a sale that legitimately got split across several separate GE offers (cancel and
// reprice, or just re-listing the remainder) used to leave the buy permanently stuck in the
// review screen if the second sale didn't happen to appear in the matching dropdown, and the
// headline profit total never moved. This walks every finished, fully-observed offer in
// chronological order per account+item, treats buys as cost-basis lots and consumes them
// oldest-first as matching sells come in, and closes a lot out into an auto flip the moment its
// full quantity has been sold -- no user action required. Offers already used by a manual,
// non-reopened flip (see Store.state's `used` set) must be excluded by the caller first, so a
// trade is never counted twice.
//
// closed: Map of buy offerId -> {reason, at}, from Store.closePosition -- the player said the rest
// of that purchase is gone some way the GE journal can't see (used in-game, sold outside EVI's
// view). A closed lot stops consuming sales made after `at`, never becomes an open position (so the
// "you're still holding this" reminder stops nominating it), and whatever part of it WAS sold
// before closing still counts: that sold part becomes its own flip (partial:true), costed at the
// same per-unit price as every other FIFO match -- the unsold remainder is simply left out of profit.
// When an offer's goods or GP actually came into existence, for ordering the FIFO queue. A sale is
// realised when it completes. A purchase is different: in Old School the items from a partly-filled
// buy can be collected -- and sold -- while the offer is still open, so the offer's own completion
// time can come AFTER the sale of its items. Found on a real trade: an Eclipse Moon chestplate
// (broken) was bought 1 of 3, collected and sold at 12:56:04, and the rest of the buy cancelled at
// 12:56:29. Ordered by completion, the sale was processed before the purchase existed, so it matched
// nothing and the purchase became a phantom "still held" position -- EVI would then keep telling the
// player to sell an item they had already sold.
//
// So a purchase is ordered by its FIRST FILL, which the plugin records as ticksToFill after it was
// first seen (one game tick is 0.6s). An offer without that data -- everything journalled before it
// existed -- keeps exactly the ordering it always had, so no historical flip moves.
const GAME_TICK_MS = 600;
export function availableAt(o) {
  const completed = o.completedAt ?? o.firstSeen;
  if (side(o) === 'buy' && Number.isInteger(o.ticksToFill) && o.ticksToFill >= 0 && Number.isFinite(o.firstSeen))
    // Never later than completion: the first fill cannot come after the offer finished, and game
    // ticks run slower than 0.6s under server lag, so a tick-based estimate can overshoot. Clamping
    // means an imprecise tick count can only ever move a purchase earlier, towards the truth, and
    // never past the ordering it had before this existed.
    return Math.min(o.firstSeen + o.ticksToFill * GAME_TICK_MS, completed);
  return completed;
}

// Summarises what the automatic matching could not account for, in counts and GP, for display beside
// the profit total. Nothing here is estimated: unmatched proceeds are the gross GP the Grand Exchange
// reported for those sales, and open cost is each held lot's own recorded unit cost times what remains.
//
// Sales of stock the player marked as personal use are counted separately. Those buys are kept out of
// matching on purpose, so their sales were always "unmatched" -- and were reported as sales with no
// recorded purchase, which read as EVI having missed a trade. personalUseBuys: the flagged buy offers.
// Each unmatched sale's units are attributed, oldest sale first, to flagged buys of the same item on
// the same account that were placed before it, never more units than those buys bought; whatever is
// left over stays unmatched. A sale split between the two is counted once in each, with its GP split
// by units. Only the unmatched part of a partly matched sale counts, in units and GP -- an earlier
// version counted its whole proceeds.
export function dataHealthOf({openPositions = [], unmatchedSells = []} = {}, personalUseBuys = []) {
  const openCost = openPositions.reduce((s, p) => s + (p.unitCost > 0 && p.remaining > 0 ? p.unitCost * p.remaining : 0), 0);
  const pools = new Map();
  for (const b of personalUseBuys || []) {
    if (!b || !(b.filled > 0)) continue;
    const k = b.account + '|' + b.itemId;
    if (!pools.has(k)) pools.set(k, []);
    pools.get(k).push({at: b.firstSeen ?? 0, left: b.filled});
  }
  let unmatchedSales = 0, unmatchedGross = 0, personalUseSales = 0, personalUseGross = 0;
  const when = o => o.completedAt ?? o.updated ?? o.firstSeen ?? 0;
  for (const o of [...unmatchedSells].sort((a, b) => when(a) - when(b))) {
    const filled = o.filled > 0 ? o.filled : null;
    const qty = Number.isFinite(o.unmatchedQty) ? o.unmatchedQty : filled;
    const gpPerUnit = Number.isFinite(o.spent) && filled ? o.spent / filled : null;
    let covered = 0;
    for (const lot of pools.get(o.account + '|' + o.itemId) || []) {
      if (!(qty > covered)) break;
      if (lot.at > when(o) || lot.left <= 0) continue;
      const take = Math.min(lot.left, qty - covered);
      lot.left -= take; covered += take;
    }
    if (covered > 0) { personalUseSales++; if (gpPerUnit !== null) personalUseGross += gpPerUnit * covered; }
    const rest = qty === null ? null : qty - covered;
    if (rest === null) { unmatchedSales++; if (Number.isFinite(o.spent)) unmatchedGross += o.spent; }
    else if (rest > 0) { unmatchedSales++; if (gpPerUnit !== null) unmatchedGross += gpPerUnit * rest; }
  }
  return {
    openPositions: openPositions.length, openCost: Math.round(openCost),
    openItemIds: [...new Set(openPositions.map(p => p.itemId))],
    unmatchedSales, unmatchedGross: Math.round(unmatchedGross),
    personalUseSales, personalUseGross: Math.round(personalUseGross),
  };
}

export function computeAutoFlips(offers, closed = new Map()) {
  const groups = new Map();
  for (const o of offers) {
    // Margin checks are not trades and must not become flips or open positions (see isMarginCheck).
    if (!o || !o.knownStart || !finished(o) || !(o.filled > 0) || isMarginCheck(o)) continue;
    const key = o.account + ' ' + o.itemId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const flips = [], openPositions = [], unmatchedSells = [];
  for (const list of groups.values()) {
    const sorted = list.slice().sort((a, b) => availableAt(a) - availableAt(b));
    const lots = [];
    const soldPart = lot => {
      const qty = lot.totalQty - lot.remaining;
      if (qty > 0) flips.push({id: `auto:${lot.offerId}`, account: lot.account, itemId: lot.itemId, item: lot.item,
        quantity: qty, capital: Math.round(lot.capital), netProceeds: Math.round(lot.netProceeds),
        profit: Math.round(lot.netProceeds - lot.capital), firstBuy: lot.firstSeen, lastSell: lot.lastSell,
        hold: (lot.lastSell - lot.firstSeen) / 3600000, buyId: lot.offerId, sellIds: lot.sellIds,
        exact: lot.exact, source: 'auto-fifo', partial: true, closedReason: closed.get(lot.offerId).reason});
    };
    for (const o of sorted) {
      const at = availableAt(o);
      // Lots closed before this offer: settle their sold part and drop them from the queue.
      for (let i = lots.length - 1; i >= 0; i--) {
        const c = closed.get(lots[i].offerId);
        if (c && c.at <= at) { soldPart(lots[i]); lots.splice(i, 1); }
      }
      if (side(o) === 'buy') {
        lots.push({offerId: o.offerId, account: o.account, itemId: o.itemId, item: o.name,
          remaining: o.filled, totalQty: o.filled, unitCost: o.spent / o.filled, firstSeen: o.firstSeen,
          capital: 0, netProceeds: 0, sellIds: [], exact: true, lastSell: null});
        continue;
      }
      const proceeds = saleProceeds(o);
      if (!proceeds) { unmatchedSells.push({...o, reason: 'No usable tax calculation for this sale (pre-tax-era or invalid data)'}); continue; }
      let remainingSellQty = o.filled;
      const unitNet = proceeds.net / o.filled;
      while (remainingSellQty > 0 && lots.length && lots[0].remaining > 0) {
        const lot = lots[0];
        const take = Math.min(lot.remaining, remainingSellQty);
        lot.remaining -= take; remainingSellQty -= take;
        lot.capital += take * lot.unitCost; lot.netProceeds += take * unitNet;
        lot.sellIds.push(o.offerId); lot.exact = lot.exact && proceeds.exact;
        lot.lastSell = o.completedAt ?? o.firstSeen;
        if (lot.remaining === 0) {
          flips.push({id: `auto:${lot.offerId}`, account: lot.account, itemId: lot.itemId, item: lot.item,
            quantity: lot.totalQty, capital: Math.round(lot.capital), netProceeds: Math.round(lot.netProceeds),
            profit: Math.round(lot.netProceeds - lot.capital), firstBuy: lot.firstSeen, lastSell: lot.lastSell,
            hold: (lot.lastSell - lot.firstSeen) / 3600000, buyId: lot.offerId, sellIds: lot.sellIds,
            exact: lot.exact, source: 'auto-fifo'});
          lots.shift();
        }
      }
      if (remainingSellQty > 0) unmatchedSells.push({...o, unmatchedQty: remainingSellQty,
        reason: 'Sold quantity exceeds every known preceding buy for this account/item -- likely a buy observed only partway through, or stock held before this bridge started watching'});
    }
    // unitCost carries the real average price this lot was bought at (already computed above,
    // spent/filled -- the actual GE fill cost, never the offer's set/max price) through to
    // pickPersistentOpenPosition's caller, so a cross-restart "you're still holding this" reminder
    // can compare against what was actually paid instead of reading as a plain, neutral "sell near
    // X gp" regardless of whether that's a profit or a loss. See computeHoldingSuggestion's own doc
    // in suggestions.mjs for the failure this exists to fix.
    for (const lot of lots) if (closed.has(lot.offerId)) soldPart(lot); else if (lot.remaining > 0) openPositions.push({account: lot.account, itemId: lot.itemId,
      item: lot.item, buyId: lot.offerId, remaining: lot.remaining, totalQty: lot.totalQty, firstSeen: lot.firstSeen,
      unitCost: lot.unitCost, partiallySold: lot.remaining < lot.totalQty});
  }
  return {flips, openPositions, unmatchedSells};
}
export function validatePacket(p) {
  if (!p || p.version !== 1 || !id(p.session) || !id(p.account) || !integer(p.seq,1,Number.MAX_SAFE_INTEGER) ||
      !integer(p.ts,1,Number.MAX_SAFE_INTEGER) || typeof p.loggedIn !== 'boolean' || !Array.isArray(p.offers) || p.offers.length > 8) throw Error('Invalid packet');
  const slots = new Set();
  const offers = p.offers.map(o => {
    if (!o || !integer(o.slot,0,7) || slots.has(o.slot) || !states.has(o.state) || !id(o.offerId) ||
        !integer(o.itemId) || !integer(o.price) || !integer(o.total) || !integer(o.filled) || o.filled > o.total || !integer(o.spent) ||
        typeof o.knownStart !== 'boolean' || typeof o.name !== 'string' || o.name.length > 150) throw Error('Invalid offer');
    if (o.state !== 'EMPTY' && (!o.itemId || !o.total || !o.price)) throw Error('Invalid nonempty offer');
    // Optional, and older plugin builds simply don't send it: how many ticks passed before this
    // offer's first fill, or -1 for unknown. See isMarginCheck above for the only thing it is used for.
    if (o.ticksToFill !== undefined && !integer(o.ticksToFill, -1, 1000000)) throw Error('Invalid ticksToFill');
    slots.add(o.slot);
    const fields = ['slot','state','offerId','itemId','name','price','total','filled','spent','knownStart'];
    const out = Object.fromEntries(fields.map(k=>[k,o[k]]));
    out.ticksToFill = Number.isInteger(o.ticksToFill) ? o.ticksToFill : -1;
    return out;
  });
  if (p.loggedIn && offers.length !== 8) throw Error('Expected all eight slots');
  return {version:1,session:p.session,account:p.account,seq:p.seq,ts:p.ts,loggedIn:p.loggedIn,offers};
}

export class Store {
  constructor(dir) {
    fs.mkdirSync(dir,{recursive:true});
    this.file=path.join(dir,'events.jsonl'); this.offers=new Map(); this.sessions=new Map(); this.flips=[]; this.personalUse=new Set(); this.personalUseItems=new Set(); this.personalUseKept=new Map();
    // Login-time continuity (see continuation() below): alias maps a plugin offerId first seen at
    // login onto the earlier record of the same GE offer; lastSlots holds each session's slot
    // contents (resolved offerIds) from its most recent logged-in packet. Both are rebuilt purely by
    // replaying the journal, so nothing new is written to disk for them.
    this.alias=new Map(); this.lastSlots=new Map();
    this.closed=new Map(); // buy offerId -> {reason, at}; see closePosition
    // Completed flips imported from another tracker (see importFlips): real trades EVI never
    // witnessed, kept separate from `flips` so they can inform ranking without being counted as
    // profit EVI observed.
    // Two sets, because a fingerprint only catches a re-import through the SAME route. The private
    // tool writes "copilot|item|times|..." and the CSV import writes 'generic:["csv <file>",...]', so
    // the same trade arriving by the other door has a fingerprint that can never match and would be
    // accepted as new -- double-weighting that item in every ranking afterwards, with nothing said.
    // Found on 27 Sept while checking whether a real flips.csv overlapped an earlier import: it
    // did not (that one stops at 12 Sept and the file starts on the 18th), so the collision was luck
    // rather than design. The content key closes it: an item, an account, a quantity, a profit and both
    // timestamps. Two genuinely separate flips of one item cannot share a start AND an end time on one
    // account, so there is no realistic trade this wrongly refuses.
    this.importedFlips=[]; this.importedFingerprints=new Set(); this.importedContent=new Set();
    this.linkedCount=0;
    if (fs.existsSync(this.file)) {
      const bytes=fs.readFileSync(this.file);
      const end=bytes.lastIndexOf(10)+1;
      if(end<bytes.length) {
        fs.writeFileSync(path.join(dir,`interrupted-tail-${Date.now()}.txt`),bytes.subarray(end));
        fs.truncateSync(this.file,end);
      }
      for(const line of bytes.subarray(0,end).toString('utf8').split('\n').filter(Boolean)) this.apply(JSON.parse(line));
    }
    for(const s of this.sessions.values()) s.lastSeen=0;
  }
  append(record) {
    if(fs.existsSync(this.file) && fs.statSync(this.file).size > 100*1024*1024) throw Error('Journal reached 100 MB. Back up data and contact support before continuing.');
    const fd=fs.openSync(this.file,'a');
    try { fs.writeFileSync(fd,JSON.stringify(record)+'\n'); fs.fsyncSync(fd); } finally {fs.closeSync(fd);}
    this.apply(record);
  }
  apply(r) {
    if(r.type==='flip-reopened') {const f=this.flips.find(f=>f.id===r.id);if(f){f.removed=true;f.reopened=true;}return;}
    if(r.type==='flip-removed') {const f=this.flips.find(f=>f.id===r.id);if(f)f.removed=true;return;}
    if(r.type==='flip-restored') {const f=this.flips.find(f=>f.id===r.id);if(f)f.removed=false;return;}
    if(r.type==='flip') {this.flips.push(r.flip);return;}
    if(r.type==='personal-use') {this.personalUse.add(this.resolve(r.buyId));return;}
    if(r.type==='personal-use-undo') {this.personalUse.delete(this.resolve(r.buyId));return;}
    // `kept` is how many of this item the player holds FOR USE. Records written before 1 Oct 2026
    // have none, and those stay blanket exclusions on purpose: we cannot know how many they had
    // when they marked it, and guessing 1 would retroactively offer to sell a second one they had
    // deliberately protected. Re-marking an old item gives it a count.
    if(r.type==='personal-use-item') {
      this.personalUseItems.add(r.itemId);
      if(integer(r.kept,1)) this.personalUseKept.set(r.itemId,
        // Re-marking RAISES the count rather than replacing it: marking again while holding fewer
        // must not quietly shrink what is protected.
        Math.max(r.kept, this.personalUseKept.get(r.itemId) || 0));
      return;
    }
    if(r.type==='personal-use-item-undo') {this.personalUseItems.delete(r.itemId);this.personalUseKept.delete(r.itemId);return;}
    if(r.type==='flips-imported') {for(const f of r.flips)if(!this.importedFingerprints.has(f.fp)){this.importedFingerprints.add(f.fp);this.importedContent.add(importedContentKey(f));this.importedFlips.push(f);}return;}
    if(r.type==='flips-import-removed') {
      this.importedFlips=this.importedFlips.filter(f=>f.source!==r.source);
      this.importedFingerprints=new Set(this.importedFlips.map(f=>f.fp));
      this.importedContent=new Set(this.importedFlips.map(importedContentKey));
      return;
    }
    // A purchase the player made while EVI was not watching (see recordPurchase). It joins the
    // ordinary offer pool as a finished buy, so FIFO matching, open positions and the loss warning
    // on a later sale all work on it with no second code path -- but it keeps recorded:true, so it
    // is always possible to tell what EVI observed from what it was told.
    if(r.type==='purchase-recorded') {
      const o=r.purchase;
      this.offers.set(o.offerId,{slot:-1,state:'BOUGHT',offerId:o.offerId,itemId:o.itemId,name:o.name,
        price:o.unitPrice,total:o.quantity,filled:o.quantity,spent:o.unitPrice*o.quantity,knownStart:true,
        account:o.account,session:'recorded',firstSeen:o.at,updated:o.at,completedAt:o.at,recorded:true});
      return;
    }
    if(r.type==='purchase-record-removed') {this.offers.delete(r.offerId);return;}
    if(r.type==='position-closed') {this.closed.set(r.buyId,{reason:r.reason,at:r.at});return;}
    if(r.type==='position-reopened') {this.closed.delete(r.buyId);return;}
    const p=r.packet;
    const session={account:p.account,seq:p.seq,lastSeen:r.received,loggedIn:p.loggedIn,slots:p.offers.map(o=>o.offerId)};
    this.sessions.set(p.session,session);
    for(const o of p.offers) {
      if(o.state==='EMPTY')continue;
      if(!o.knownStart && !this.offers.has(o.offerId) && !this.alias.has(o.offerId)) {
        const original=this.continuation(p,o);
        if(original){this.alias.set(o.offerId,original.offerId);this.linkedCount++;}
      }
      const aliased=this.alias.has(o.offerId),key=this.resolve(o.offerId);
      const old=this.offers.get(key);
      this.offers.set(key,{...o,offerId:key,account:p.account,session:p.session,firstSeen:old?.firstSeen??p.ts,
        updated:p.ts,completedAt:old?.completedAt??(finished(o)?p.ts:null),
        // A linked continuation keeps the original record's coverage: the plugin can only ever say
        // "false" for an offer it first saw at login, even when EVI did watch it start earlier.
        knownStart:aliased?old.knownStart:(old?.knownStart??o.knownStart)&&o.knownStart,
        // When a buy first filled, kept the same way firstSeen and completedAt are kept above.
        // The plugin reports -1 when it has no reading, and the final CANCELLED_BUY packet always
        // does -- so taking the newest packet wholesale threw away a real count the moment an
        // offer was cancelled. availableAt then fell back to when the offer FINISHED, which for a
        // part-filled buy is after the player already sold what they bought, and the sale landed
        // as unmatched. Real case, 27 Sept 2026: eight Dragon med helms bought out of an offer
        // for 48, sold, and the rest cancelled 37 minutes later; see tests/partialBuyOrdering.
        ticksToFill:Number.isInteger(o.ticksToFill)&&o.ticksToFill>=0?o.ticksToFill:old?.ticksToFill});
    }
    if(p.loggedIn&&p.offers.length===8)
      this.lastSlots.set(p.session,Array.from({length:8},(_,i)=>{const o=p.offers.find(x=>x.slot===i);return o&&o.state!=='EMPTY'?this.resolve(o.offerId):null;}));
  }
  resolve(offerId){return this.alias.get(offerId)??offerId;}
  // The plugin gives every offer a brand-new offerId (knownStart=false) whenever it first sees it
  // at login -- after every RuneLite restart, relog or world hop -- so one real GE offer used to
  // turn into several unrelated records: a sale EVI watched being placed, then completed while the
  // client was restarting, only ever showed up as a separate "baseline" sale that automatic matching
  // and manual review both refuse. Its buy then looked unsold forever (and got suggested for
  // selling again). This finds the earlier record of the same offer: same account, slot, item,
  // side, price and quantity, still sitting in that slot when its own session last reported (never
  // seen collected or replaced), with fill counters that haven't gone backwards, and -- if it was
  // already finished -- exactly unchanged. Only a single unambiguous candidate is linked; anything
  // else stays a separate baseline record exactly as before. Replaying the real journal this way
  // linked 302 of 337 login-time offers with zero ambiguous cases.
  continuation(p,o) {
    const candidates=[];
    for(const x of this.offers.values()) {
      if(x.account!==p.account||x.session===p.session||x.slot!==o.slot||x.itemId!==o.itemId||side(x)!==side(o)||
        x.price!==o.price||x.total!==o.total||x.filled>o.filled||x.spent>o.spent)continue;
      if(this.lastSlots.get(x.session)?.[o.slot]!==x.offerId)continue;
      if(finished(x)&&(x.state!==o.state||x.filled!==o.filled||x.spent!==o.spent))continue;
      candidates.push(x);
    }
    return candidates.length===1?candidates[0]:null;
  }
  ingest(input, now=Date.now()) {
    const p=validatePacket(input), oldSession=this.sessions.get(p.session);
    if(p.ts > now+60000) throw Error('Plugin clock is ahead of bridge');
    if(oldSession && oldSession.account!==p.account)throw Error('Session account changed');
    if(oldSession && p.seq<=oldSession.seq)return {duplicate:true};
    for(const o of p.offers) {
      const old=this.offers.get(this.resolve(o.offerId));
      if(old && (old.session!==p.session || old.account!==p.account || old.itemId!==o.itemId || old.price!==o.price || old.total!==o.total ||
        old.slot!==o.slot || old.filled>o.filled || old.spent>o.spent || side(old)!==side(o) || (finished(old)&&!finished(o)))) throw Error('Offer identity or counters changed');
    }
    // Persist only changed snapshots; repeated heartbeats update freshness in memory.
    const changed=!oldSession || oldSession.loggedIn!==p.loggedIn || JSON.stringify(oldSession.slots)!==JSON.stringify(p.offers.map(o=>o.offerId)) ||
      p.offers.some(o=>{
        if(o.state==='EMPTY')return false;
        const rec=this.offers.get(this.resolve(o.offerId));
        // A linked continuation is stored under its original offerId/coverage, so those two fields
        // legitimately differ from the packet; comparing them would journal every heartbeat.
        const ignore=this.alias.has(o.offerId)?['offerId','knownStart']:[];
        return !rec||Object.keys(o).some(k=>{
          if(ignore.includes(k))return false;
          // A packet that reports no fill time (-1, which every cancel does) is not disagreeing
          // with the better value we kept from when the offer actually filled -- it simply has
          // nothing to say. Treating that as a change would journal every heartbeat after a
          // cancel, forever, on a two-second poll. A packet carrying a real reading still counts.
          if(k==='ticksToFill'&&!(Number.isInteger(o[k])&&o[k]>=0))return false;
          return o[k]!==rec[k];
        });
      });
    if(changed)this.append({type:'packet',received:now,packet:p});
    const session=this.sessions.get(p.session); session.lastSeen=now;session.seq=p.seq;
    // queued packets are historical, not proof of a currently live game connection
    session.capturedAt=p.ts;
    return {duplicate:false};
  }
  confirm({buyId,sellId,sellIds,netProceeds}, now=Date.now()) {
    const ids=sellIds??[sellId];
    if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(x=>!id(x))||new Set(ids).size!==ids.length)throw Error('Choose distinct completed sales');
    buyId=this.resolve(buyId);
    // A purchase marked as personal use is, by the player's own word, not a flip. The automatic
    // matcher already leaves it out; this closes the manual path, which did not check -- an Oathplate
    // armour set bought to wear, disliked and resold at a loss was saved here as a reviewed flip and
    // put -2.9m into a profit total that was otherwise +2.0m. Unmarking it first remains possible,
    // for the case where it really was a flip after all.
    if(this.personalUse.has(buyId))throw Error('That purchase is marked as personal use, so it is not a flip. Unmark it first if it really was one.');
    const sorted=ids.map(x=>this.resolve(x)).sort();
    if(new Set(sorted).size!==sorted.length)throw Error('Choose distinct completed sales');
    const existing=this.flips.find(f=>!f.reopened&&f.buyId===buyId&&JSON.stringify([...(f.sellIds??[f.sellId])].sort())===JSON.stringify(sorted));
    if(existing){if(existing.removed)throw Error('This flip was removed. Restore it before reusing this match.');return existing;}
    const b=this.offers.get(buyId),sales=sorted.map(x=>this.offers.get(x));
    // Manual review accepts offers first seen at login too (knownStart=false) that couldn't be linked
    // to an earlier record -- i.e. placed while EVI wasn't watching at all. The GE's own filled/spent
    // counters are totals for the whole offer however late EVI first saw it, so the numbers are
    // still real; what's unknown is only when it started, which is why automatic matching keeps
    // excluding them and this path requires the player to pick the match themselves.
    if(sales.some(s=>!s||side(s)!=='sell'||!finished(s)||s.filled<1||s.account!==b?.account||s.itemId!==b?.itemId||s.firstSeen<b?.completedAt))throw Error('Choose later completed sales for the same account/item');
    const s={...sales[0],filled:sales.reduce((n,o)=>n+o.filled,0),firstSeen:Math.min(...sales.map(o=>o.firstSeen)),completedAt:Math.max(...sales.map(o=>o.completedAt))};
    if(!b||!s||side(b)!=='buy'||side(s)!=='sell'||!finished(b)||!finished(s)||
      b.account!==s.account||b.itemId!==s.itemId||b.filled<1||b.filled!==s.filled||s.firstSeen<b.completedAt||b.spent<1)throw Error(b&&s&&b.filled!==s.filled?`The selected sales total ${s.filled.toLocaleString('en-US')} items but the purchase was ${b.filled.toLocaleString('en-US')}. Select every sale of this purchase, or, if the rest was used or sold outside EVI, close it under "Still held" instead -- the part you sold still counts.`:'Select a completed buy and later completed sales of the same item on the same account');
    if(this.flips.some(f=>!f.reopened&&(f.buyId===buyId||(f.sellIds??[f.sellId]).some(x=>sorted.includes(x)))))throw Error('An offer is already matched');
    const calculated=sales.map(saleProceeds);
    const automatic=netProceeds===undefined;
    if(automatic){
      if(calculated.some(x=>!x?.exact))throw Error('Execution prices are mixed or historical; review actual net proceeds');
      netProceeds=calculated.reduce((n,x)=>n+x.net,0);
    }
    const maximum=sales.reduce((n,o)=>n+o.spent,0);
    // Two separate messages: this used to say "must be greater than zero" for BOTH a non-positive
    // amount and an amount larger than the sales could have paid -- so a real, non-zero amount that
    // was simply too high was reported as if it were zero.
    if(!Number.isSafeInteger(maximum))throw Error('The selected sales have invalid GP counters.');
    if(!integer(netProceeds,1,Number.MAX_SAFE_INTEGER))throw Error('Net proceeds must be a whole GP amount greater than zero. Leave it blank for automatic tax calculation.');
    if(netProceeds>maximum)throw Error(`Net proceeds of ${netProceeds.toLocaleString('en-US')} GP is more than the GE reported for the selected sale(s): ${maximum.toLocaleString('en-US')} GP before tax. Enter what you received after tax for exactly these sales (not the profit, and not including other sales).`);
    const flip={id:randomUUID(),buyId,sellId:sorted.length===1?sorted[0]:null,sellIds:sorted,account:b.account,itemId:b.itemId,item:b.name,quantity:b.filled,
      capital:b.spent,netProceeds,profit:netProceeds-b.spent,firstBuy:b.firstSeen,lastSell:s.completedAt,
      hold:(s.completedAt-b.firstSeen)/3600000,confirmedAt:now,source:'runelite-reviewed',proceedsMethod:automatic?'calculated-tax':'user-reviewed'};
    this.append({type:'flip',flip});return flip;
  }
  state(now=Date.now()) {
    const sessions=[...this.sessions.entries()].map(([id,s])=>({id,...s,live:s.lastSeen>now-30000&&s.capturedAt>now-30000}));
    const slots=sessions.filter(s=>s.live&&s.loggedIn).flatMap(s=>s.slots.map(id=>this.offers.get(this.resolve(id))).filter(Boolean));
    // Cancellations with nothing filled carry no economic information (no items or GP moved) and
    // cannot ever be matched to a flip; showing them as "completed" trades is confusing clutter,
    // not data loss — they stay in the append-only journal either way.
    const emptyCancel=o=>o.state.startsWith('CANCELLED')&&o.filled===0;
    const completedOffers=[...this.offers.values()].filter(finished).filter(o=>!emptyCancel(o));
    // Anything already claimed by a manual, non-reopened review (matched or later removed) is
    // left alone here so a trade is never counted in both the manual total and the automatic one;
    // a reopened flip's offers fall back into the automatic pool until reviewed again.
    const used=new Set(this.flips.filter(f=>!f.reopened).flatMap(f=>[f.buyId,...(f.sellIds??[f.sellId])]));
    // A buy the player flagged as personal use (see markPersonalUse below) is left out of the
    // automatic-matching pool entirely, the same way a manually reviewed offer already is -- it
    // never becomes an open position (so the restart-safe "you're still holding this" fallback
    // stops nominating it) and, if it's later sold anyway, that sale can't be swept into a flip
    // and inflate/deflate the profit total for something that was never a real flip to begin with.
    // A sale of a personal-use buy simply falls out as an ordinary unmatched sell instead.
    const auto=computeAutoFlips(completedOffers.filter(o=>!used.has(o.offerId) && !this.personalUse.has(o.offerId)),this.closed);
    const manualFlips=this.flips.filter(f=>!f.removed);
    const netProfit=manualFlips.reduce((n,f)=>n+f.profit,0)+auto.flips.reduce((n,f)=>n+f.profit,0);
    // Item IDs behind any personal-use-flagged buy, derived (not stored directly) by
    // cross-referencing this.personalUse's offerIds against this.offers for their itemId. Used
    // only by the caller's inventory-scan blocklist (see computeInventorySuggestion in
    // suggestions.mjs) so an item whose only held stock came from an already-flagged buy doesn't
    // immediately resurface through that fallback and defeat the point of flagging it -- never
    // merged into the general blocklist used by computeSuggestion/computeMarketSuggestion, since
    // personal-use on one past purchase must never block a genuinely new flip of the same item.
    // Items excluded WHOLESALE from the idle-inventory tier: every buy-derived mark, plus the
    // item-level marks that carry no kept count (pre-1 Oct 2026 records). An item-level mark WITH a
    // count is not here -- it is in personalUseKept, where only the surplus above the kept quantity
    // is offered. "I own one of these for use" and "I never sell this item" are different statements
    // and used to be the same one, so a whip drop carried beside a whip already marked was invisible.
    const personalUseItemIds=[...new Set([...[...this.personalUse].map(buyId=>this.offers.get(buyId)?.itemId).filter(Number.isFinite),
      ...[...this.personalUseItems].filter(id=>!this.personalUseKept.has(id))])];
    const personalUseKept=Object.fromEntries(this.personalUseKept);
    // occupied: every offer sitting in one of the eight slots right now, INCLUDING finished ones
    // that have not been collected -- unlike `active`, which drops them. A bought-but-uncollected
    // offer still holds its slot, and that slot is exactly where its sell will go once collected, so
    // anything reasoning about slot capacity needs this rather than `active`.
    return {version:1,serverTime:now,sessions,active:slots.filter(o=>!finished(o)),
      occupied:slots.filter(o=>o.state!=='EMPTY'),
      completed:completedOffers.sort((a,b)=>b.updated-a.updated).map(o=>({...o,proceeds:side(o)==='sell'?saleProceeds(o):null,marginCheck:isMarginCheck(o)})),
      flips:manualFlips,removedFlips:this.flips.filter(f=>f.removed),
      autoFlips:auto.flips,autoOpenPositions:auto.openPositions,autoUnmatchedSells:auto.unmatchedSells,
      // What the headline profit total does NOT include, so it can be shown right beside it. The total
      // reads -1.2m on this account while leaving out 15 sales with no recorded purchase and holding
      // 9 purchases at cost; without saying so, a player cannot tell a real loss from a gap in the
      // records, and would reasonably conclude EVI loses GP. See dataHealth in the scanner.
      dataHealth:dataHealthOf(auto,[...this.personalUse].map(id=>this.offers.get(id)).filter(Boolean)),
      personalUseBuyIds:[...this.personalUse],personalUseItemIds,personalUseItems:[...this.personalUseItems],personalUseKept,
      // Ranking history only -- see importFlips. Never folded into netProfit/tradeCount below.
      importedFlips:this.importedFlips,
      importedSummary:this.importedFlips.length?{count:this.importedFlips.length,
        items:new Set(this.importedFlips.map(f=>f.itemId)).size,
        profit:this.importedFlips.reduce((n,f)=>n+f.profit,0),
        from:Math.min(...this.importedFlips.map(f=>f.firstBuy)),to:Math.max(...this.importedFlips.map(f=>f.lastSell)),
        sources:[...new Set(this.importedFlips.map(f=>f.source))]}:null,
      closedPositions:[...this.closed].map(([buyId,c])=>{const o=this.offers.get(buyId);return {buyId,reason:c.reason,at:c.at,item:o?.name,itemId:o?.itemId,account:o?.account};}),
      linkedLoginOffers:this.linkedCount,
      netProfit,tradeCount:manualFlips.length+auto.flips.length};
  }
  // "I don't have the rest of this purchase any more" -- used in-game, or sold/traded some way EVI
  // never observed (e.g. while the plugin wasn't running). Keyed by the exact buy offerId, like
  // markPersonalUse, and only for a buy that is currently an open position. See computeAutoFlips'
  // `closed` parameter for how the part that WAS sold still counts. Reversible (closed:false).
  closePosition({buyId,reason,closed=true},now=Date.now()) {
    if(!id(buyId))throw Error('Invalid buyId');
    buyId=this.resolve(buyId);
    if(typeof closed!=='boolean')throw Error('Missing closed flag');
    if(!closed){if(this.closed.has(buyId))this.append({type:'position-reopened',buyId});return {ok:true};}
    if(!['used','sold-untracked'].includes(reason))throw Error('Choose why this position is gone');
    if(this.closed.has(buyId))return {ok:true};
    if(!this.state(now).autoOpenPositions.some(p=>p.buyId===buyId))throw Error('That purchase is not an open position.');
    this.append({type:'position-closed',buyId,reason,at:now});
    return {ok:true};
  }
  // Completed flips from a tracker that was running before (or alongside) EVI -- e.g. a Flipping
  // Copilot CSV export, imported via tools/import-copilot.mjs. These are real trades with real
  // realised profit, but EVI never saw the offers behind them, so they are deliberately kept apart
  // from `flips`:
  //   * They DO feed suggestion ranking (personalHistory in suggestions.mjs), which is the point --
  //     ranking from years of a player's own outcomes instead of the few days EVI has watched.
  //   * They do NOT count toward netProfit/tradeCount, so the headline total keeps its exact
  //     meaning: profit from trades EVI itself observed and matched. Mixing the two would silently
  //     restate a figure the player has been watching.
  // Each row needs an itemId (resolved from the item name by the caller, against the Wiki mapping)
  // because ranking looks prices up by ID; rows the caller could not resolve must be reported to the
  // player, never quietly dropped. fp is a stable fingerprint from the source export so importing
  // the same file twice is a no-op.
  /**
   * A purchase EVI did not see, told to it afterwards.
   *
   * The bridge only knows what the plugin watched happen. A buy that filled while the bridge was
   * stopped -- the machine off, RuneLite running without it -- leaves EVI holding stock it has no
   * cost for: it cannot warn that a later sale loses GP, and when that sale does arrive it counts as
   * an unmatched sale rather than a completed trade. This is the way to tell it, and it is recorded
   * as exactly that: a stated purchase, marked `recorded`, never disguised as an observation.
   *
   * Nothing here is estimated. The caller supplies the price actually paid; EVI adds no guess of its
   * own, and the whole thing is undone with remove and its offerId, since the journal is append-only.
   */
  recordPurchase({itemId,name,quantity,unitPrice,at,account,offerId,remove}, now=Date.now()) {
    if(remove===true) {
      if(typeof offerId!=='string'||!offerId.startsWith('recorded:'))throw Error('Name the recorded purchase to remove');
      if(!this.offers.has(offerId))return {removed:0};
      this.append({type:'purchase-record-removed',offerId});
      return {removed:1};
    }
    if(!integer(itemId,1))throw Error('A recorded purchase needs an item id');
    if(typeof name!=='string'||!name||name.length>150)throw Error('A recorded purchase needs the item name');
    if(!integer(quantity,1,2147483647))throw Error('Quantity must be a whole number of at least one');
    if(!integer(unitPrice,1,2147483647))throw Error('Price each must be a whole number of at least one gp');
    // A purchase in the future, or before the Grand Exchange tax regime this store can reason about,
    // is refused rather than stored with a timestamp nothing else can interpret.
    if(!integer(at,Date.UTC(2025,4,30),now))throw Error('The purchase time must be in the past, and after 30 May 2025');
    const id=offerId&&typeof offerId==='string'&&offerId.startsWith('recorded:')?offerId
      :`recorded:${itemId}:${at}:${unitPrice}:${quantity}`;
    if(this.offers.has(id))return {recorded:0, offerId:id, duplicate:true};
    const purchase={offerId:id,itemId,name:name.slice(0,150),quantity,unitPrice,at,
      account:typeof account==='string'&&account?account.slice(0,80):'recorded'};
    this.append({type:'purchase-recorded',purchase});
    return {recorded:1, offerId:id, cost:unitPrice*quantity};
  }
  importFlips({source,flips,remove}) {
    if(typeof source!=='string'||!source||source.length>40)throw Error('Name the import source');
    // Undo: drops every flip imported under this source name, so an import the player regrets isn't
    // permanent. The journal stays append-only -- the removal is itself a record.
    if(remove===true) {
      const removed=this.importedFlips.filter(f=>f.source===source).length;
      if(removed)this.append({type:'flips-import-removed',source});
      return {removed,total:this.importedFlips.length};
    }
    if(!Array.isArray(flips)||!flips.length||flips.length>500)throw Error('Import between 1 and 500 flips per request');
    const clean=[],batchContent=new Set();
    for(const f of flips) {
      if(!f||typeof f.fp!=='string'||!f.fp||f.fp.length>300)throw Error('Every imported flip needs a fingerprint');
      if(!integer(f.itemId,1)||typeof f.item!=='string'||!f.item||f.item.length>150)throw Error('Every imported flip needs a resolved itemId and name');
      if(!integer(f.quantity,1)||!Number.isSafeInteger(f.profit)||!integer(f.capital,0))throw Error('Invalid quantity, capital or profit');
      if(!integer(f.firstBuy,1,Number.MAX_SAFE_INTEGER)||!integer(f.lastSell,1,Number.MAX_SAFE_INTEGER))throw Error('Invalid trade timestamps');
      if(this.importedFingerprints.has(f.fp))continue; // already imported through this same route
      const row={fp:f.fp,source,itemId:f.itemId,item:f.item,quantity:f.quantity,capital:f.capital,
        netProceeds:f.capital+f.profit,profit:f.profit,firstBuy:f.firstBuy,lastSell:f.lastSell,
        hold:(f.lastSell-f.firstBuy)/3600000,account:typeof f.account==='string'?f.account.slice(0,80):null,imported:true};
      // The same trade re-imported by a different route, whose fingerprint could never match (see the
      // comment on importedContent). batchContent covers a file that simply lists a trade twice: the
      // sets above are only updated when the record is appended, so without it both copies pass.
      const content=importedContentKey(row);
      if(this.importedContent.has(content)||batchContent.has(content))continue;
      batchContent.add(content);
      clean.push(row);
    }
    if(clean.length)this.append({type:'flips-imported',flips:clean});
    return {accepted:clean.length,duplicates:flips.length-clean.length,total:this.importedFlips.length};
  }
  // How much of an item this account has bought through the GE in the last four hours, from EVI's
  // own journal -- the input for not suggesting a quantity the GE will refuse. OSRS enforces a
  // per-item limit over a rolling 4-hour window that starts at the first purchase of that item.
  //
  // Deliberately an UNDER-estimate, never a guess upwards: EVI only counts buys it actually
  // observed, so a purchase made while the plugin wasn't running is invisible and the real
  // remaining allowance can be smaller than this says. Callers must therefore only ever use it to
  // reduce a suggested quantity (see limitFor in GET /api/suggestion), never to justify a larger
  // one, and must say the figure is EVI's own observation rather than the GE's true counter. Fill
  // times within an offer aren't known individually, so each observed buy is attributed to when it
  // completed (or was last seen changing), which is the closest timestamp the journal has.
  buyLimitUsage(account, itemId, now = Date.now()) {
    const windowStart = now - 4 * 3600 * 1000;
    let used = 0, oldest = null;
    for (const o of this.offers.values()) {
      if (o.account !== account || o.itemId !== itemId || side(o) !== 'buy' || !(o.filled > 0)) continue;
      const at = o.completedAt ?? o.updated ?? o.firstSeen;
      if (!Number.isFinite(at) || at < windowStart) continue;
      used += o.filled;
      if (oldest === null || at < oldest) oldest = at;
    }
    return {used, windowEndsAt: oldest === null ? null : oldest + 4 * 3600 * 1000};
  }
  // Flags (or unflags) a specific, already-observed buy offer as personal use -- bought for the
  // player's own use via the GE, not as a flip to resell -- so it stops being surfaced as
  // something to sell and stops counting toward profit if it's later sold anyway. Keyed by the
  // exact buy offerId, never by item ID alone, so flagging one purchase never silently suppresses
  // or excludes a real, separate flip of the same item bought some other time. Durable across
  // restarts, same append-only journal pattern as every other flip-state change here. Only a real,
  // already-fully-observed buy offer can be marked (mirrors the validation confirm() already does
  // for buy/sell identity) -- an unknown, not-yet-finished, or sell-side offerId is rejected rather
  // than silently accepted, since a typo'd or stale ID here would otherwise fail invisibly.
  markPersonalUse({buyId,personal}) {
    if(!id(buyId))throw Error('Invalid buyId');
    if(typeof personal!=='boolean')throw Error('Missing personal flag');
    buyId=this.resolve(buyId);
    const o=this.offers.get(buyId);
    if(!o||side(o)!=='buy'||!finished(o)||!o.knownStart||!(o.filled>0))throw Error('Unknown or not-yet-observed buy');
    if(personal===this.personalUse.has(buyId))return {ok:true}; // already in the requested state; no-op, no journal noise
    this.append({type:personal?'personal-use':'personal-use-undo',buyId});
    return {ok:true};
  }
  // The same intent for an item EVI never saw bought: gear the player owns and uses, which only the
  // idle-inventory fallback (computeInventorySuggestion) ever suggests selling. markPersonalUse above
  // cannot cover it -- there is no buy offer to key it to -- so pressing "Personal use" on a Masori
  // body EVI only sees in the inventory did nothing at all, and the suggestion came straight back.
  //
  // Keyed by item rather than by purchase, because that is what the player means here: "this thing I
  // own is not stock". It only ever suppresses the idle-inventory tier (see personalUseItemIds in
  // state() and inventoryBlocklist in GET /api/suggestion), never the ranking tiers, so EVI will
  // still happily suggest BUYING that item to flip, and a purchase it does observe is matched and
  // counted exactly as before. Durable across restarts and reversible, like every other flip-state
  // change here.
  markPersonalUseItem({itemId,personal,kept}) {
    if(!integer(itemId,1))throw Error('Invalid itemId');
    if(typeof personal!=='boolean')throw Error('Missing personal flag');
    // How many are kept for use: the quantity held at the moment of marking, which for gear is
    // almost always 1. A FLOOR of 1 matters -- marking an item the player is not currently holding
    // would otherwise record 0 and switch the exclusion off entirely, the exact opposite of what
    // pressing the button means.
    // Accept 0 and THEN floor it. An earlier version guarded with integer(kept,1), which rejects 0
    // outright, so the floor below could never run and marking an item not currently held silently
    // fell back to a blanket exclusion -- the comment claimed a behaviour the code could not reach.
    const keep=Number.isInteger(kept)&&kept>=0?Math.max(1,kept):null;
    const already=this.personalUseItems.has(itemId);
    // Re-marking an already-marked item is not a no-op when it RAISES the kept count: a player who
    // marked one and now holds two and marks again means "both of these are mine".
    const raises=personal&&already&&keep!==null&&keep>(this.personalUseKept.get(itemId)||0);
    // `kept` appears in the reply only when there IS one, so the shape a caller saw before this
    // existed is byte-for-byte what it still sees. An existing test asserted that shape exactly and
    // was right to fail when a null crept in.
    const reply=()=>{const k=this.personalUseKept.get(itemId);
      return personal&&Number.isFinite(k)?{ok:true,itemId,personal,kept:k}:{ok:true,itemId,personal};};
    if(personal===already&&!raises)return reply();
    if(personal)this.append({type:'personal-use-item',itemId,...(keep===null?{}:{kept:keep})});
    else this.append({type:'personal-use-item-undo',itemId});
    return reply();
  }
  setRemoved({id,removed}) {
    if(typeof removed!=='boolean'||!this.flips.some(f=>f.id===id))throw Error('Unknown flip');
    if(this.flips.find(f=>f.id===id).reopened)throw Error('This version was reopened for correction. Save a new reviewed match instead.');
    this.append({type:removed?'flip-removed':'flip-restored',id});return {ok:true};
  }
  reopen({id}) {
    const f=this.flips.find(f=>f.id===id);
    if(!f)throw Error('Unknown flip');
    if(!f.reopened)this.append({type:'flip-reopened',id});
    return {ok:true};
  }
}
