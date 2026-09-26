import fs from 'node:fs';
import path from 'node:path';
import {estimateUnitTax} from './tax.mjs';

// "What is everything I own worth, and how has that changed?" -- the question every flipping tool
// answers about the market and almost none answers about the player. It reuses what EVI already has
// (the journal's own positions, the live prices it already fetches, and the coin count the plugin
// already reports) and adds no requests of its own.
//
// Four parts, each measured, never estimated:
//   * cash          -- the coin count the plugin last reported. Unknown until it has (just after
//                      login, or with the plugin not running), and then said to be unknown rather
//                      than treated as zero, which would read as "you lost your cash stack".
//   * inBuyOffers   -- coins the Grand Exchange is holding for buy offers still filling. The GE takes
//                      the coins when the offer is placed, so this is cash that has left the stack
//                      and is not yet stock: counted at the offer's own price, which is exactly what
//                      it took.
//   * inSellOffers  -- stock listed and not yet sold, at what buyers are paying now, after tax,
//                      because that is what it would realise today -- not at the asking price, which
//                      is a hope, and not at the price paid, which is history.
//   * held          -- stock the journal has not seen sold, the same way.
// Stock is valued after tax and cost is recorded beside it, so unrealised profit is the difference
// rather than a separate guess. An item with no current price is carried at what was paid for it and
// counted as unpriced, so a missing price can never look like a loss.
//
// Only the player's own data, only on this machine; the scanner reads it and nothing sends it anywhere.

export function wealthSnapshot({cash = null, buyOffers = [], sellOffers = [], positions = [], priceOf, now = Date.now()} = {}) {
  const value = (itemId, qty, paid) => {
    const p = priceOf ? priceOf(itemId) : null;
    const sell = p && p.sellPrice > 0 ? p.sellPrice : null;
    if (sell === null) return {gp: Number.isFinite(paid) && paid > 0 ? paid * qty : 0, priced: false};
    return {gp: (sell - estimateUnitTax(itemId, sell)) * qty, priced: true};
  };
  // costedValue tracks only the stock whose cost EVI actually knows, so unrealised profit compares
  // like with like. Without that split, a 246m item listed with no recorded purchase (sold from the
  // bank, or bought before EVI watched) counted its whole value as profit.
  let inBuyOffers = 0, inSellOffers = 0, held = 0, cost = 0, costedValue = 0, unpriced = 0, uncosted = 0;
  for (const o of buyOffers || []) {
    const remaining = Math.max(0, (o.total || 0) - (o.filled || 0));
    if (remaining > 0 && o.price > 0) inBuyOffers += remaining * o.price;
  }
  for (const o of sellOffers || []) {
    const remaining = Math.max(0, (o.total || 0) - (o.filled || 0));
    if (remaining <= 0) continue;
    const v = value(o.itemId, remaining, o.unitCost);
    inSellOffers += v.gp;
    if (!v.priced) unpriced += remaining;
    if (Number.isFinite(o.unitCost) && o.unitCost > 0) { cost += remaining * o.unitCost; costedValue += v.gp; }
    else uncosted += remaining;
  }
  // Stock sitting in a sell offer is ALSO an open position in the journal -- the position only closes
  // when the sale completes -- so counting both would count the same items twice. Found by checking the
  // real journal: three of four open positions (4,069 Diamond dragon bolts, 15 Eclipse Moon helm, 2 of
  // 3 Mage's book) were listed at that moment, and their value was being added on both sides. The
  // listed units are counted under inSellOffers, and each position is reduced by what is listed.
  const listedLeft = new Map();
  for (const o of sellOffers || []) {
    const remaining = Math.max(0, (o.total || 0) - (o.filled || 0));
    if (remaining > 0) listedLeft.set(o.itemId, (listedLeft.get(o.itemId) || 0) + remaining);
  }
  for (const p of positions || []) {
    const listed = listedLeft.get(p.itemId) || 0;
    const alreadyCounted = Math.min(Math.max(0, p.remaining || 0), listed);
    if (alreadyCounted > 0) listedLeft.set(p.itemId, listed - alreadyCounted);
    const remaining = Math.max(0, (p.remaining || 0) - alreadyCounted);
    if (remaining <= 0) continue;
    const v = value(p.itemId, remaining, p.unitCost);
    held += v.gp;
    if (!v.priced) unpriced += remaining;
    if (Number.isFinite(p.unitCost) && p.unitCost > 0) { cost += remaining * p.unitCost; costedValue += v.gp; }
    else uncosted += remaining;
  }
  const stock = inSellOffers + held;
  const round = n => Math.round(n);
  return {
    at: now,
    cash: Number.isFinite(cash) && cash >= 0 ? round(cash) : null,
    inBuyOffers: round(inBuyOffers), inSellOffers: round(inSellOffers), held: round(held),
    stockCost: round(cost),
    // Unrealised is over the stock whose cost is known and whose price could be read -- nothing else.
    // unpricedUnits and uncostedUnits say what was left out, so a partial figure is never read as whole.
    unrealised: cost > 0 ? round(costedValue - cost) : null,
    costedStock: round(costedValue),
    unpricedUnits: unpriced, uncostedUnits: uncosted,
    // Null cash makes the total unknowable; the parts EVI can see are still reported separately, and
    // the scanner says "at least" rather than printing a number that quietly leaves the stack out.
    total: Number.isFinite(cash) && cash >= 0 ? round(cash + inBuyOffers + stock) : null,
    outsideCash: round(inBuyOffers + stock),
  };
}

// The same snapshot over time, one line per record. Throttled per account (the plugin polls every two
// seconds; nobody needs that), rotated past MAX_BYTES, and never fatal: a write failure is dropped.
const EVERY_MS = 15 * 60 * 1000;
const MAX_BYTES = 20 * 1024 * 1024;

export function createWealthLog(dir, {everyMs = EVERY_MS} = {}) {
  const file = path.join(dir, 'wealth-log.jsonl');
  const last = new Map();
  function record({account, snapshot, now = Date.now()}) {
    if (!snapshot || snapshot.total === null) return false; // nothing worth charting without the stack
    const who = account || '';
    if (now - (last.get(who) || 0) < everyMs) return false;
    last.set(who, now);
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify({...snapshot, at: now, account: account || null}) + '\n');
    } catch { return false; }
    return true;
  }
  function recent(limit = 2000) {
    try {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }
  // Change over a window, from the oldest record inside it: the plain difference, with nothing
  // annualised or extrapolated. Null when there is no record old enough to compare against.
  function changeOver(hours, {now = Date.now(), account} = {}) {
    const rows = recent().filter(r => (!account || r.account === account) && Number.isFinite(r.total));
    if (!rows.length) return null;
    const cutoff = now - hours * 3600000;
    const earlier = rows.filter(r => r.at <= cutoff);
    if (!earlier.length) return null;
    const from = earlier[earlier.length - 1], to = rows[rows.length - 1];
    return {from: from.at, to: to.at, gp: to.total - from.total, fromTotal: from.total, toTotal: to.total};
  }
  return {record, recent, changeOver, file};
}
