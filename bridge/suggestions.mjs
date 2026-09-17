import {estimateUnitTax} from './tax.mjs';

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Aggregates the user's own reviewed flips, grouped by item. This is the whole point:
// every input here came from this account's own confirmed trades, never a shared pool,
// so there is no crowd of other users chasing the same suggestion at once.
export function personalHistory(flips) {
  const byItem = new Map();
  for (const f of flips || []) {
    if (!f || f.removed || !Number.isFinite(f.itemId) || !Number.isFinite(f.profit) || !Number.isFinite(f.quantity)) continue;
    let h = byItem.get(f.itemId);
    if (!h) {
      h = {itemId: f.itemId, name: f.item, trades: 0, wins: 0, totalProfit: 0, quantities: [], holds: [], lastTradeAt: 0};
      byItem.set(f.itemId, h);
    }
    h.trades++;
    if (f.profit > 0) h.wins++;
    h.totalProfit += f.profit;
    h.quantities.push(f.quantity);
    if (Number.isFinite(f.hold)) h.holds.push(f.hold);
    const at = f.lastSell ?? f.confirmedAt ?? 0;
    if (at > h.lastTradeAt) h.lastTradeAt = at;
    if (f.item) h.name = f.item; // most recent name wins (handles renamed/variant display)
  }
  return [...byItem.values()].map(h => ({
    itemId: h.itemId,
    name: h.name,
    trades: h.trades,
    winRate: h.wins / h.trades,
    avgProfit: h.totalProfit / h.trades,
    medianQty: median(h.quantities),
    medianHoldH: median(h.holds),
    lastTradeAt: h.lastTradeAt,
  }));
}

function recencyWeight(lastTradeAt, now) {
  const days = (now - lastTradeAt) / 86400000;
  if (days <= 1) return 1;
  if (days <= 7) return 0.85;
  if (days <= 30) return 0.6;
  return 0.35;
}

// Risk tiers approximate risk using the only signal this free/personal tier actually has --
// this account's own win rate and trade count -- not real price/profit variance, which would
// need a separate volatility feed this tier doesn't fetch. "Low" demands a longer, more
// consistent winning history and keeps winRate weighted twice in scoring (extra caution);
// "medium" is the original, unchanged balance (the default, so leaving risk unset changes
// nothing); "high" accepts a thinner/less certain track record and drops winRate from scoring
// entirely, so raw average profit drives ranking even for a less-proven item.
const RISK_TIERS = {
  low: {minTrades: 3, minWinRate: 0.75, score: (h, rw) => h.avgProfit * h.winRate * h.winRate * rw},
  medium: {minTrades: 1, minWinRate: 0.5, score: (h, rw) => h.avgProfit * h.winRate * rw},
  high: {minTrades: 1, minWinRate: 0.4, score: (h, rw) => h.avgProfit * rw},
};

// The Wiki /1h endpoint's own window length, in minutes -- the only per-item recent-volume signal
// this project fetches. Used to turn a raw hourly volume figure into an estimated trading *rate*
// (units per minute) for the trade-duration feasibility check below.
const VOLUME_WINDOW_MINUTES = 60;
// A deliberately coarse feasibility estimate, not a real order-book simulation: assumes the
// window's volume is spread evenly across it, so quantity / (volume / windowMinutes) approximates
// how many minutes it would take to trade that quantity at the current pace. Real fills can be far
// lumpier than "evenly spread" -- treat this as a rough sanity check ("is this even in the right
// ballpark for my time budget"), not a guarantee. Returns Infinity when there's no usable volume
// signal at all, so a candidate is never penalized for missing data, only for a bad estimate.
function estimatedFillMinutes(quantity, liquidity, windowMinutes) {
  if (!(liquidity > 0)) return Infinity;
  return quantity / (liquidity / windowMinutes);
}

// Applies the exact same coarse, volume-based feasibility estimate above -- not a new or different
// heuristic -- to an offer the player has ALREADY placed, rather than one being sized before it's
// placed (see computeSuggestion/computeMarketSuggestion's own use of estimatedFillMinutes). Purely
// so GET /api/suggestion can tell the plugin "this is running noticeably longer than your target
// duration, going by recent volume" -- never a fill guarantee, and the caller (EviLivePlugin's
// offerFillHint) must keep its own wording to that same honesty: a volume observation, not a
// prediction. liquidity uses the same conservative min(high,low) volume as every other duration
// check in this file, for the same reason (a round trip needs both a buy and a sell to clear).
// Returns null -- never a fabricated estimate -- when there's no volume entry for this item at all,
// or when there's no real remaining quantity or target duration to judge against; absence of data
// is never treated as evidence either way, same rule every other duration/volume check here follows.
export function estimateOfferFill(remainingQty, volumeEntry, targetDurationMinutes) {
  if (!(remainingQty > 0) || !Number.isFinite(targetDurationMinutes) || targetDurationMinutes <= 0) return null;
  if (!volumeEntry) return null;
  const liquidity = Math.min(volumeEntry.highPriceVolume || 0, volumeEntry.lowPriceVolume || 0);
  const minutes = estimatedFillMinutes(remainingQty, liquidity, VOLUME_WINDOW_MINUTES);
  return {
    // -1 is a deliberate sentinel for "no meaningful recent trading at all" (minutes === Infinity)
    // -- never JSON's null (which the plugin's Gson mapping would refuse for a primitive int field)
    // and never a fabricated large number standing in for "who knows".
    estimatedFillMinutes: Number.isFinite(minutes) ? Math.round(minutes) : -1,
    likelyToFillInTime: minutes <= targetDurationMinutes,
  };
}

// ---- Three gates every "buy" tier shares, all built by the caller (GET /api/suggestion) and all
// fail-open: an unknown answer never blocks a candidate, exactly like every other check here.
//
// 1. Stale prices. The Wiki's /latest high and low are LAST-TRADED prices with their own timestamps,
// not a live order book. On a thinly traded item the pair can be hours old and describe a spread
// nobody is actually offering -- the "buy at 6,400, sell at 30,000" shape that looks like free GP
// and is really just two unrelated old trades. That matters more now that a market-wide pick is
// sized to the item's whole buy limit rather than 100 units. Returns the age in minutes of the
// STALER of the two sides, or null when the response carries no usable timestamps (fail open).
export function priceAgeMinutes(p, now = Date.now()) {
  const times = [p?.highTime, p?.lowTime].filter(t => Number.isFinite(t) && t > 0);
  if (times.length < 2) return null;
  return (now / 1000 - Math.min(...times)) / 60;
}
// How stale is too stale for a market-wide pick -- an item nobody has traded on either side within
// this window has no trustworthy spread to rank on. Personal-history picks are never dropped for
// this (see computeSuggestion): there the player's own track record is the evidence, so it only adds
// a note.
export const MAX_PRICE_AGE_MINUTES = 60;

// 2. Members items on a free-to-play world, which simply cannot be traded there.
// 3. The GE's own 4-hour buy limit, via the caller's limitFor(itemId) -> {limit, remaining} | null.
// Both are passed in as options (membersBlocked / limitFor) rather than looked up here, since only
// the caller has the item mapping and the trade journal. See GET /api/suggestion in server.mjs.
function gateCandidate(itemId, quantity, options) {
  if (options.membersBlocked?.(itemId)) return null;
  const limit = options.limitFor?.(itemId);
  if (!limit || !Number.isFinite(limit.remaining)) return {quantity, limited: false};
  if (limit.remaining < 1) return null; // the 4-hour limit for this item is already used up
  return limit.remaining < quantity ? {quantity: limit.remaining, limited: true, limit} : {quantity, limited: false};
}

// latestPrices: {[itemId]: {high, low, ...}} in the shape of the Wiki /latest response's "data" object.
// options: {minProfit?: number, blocklist?: Set<number>, risk?: 'low'|'medium'|'high', maxSpend?:
// number, targetDurationMinutes?: number, volumes?: object}, all optional. maxSpend is the
// player's actual current cash stack (read from their inventory's coins) -- when set, a candidate
// whose buy price alone is more than that is dropped entirely (can't afford even one unit at the
// current cash stack), and the suggested quantity is otherwise capped so the total cost never
// exceeds it, however large the typical/historical quantity was. targetDurationMinutes is the
// player's own preferred trade length (e.g. "give me a ~10-minute flip"), paired with volumes (the
// Wiki /1h response's "data" object, keyed by item ID) as the only signal available to judge it by
// -- a candidate that couldn't realistically trade even one unit within that window (per
// estimatedFillMinutes above) is dropped, and one that could but only at a smaller quantity has it
// capped down, same treatment as maxSpend. Without volumes (or without a matching item in it),
// duration is simply not checked for that candidate -- never a reason to drop it for lack of data.
// Returns a single best suggestion (or null), ranked purely from this account's own reviewed-flip
// history. When this returns null, the caller (GET /api/suggestion) can optionally fall back to
// computeMarketSuggestion below, which is not gated on any personal history at all.
export function computeSuggestion(flips, latestPrices, now = Date.now(), options = {}) {
  const minProfit = Number.isFinite(options.minProfit) && options.minProfit > 0 ? options.minProfit : 0;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  const maxSpend = Number.isFinite(options.maxSpend) && options.maxSpend > 0 ? options.maxSpend : undefined;
  const targetDurationMinutes = Number.isFinite(options.targetDurationMinutes) && options.targetDurationMinutes > 0 ? options.targetDurationMinutes : undefined;
  const tier = RISK_TIERS[options.risk] || RISK_TIERS.medium;
  const history = personalHistory(flips).filter(h =>
    h.trades >= tier.minTrades && h.winRate >= tier.minWinRate && h.medianQty >= 1 && !blocklist.has(h.itemId));
  const candidates = [];
  for (const h of history) {
    const p = latestPrices?.[String(h.itemId)];
    if (!p || !(p.low > 0) || !(p.high > 0)) continue;
    const tax = estimateUnitTax(h.itemId, p.high);
    const net = p.high - p.low - tax;
    if (net <= 0) continue;
    let quantity = Math.max(1, Math.round(h.medianQty));
    let cashLimited = false;
    if (maxSpend !== undefined) {
      const affordable = Math.floor(maxSpend / p.low);
      if (affordable < 1) continue; // can't afford even one unit at the current cash stack
      if (affordable < quantity) { quantity = affordable; cashLimited = true; }
    }
    let durationLimited = false;
    if (targetDurationMinutes !== undefined) {
      const v = options.volumes?.[String(h.itemId)];
      const liquidity = v ? Math.min(v.highPriceVolume || 0, v.lowPriceVolume || 0) : 0;
      if (liquidity > 0) {
        if (estimatedFillMinutes(1, liquidity, VOLUME_WINDOW_MINUTES) > targetDurationMinutes) continue; // not realistic even at quantity 1 within the window
        const fillable = Math.max(1, Math.floor(liquidity / VOLUME_WINDOW_MINUTES * targetDurationMinutes));
        if (fillable < quantity) { quantity = fillable; durationLimited = true; }
      }
      // No volume data for this item at all: leave it unconstrained -- no signal to judge it by.
    }
    // Tradeable here, and within what's left of this item's 4-hour GE buy limit.
    const gated = gateCandidate(h.itemId, quantity, options);
    if (!gated) continue;
    let limitLimited = gated.limited;
    quantity = gated.quantity;
    const predictedProfit = net * quantity;
    if (predictedProfit < minProfit) continue;
    const score = tier.score(h, recencyWeight(h.lastTradeAt, now));
    if (score <= 0) continue;
    // Never dropped for staleness here, unlike a market-wide pick: this item has the player's own
    // track record behind it, so an old last-trade is context, not a reason to withhold it.
    const ageMinutes = priceAgeMinutes(p, now);
    candidates.push({h, p, net, score, quantity, predictedProfit, cashLimited, durationLimited, limitLimited, ageMinutes});
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const {h, p, quantity, predictedProfit, cashLimited, durationLimited, limitLimited, ageMinutes} = candidates[0];
  const notes = [];
  if (cashLimited) notes.push('reduced from your usual size to what your current cash stack can afford');
  if (durationLimited) notes.push(`reduced to fit an estimated ~${targetDurationMinutes}-minute trade`);
  if (limitLimited) notes.push('reduced to what EVI has seen left of this item\'s 4-hour GE buy limit');
  if (ageMinutes !== null && ageMinutes > MAX_PRICE_AGE_MINUTES)
    notes.push(`note that one side of this item's price is about ${Math.round(ageMinutes / 60)} hour(s) old, so the current spread may not be real`);
  return {
    itemId: h.itemId,
    name: h.name,
    action: 'buy', // the suggested next move if you don't already hold this item; both prices below are always populated regardless
    quantity,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'personal',
    reasoning: `You've flipped this ${h.trades} time${h.trades === 1 ? '' : 's'} with a ${Math.round(h.winRate * 100)}% win rate and ~${Math.round(h.avgProfit).toLocaleString('en-US')} GP average profit. Suggested quantity matches your typical size (${quantity})${notes.length ? ' -- ' + notes.join('; ') : ''}; buy near ${p.low.toLocaleString('en-US')} gp, aim to sell near ${p.high.toLocaleString('en-US')} gp for a predicted ~${Math.round(predictedProfit).toLocaleString('en-US')} gp.`,
  };
}

// Not a ranked pick at all -- a reminder that the player is already holding stock from an earlier
// buy that hasn't been resold yet. Primary source: the plugin tracks this itself, purely from GE
// offer transitions it observes THIS SESSION (see EviLivePlugin.updateHeldForResale()), and sends
// it as holdItemId/holdQty/holdName on every poll. That signal is necessarily empty right after a
// RuneLite/plugin restart, even though the position is still just as real -- it only gets
// refilled by observing a fresh buy-then-collect transition, never by re-noticing something
// collected in an earlier session. See pickPersistentOpenPosition below for the fallback source
// used when this is empty. When present and its current price is available, the caller (GET
// /api/suggestion) uses this instead of computeSuggestion/computeMarketSuggestion entirely --
// closing out a position you already opened takes priority over EVI pointing you at a brand-new
// one, which was the original complaint: buying an item from a suggestion, then having the
// sidebar move straight on to a completely different pick while that first item just sat in the
// inventory unsold. Returns null (never suppresses or affects the normal ranking) when nothing is
// being held, or its price isn't currently available -- the caller falls back to the normal
// ranking in that case.
// A plain live-market price for a single, arbitrary item ID -- no ranking, no flip-history gate,
// no volume/liquidity/affordability filtering, just "what is this item's current low/high right
// now" straight from the already-fetched Wiki /latest data. This is what lets the plugin's hint
// text and fill hotkey work for ANY item currently open in a GE offer (buy or sell), not only
// EVI's own top-ranked pick from computeSuggestion/computeMarketSuggestion/computeHoldingSuggestion
// above -- those answer "what should I trade next"; this answers "what's a fair price for the
// specific item I already have open right now," which is a different, additive question the
// player can ask about literally any item, reviewed or not. Returns null for an invalid item ID or
// when this item has no usable live price right now (same shape/reasoning as the other lookups
// above: never fabricates a number).
export function lookupItemPrice(latestPrices, itemId) {
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  const p = latestPrices?.[String(itemId)];
  if (!p || !(p.low > 0) || !(p.high > 0)) return null;
  return {itemId, buyPrice: p.low, sellPrice: p.high};
}

// Fallback source for the holding reminder above, used only when the plugin's own live
// holdItemId/holdQty is empty (most notably: right after a RuneLite/plugin restart, before any
// buy-collect has been observed fresh this session). Unlike the live signal, this survives
// restarts -- it comes from Store.state().autoOpenPositions, which computeAutoFlips (store.mjs)
// derives from the bridge's own on-disk journal, so it knows about a bought-but-unsold position
// from any earlier session, suggested by EVI or not, exactly as durably as the journal itself.
// account scopes the pick to the account currently asking (never mixes in stock held on a
// different account tracked by this same bridge, which that account couldn't sell anyway);
// blocklist is the same active-GE-slot/skip exclusion set the caller already builds for the
// normal ranking, reused here so an item you're already mid-sale on right now (which the journal
// may not have caught up to yet, since an in-progress sell isn't "finished") is never re-suggested
// as something to newly sell. Ties broken by earliest-bought-first, the same "don't forget the
// oldest thing you're sitting on" intent as the live path's lowest-item-id tiebreak. Returns null
// (never throws) when there's no account, no open positions, or nothing left after exclusions --
// the caller falls through to the normal ranking exactly as when the live signal is empty.
//
// This is a reconstruction from journaled GE offers, not a live read of the player's actual
// inventory -- it can go stale (a position that, in reality, was fully resold through some
// combination of separate sale offers the automatic FIFO matcher in store.mjs didn't perfectly
// reconcile) and, since this only ever nominates its single earliest-bought candidate per call,
// one stale entry can otherwise crowd out a real, currently-held item behind it forever. The
// caller (GET /api/suggestion in server.mjs) marks a suggestion built from this path with
// `persisted: true`; the plugin then verifies it against the player's actual current inventory
// before trusting it (see EviLivePlugin.verifyPersistedHolding), and -- if it isn't actually
// there -- excludes it via the same `exclude=`/blocklist mechanism used for a manual skip, which
// naturally makes the *next* call here advance to the next-earliest candidate instead of
// repeating the same stale one. See the 2026-09-16 "checks the actual inventory" README entry.
export function pickPersistentOpenPosition(openPositions, account, blocklist) {
  if (!Array.isArray(openPositions) || !account) return null;
  const exclude = blocklist instanceof Set ? blocklist : new Set();
  const mine = openPositions.filter(p => p && p.account === account && p.remaining > 0 && !exclude.has(p.itemId));
  if (!mine.length) return null;
  mine.sort((a, b) => a.firstSeen - b.firstSeen);
  return mine[0];
}

// holdBuyId: the specific GE buy offer this holding position came from, when known -- the live
// path (EviLivePlugin.heldForResale) sends the buy offer's own offerId as holdBuyId; the
// persisted-fallback path (pickPersistentOpenPosition below) already carries one on every open
// position it returns (computeAutoFlips's own lot.offerId). Passed straight through as `buyId` on
// the returned suggestion so the plugin can send it back unchanged via POST
// /api/suggestion/personal-use if the player flags this specific holding as personal use (bought
// for their own use, not to flip) -- see Store.markPersonalUse in store.mjs. Left null when not
// supplied (older/partial callers, or a holding signal with no identifiable single buy behind it)
// -- the "Personal use" button simply has nothing to mark in that case, same fail-safe shape as
// every other optional field here.
// holdBuyPrice: the actual average price per unit this holding was bought at, when known -- the
// live path sends it as Held.price (EviLivePlugin, computed from the real GE offer's
// spent/filled, not its set/offered price), and the persisted-fallback path sends it as
// openPosition.unitCost (computeAutoFlips in store.mjs, the exact same lot-cost figure the
// journal's own realized-profit numbers are built from). This exists specifically so a holding
// reminder never again reads as a plain, neutral "sell near X gp" regardless of whether X is
// above or below what was actually paid -- the real failure this was built to fix: EVI suggested
// a buy, the market (or the cached price data) moved against it before the position was even
// fully bought and collected, and the follow-up "you're holding this" reminder said nothing about
// it, reading exactly like a normal profitable flip. Left undefined when not supplied (an older
// caller, or a reconstructed position with no reliable cost basis) -- the reasoning simply falls
// back to its original, cost-agnostic wording, same fail-safe shape as every other optional field
// here; this must never THROW or drop the suggestion for missing cost data, only lose the extra
// context.
export function computeHoldingSuggestion(latestPrices, holdItemId, holdQty, holdName, holdBuyId, holdBuyPrice) {
  if (!Number.isFinite(holdItemId) || holdItemId <= 0 || !Number.isFinite(holdQty) || holdQty <= 0) return null;
  const p = latestPrices?.[String(holdItemId)];
  if (!p || !(p.low > 0) || !(p.high > 0)) return null;
  const name = holdName || `item ${holdItemId}`;
  let reasoning = `You're holding ${holdQty.toLocaleString('en-US')} ${name} from an earlier buy that hasn't been resold yet -- sell near ${p.high.toLocaleString('en-US')} gp before starting anything new.`;
  let breakEvenPrice = null, lossIfSoldNow = null;
  if (Number.isFinite(holdBuyPrice) && holdBuyPrice > 0) {
    const tax = estimateUnitTax(holdItemId, p.high);
    const netPerUnit = p.high - holdBuyPrice - tax;
    const totalNet = Math.round(netPerUnit * holdQty);
    breakEvenPrice = breakEvenSellPrice(holdItemId, holdBuyPrice);
    const breakEvenText = breakEvenPrice ? ` Break-even after tax: ${breakEvenPrice.toLocaleString('en-US')} gp.` : '';
    if (netPerUnit < 0) lossIfSoldNow = Math.abs(totalNet);
    reasoning = netPerUnit >= 0
      ? `You're holding ${holdQty.toLocaleString('en-US')} ${name} bought at ${holdBuyPrice.toLocaleString('en-US')} gp -- selling near ${p.high.toLocaleString('en-US')} gp now would net about +${totalNet.toLocaleString('en-US')} gp.${breakEvenText}`
      // Deliberately a warning, never a block, and not phrased as an instruction either way: the
      // player decides whether to cap the loss now or list at break-even and wait. Both numbers are
      // given so "cut the loss to a minimum" is an informed choice rather than a guess.
      : `WARNING: you're holding ${holdQty.toLocaleString('en-US')} ${name} bought at ${holdBuyPrice.toLocaleString('en-US')} gp -- selling near ${p.high.toLocaleString('en-US')} gp now would be a LOSS of about ${Math.abs(totalNet).toLocaleString('en-US')} gp.${breakEvenText} Not a recommendation either way: sell now to cap the loss at that amount, or list at or above break-even if you'd rather wait for the price to recover (it may not).`;
  }
  return {
    itemId: holdItemId,
    name,
    action: 'sell', // the suggested next move is closing this position out, not opening a new one
    quantity: holdQty,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'holding',
    reasoning,
    buyId: typeof holdBuyId === 'string' && holdBuyId ? holdBuyId : null,
    // null when the real cost basis isn't known -- never estimated.
    breakEvenPrice,
    lossIfSoldNow,
  };
}

// The lowest whole sell price per unit at which selling nets at least unitCost after GE tax --
// i.e. the price to list at to avoid a loss on stock bought at unitCost. Uses the same tax rules as
// every other calculation here (estimateUnitTax: 2% rounded down, capped at 5m per item, exempt
// items untaxed). Net proceeds (p - tax(p)) never decrease as p rises, so starting from the
// closed-form estimate and nudging a few gp either way is exact. Returns null for a missing or
// non-positive cost -- never a guessed cost basis.
export function breakEvenSellPrice(itemId, unitCost) {
  if (!Number.isFinite(unitCost) || unitCost <= 0) return null;
  const clears = p => p - estimateUnitTax(itemId, p) >= unitCost;
  let p = Math.ceil(unitCost);
  if (clears(p)) return p; // tax-exempt, or too cheap to be taxed
  p = Math.min(Math.ceil(unitCost * 50 / 49), Math.ceil(unitCost) + 5000000);
  for (let i = 0; i < 1000 && !clears(p); i++) p++;
  for (let i = 0; i < 1000 && p > 1 && clears(p - 1); i++) p--;
  return clears(p) ? p : null;
}

// The fallback of last resort, checked only when nothing else above has anything to suggest (no
// live hold, no persisted-fallback hold from the journal, no personal-history ranked pick). Every
// other holding-reminder path above only ever reconstructs from an *observed buy* -- live this
// session, or journaled from an earlier one -- so stock that arrived some other way (a quest/drop
// reward, a purchase made before this bridge ever started watching, or supplies bought for
// personal use and never logged through a "flip" at all) never surfaces as anything to sell, no
// matter how long it sits there. This is the gap that closes: it scans the player's own current
// inventory (sent by the plugin only when EviLiveConfig.suggestIdleInventory() is turned on --
// see EviLivePlugin.refreshInventoryItemIds/suggestionQuery) for anything with a meaningful GE
// sell value and no active offer, with no flip history or observed-buy requirement at all. Ranks
// purely by current total GE sell value (quantity * high price) since there's no track record to
// judge it by otherwise, and applies MIN_INVENTORY_VALUE as a floor so trivial junk never gets
// suggested.
// inventory: {[itemId]: quantity} -- the plugin's own current inventory snapshot, already summed
// across any unstacked duplicate slots. Coins (COINS_ITEM_ID) are always excluded -- gp itself is
// never "something to sell". mapping: the Wiki /mapping response body (array of {id, name, limit,
// members, ...}), used only to resolve a display name.
// options.blocklist: unlike computeSuggestion/computeMarketSuggestion's blocklist (session
// skip/active-GE-slot exclusions only), the caller (GET /api/suggestion) also merges in every
// item ID behind a personal-use-flagged buy here specifically -- see Store.state's
// personalUseItemIds -- never into the blocklist passed to the other ranking functions, since
// flagging one past purchase as personal use must never block a genuinely new, separate flip of
// the same item bought later. Returns a single best candidate (or null); source:'inventory',
// buyId:null since, by definition, there is no specific buy offer behind this pick to round-trip
// through the personal-use flow.
const COINS_ITEM_ID = 995;
const MIN_INVENTORY_VALUE = 100000;
export function computeInventorySuggestion(latestPrices, inventory, mapping, options = {}) {
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(mapping) || !latestPrices) return null;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  const names = new Map(mapping.filter(m => m && Number.isFinite(m.id)).map(m => [m.id, m.name]));
  const candidates = [];
  for (const [idStr, qty] of Object.entries(inventory)) {
    const itemId = parseInt(idStr, 10);
    // A members item can't be sold on a free-to-play world either, so the same gate applies here.
    if (!Number.isFinite(itemId) || itemId === COINS_ITEM_ID || !(qty > 0) || blocklist.has(itemId) || options.membersBlocked?.(itemId)) continue;
    const p = latestPrices[String(itemId)];
    if (!p || !(p.low > 0) || !(p.high > 0)) continue;
    const value = qty * p.high;
    if (value < MIN_INVENTORY_VALUE) continue;
    candidates.push({itemId, qty, p, value, name: names.get(itemId) || `item ${itemId}`});
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.value - a.value);
  const {itemId, qty, p, value, name} = candidates[0];
  return {
    itemId,
    name,
    action: 'sell',
    quantity: qty,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'inventory',
    buyId: null,
    reasoning: `You're holding ${qty.toLocaleString('en-US')} ${name} worth an estimated ${Math.round(value).toLocaleString('en-US')} gp at current prices, with no active offer and no buy EVI ever observed for it -- likely a drop, a quest reward, or stock from before this bridge started watching. Sell near ${p.high.toLocaleString('en-US')} gp if you don't need it.`,
  };
}

// An hourly-volume floor below which an item is excluded from market-wide candidates even at a
// great margin: the Wiki's high/low prices are last-traded prices, not a live orderbook, so a
// barely-traded item can show a wide, stale, unrealistic spread. Deliberately conservative --
// this free tier has no real depth-of-book signal, only this one coarse proxy.
const MIN_HOURLY_VOLUME = 5;
// Caps a market-wide pick's suggested quantity ONLY when the item's own GE buy limit is unknown --
// deliberately small, since this is an item with no track record and no known ceiling. When the
// limit IS known (the Wiki's /mapping gives one for most items), that limit is the size, because it
// is the real ceiling the GE itself enforces per 4 hours. This flat cap used to apply to every
// candidate regardless, which the surrounding doc already said it shouldn't: it silently held every
// market-wide pick to 100 units, so with a 500k minimum predicted profit only items with ~5,000 gp
// margin per unit could ever qualify, ruling out exactly the high-volume, thinner-margin flips that
// reach that profit through quantity. Changed on the user's explicit instruction. The cash stack
// (maxSpend) and the target trade duration both still cap the quantity afterwards, so a bigger size
// is only ever suggested when it is actually affordable and realistically tradeable.
const DEFAULT_MARKET_QUANTITY_CAP = 100;

// The fallback this tier reaches for only when computeSuggestion above finds nothing eligible in
// this account's own history: ranks the *entire* item catalogue by current net margin after tax,
// gated by a minimum-hourly-volume liquidity floor so an untraded item's stale spread can't win
// just because nobody is around to close the margin. Deliberately simpler than the browser
// scanner's own multi-factor score (no price-history/prediction signal, no personal-history
// weighting) -- this is meant as a "something is currently open" nudge for items you have no
// track record on, not a replacement for reviewing it yourself before committing capital.
// mapping: the Wiki /mapping response body (array of {id, name, limit, members, ...}).
// volumes: the Wiki /1h response's "data" object, keyed by item ID, each an
// {avgHighPrice, highPriceVolume, avgLowPrice, lowPriceVolume} snapshot.
// options.maxSpend: the player's actual current cash stack (read from their inventory's coins),
// optional. Without it, this ranks purely by per-unit margin, which can surface a huge-margin,
// low-limit item (e.g. a rare piece of equipment) at a quantity nobody could actually afford --
// OSRS's own cash stack caps out at ~2.147 billion gp, and a suggestion should never assume more
// than the player actually has on hand. With maxSpend set: an item costing more than that per unit
// is dropped outright (unaffordable even at quantity 1); every other candidate's quantity is
// capped so total cost never exceeds it; and ranking switches from per-unit net margin to total
// realizable profit at that affordable quantity, so the pick is the best trade actually reachable
// with the cash on hand, not just the item with the biggest margin per unit.
// options.targetDurationMinutes: the player's own preferred trade length, checked against this
// same volumes argument (already fetched for the liquidity floor below, so this adds no extra
// cost) via estimatedFillMinutes -- a candidate that couldn't realistically trade even one unit
// within that window is dropped, and one that could but only at a smaller quantity has it capped
// down, exactly like maxSpend, and also switches ranking to total realizable profit (see below).
export function computeMarketSuggestion(mapping, latestPrices, volumes, options = {}) {
  if (!Array.isArray(mapping) || !latestPrices) return null;
  const minProfit = Number.isFinite(options.minProfit) && options.minProfit > 0 ? options.minProfit : 0;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  const maxSpend = Number.isFinite(options.maxSpend) && options.maxSpend > 0 ? options.maxSpend : undefined;
  const targetDurationMinutes = Number.isFinite(options.targetDurationMinutes) && options.targetDurationMinutes > 0 ? options.targetDurationMinutes : undefined;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxPriceAgeMinutes = Number.isFinite(options.maxPriceAgeMinutes) ? options.maxPriceAgeMinutes : MAX_PRICE_AGE_MINUTES;
  const candidates = [];
  for (const item of mapping) {
    if (!item || !Number.isFinite(item.id) || blocklist.has(item.id)) continue;
    // A members-only item can't be traded on a free-to-play world at all. `item.members === true`
    // is the mapping's own flag; the caller's membersBlocked gate (same answer, one source) is used
    // when supplied so every tier agrees.
    if (options.membersBlocked ? options.membersBlocked(item.id) : false) continue;
    const p = latestPrices[String(item.id)];
    if (!p || !(p.low > 0) || !(p.high > 0)) continue;
    const v = volumes?.[String(item.id)];
    const liquidity = Math.min(v?.highPriceVolume || 0, v?.lowPriceVolume || 0);
    if (liquidity < MIN_HOURLY_VOLUME) continue;
    // No track record backs this tier, so a spread nobody has traded on either side recently is
    // dropped outright rather than ranked (see priceAgeMinutes). Unknown timestamps fail open.
    const ageMinutes = priceAgeMinutes(p, now);
    if (ageMinutes !== null && ageMinutes > maxPriceAgeMinutes) continue;
    const tax = estimateUnitTax(item.id, p.high);
    const net = p.high - p.low - tax;
    if (net <= 0) continue;
    // The item's own GE buy limit when known (see DEFAULT_MARKET_QUANTITY_CAP above), else the cap.
    const limitKnown = Number.isFinite(item.limit) && item.limit > 0;
    let quantity = Math.max(1, limitKnown ? item.limit : DEFAULT_MARKET_QUANTITY_CAP);
    const fullSize = quantity;
    let cashLimited = false;
    if (maxSpend !== undefined) {
      const affordable = Math.floor(maxSpend / p.low);
      if (affordable < 1) continue; // can't afford even one unit at the current cash stack
      if (affordable < quantity) { quantity = affordable; cashLimited = true; }
    }
    let durationLimited = false;
    if (targetDurationMinutes !== undefined) {
      // liquidity is already known to be > 0 here (the MIN_HOURLY_VOLUME gate above guarantees it).
      if (estimatedFillMinutes(1, liquidity, VOLUME_WINDOW_MINUTES) > targetDurationMinutes) continue; // not realistic even at quantity 1 within the window
      const fillable = Math.max(1, Math.floor(liquidity / VOLUME_WINDOW_MINUTES * targetDurationMinutes));
      if (fillable < quantity) { quantity = fillable; durationLimited = true; }
    }
    const gated = gateCandidate(item.id, quantity, options);
    if (!gated) continue;
    const limitLimited = gated.limited;
    quantity = gated.quantity;
    const predictedProfit = net * quantity;
    if (predictedProfit < minProfit) continue;
    // Rewards both margin and real liquidity, log-damped so one exceptionally deep item can't
    // dominate purely on volume with a thin margin. Once a cash stack or a target duration is
    // known, ranking targets the best *total* profit actually reachable within that constraint
    // rather than the best per-unit margin -- otherwise a wildly unaffordable (or unrealistically
    // slow) item would still win the ranking capped down to a quantity of 1, instead of a cheaper
    // or faster-moving item that can be bought and sold for real within the same constraint.
    const constrained = maxSpend !== undefined || targetDurationMinutes !== undefined;
    const score = (constrained ? predictedProfit : net) * Math.log(liquidity + 1);
    if (score <= 0) continue;
    candidates.push({item, p, net, quantity, predictedProfit, score, cashLimited, durationLimited, limitKnown, fullSize, limitLimited});
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const {item, p, quantity, predictedProfit, cashLimited, durationLimited, limitKnown, fullSize, limitLimited} = candidates[0];
  const notes = [];
  notes.push(limitKnown
    ? `sized to this item's own GE buy limit of ${fullSize.toLocaleString('en-US')} per 4 hours`
    : `capped at ${fullSize.toLocaleString('en-US')} because this item's GE buy limit is unknown`);
  if (cashLimited) notes.push('capped to what your current cash stack can afford');
  if (durationLimited) notes.push(`capped to fit an estimated ~${targetDurationMinutes}-minute trade`);
  if (limitLimited) notes.push('capped to what EVI has seen left of this item\'s 4-hour GE buy limit');
  return {
    itemId: item.id,
    name: item.name,
    action: 'buy',
    quantity,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'market',
    reasoning: `Market-wide pick -- you have no flip history for this item yet. Current margin after tax is ~${Math.round(predictedProfit).toLocaleString('en-US')} gp at quantity ${quantity}${notes.length ? ' (' + notes.join('; ') + ')' : ''} (buy near ${p.low.toLocaleString('en-US')} gp, sell near ${p.high.toLocaleString('en-US')} gp). Verify liquidity and news yourself before committing capital; this ranking has no track record behind it.`,
  };
}

// A richer alternative to computeMarketSuggestion above, used by GET /api/suggestion in server.mjs
// when includeMarketSuggestions is on AND the browser scanner has pushed a recent shortlist (see
// POST /api/scanner-suggestions, MAX_PUSHED_AGE_MS in server.mjs) -- otherwise this tier falls back
// to computeMarketSuggestion exactly as before this existed, so a plugin user who never opens the
// scanner sees no change at all. candidates: whatever the scanner last pushed, already ranked
// best-first by its own EVI Score (personal history, liquidity, stability, and -- when the scanner's
// own Predict button has been used -- price-direction prediction too), each shaped like
// {itemId, name, buy, sell, net, qty, score, mode}. Never trusts that ranking blindly: re-sorts by
// score here, and still applies the same blocklist/affordability/minProfit gates computeSuggestion
// and computeMarketSuggestion both apply, so a scanner-pushed pick can never bypass them. Returns the
// best surviving candidate (or null, exactly like the other compute* functions here), letting the
// caller's own pickWithForecast retry loop move to the next one on an unfavourable forecast.
export function computePushedSuggestion(candidates, options = {}) {
  if (!Array.isArray(candidates)) return null;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  const maxSpend = Number.isFinite(options.maxSpend) && options.maxSpend > 0 ? options.maxSpend : undefined;
  const minProfit = Number.isFinite(options.minProfit) && options.minProfit > 0 ? options.minProfit : 0;
  const ranked = candidates
    .filter(c => c && Number.isFinite(c.itemId) && c.itemId > 0 && !blocklist.has(c.itemId)
      && Number.isFinite(c.buy) && c.buy > 0 && Number.isFinite(c.sell) && c.sell > 0 && Number.isFinite(c.net) && c.net > 0)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  for (const c of ranked) {
    let quantity = Math.max(1, Math.round(Number.isFinite(c.qty) && c.qty > 0 ? c.qty : 1));
    // Same world/buy-limit gates every other tier applies, so a scanner-pushed pick can't bypass them.
    const gated = gateCandidate(c.itemId, quantity, options);
    if (!gated) continue;
    const limitLimited = gated.limited;
    quantity = gated.quantity;
    let cashLimited = false;
    if (maxSpend !== undefined) {
      const affordable = Math.floor(maxSpend / c.buy);
      if (affordable < 1) continue; // can't afford even one unit at the current cash stack
      if (affordable < quantity) { quantity = affordable; cashLimited = true; }
    }
    const predictedProfit = c.net * quantity;
    if (predictedProfit < minProfit) continue;
    const name = typeof c.name === 'string' && c.name ? c.name : `item ${c.itemId}`;
    const notes = [];
    if (cashLimited) notes.push('reduced to what your current cash stack can afford');
    if (limitLimited) notes.push('reduced to what EVI has seen left of this item\'s 4-hour GE buy limit');
    return {
      itemId: c.itemId,
      name,
      action: 'buy',
      quantity,
      buyPrice: c.buy,
      sellPrice: c.sell,
      source: 'scanner',
      reasoning: `Scanner pick (EVI score ${Math.round(c.score || 0)}${c.mode ? `, ${c.mode} pace` : ''}) -- ranked in your browser's scanner using price history, liquidity and your own trade record, not just current margin. Current margin after tax is ~${Math.round(predictedProfit).toLocaleString('en-US')} gp at quantity ${quantity}${notes.length ? ' (' + notes.join('; ') + ')' : ''} (buy near ${c.buy.toLocaleString('en-US')} gp, sell near ${c.sell.toLocaleString('en-US')} gp). Verify liquidity and news yourself before committing capital.`,
    };
  }
  return null;
}

// ---- Price-direction forecast, deliberately kept in lockstep with the scanner's own Predict-button
// model (forecastFromSeries and its helpers in scanner/EVI_Flip_Scanner_V3.html) -- same math, same
// thresholds, so a bridge-side forecast for an item/horizon and a scanner-side one for the same
// item/horizon agree. If one changes, change the other to match. See GET /api/suggestion in
// server.mjs for how this is actually wired into a "buy" suggestion (EviLiveConfig.forecastHorizon /
// ForecastPolicy on the plugin side -- ?forecast=/&onForecast= on the query string).
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
function midpointPoint(x) {
  const hi = Number(x.avgHighPrice), lo = Number(x.avgLowPrice);
  if (Number.isFinite(hi) && hi > 0 && Number.isFinite(lo) && lo > 0) return (hi + lo) / 2;
  if (Number.isFinite(hi) && hi > 0) return hi;
  if (Number.isFinite(lo) && lo > 0) return lo;
  return null;
}
function linSlope(vals) {
  const a = vals.filter(Number.isFinite);
  if (a.length < 3) return 0;
  const n = a.length, mx = (n - 1) / 2, my = a.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (a[i] - my); den += (i - mx) * (i - mx); }
  return den ? num / den : 0;
}
function ret(a, b) { return (Number.isFinite(a) && a > 0 && Number.isFinite(b)) ? (b / a - 1) : 0; }
function volOf(vals) {
  const rs = [];
  for (let i = 1; i < vals.length; i++) if (vals[i - 1] > 0 && vals[i] > 0) rs.push(Math.log(vals[i] / vals[i - 1]));
  if (rs.length < 2) return 0;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, b) => a + (b - m) * (b - m), 0) / (rs.length - 1));
}

// series: the Wiki /timeseries response's "data" array (already fetched by the caller). horizon:
// '1h'|'6h'|'overnight', matching ForecastHorizon.param() on the plugin side and the scanner's own
// three buckets exactly. Returns {label, dir (-1/-0.5.../0/0.5/1), confidence (0-100), move, ...} --
// never throws; fewer than 8 usable data points yields a deliberately low-confidence "Uncertain"
// rather than a fabricated direction.
export function forecastFromSeries(series, horizon) {
  const clean = (series || []).filter(x => midpointPoint(x) !== null).sort((a, b) => a.timestamp - b.timestamp);
  if (clean.length < 8) return {label: 'Uncertain', dir: 0, confidence: 20, move: 0};
  const mids = clean.map(midpointPoint), last = mids[mids.length - 1];
  const n = horizon === '1h' ? 12 : horizon === '6h' ? 18 : 28;
  const recent = mids.slice(-n), prev = mids.slice(-Math.min(mids.length, n * 2), -n);
  const slope = linSlope(recent) / (last || 1);
  const momentum = ret(recent[0], recent[recent.length - 1]);
  const longer = prev.length >= 3 ? ret(prev[0], prev[prev.length - 1]) : momentum;
  const volatility = volOf(recent);
  const buyVol = clean.slice(-n).reduce((s, x) => s + (x.highPriceVolume || 0), 0);
  const sellVol = clean.slice(-n).reduce((s, x) => s + (x.lowPriceVolume || 0), 0);
  const imbalance = (buyVol - sellVol) / Math.max(1, buyVol + sellVol);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const deviation = (last - mean) / Math.max(1, mean);

  let signal = 0.45 * momentum + 4.0 * slope + 0.012 * imbalance + 0.12 * longer;
  // Small mean-reversion term only after a meaningful deviation.
  if (Math.abs(deviation) > .025) signal += -0.08 * deviation;

  const noise = Math.max(.002, volatility * Math.sqrt(Math.max(1, recent.length / 4)));
  const strength = Math.abs(signal) / noise;
  let confidence = Math.round(clamp(42 + strength * 22, 42, 88));
  if (clean.length < 20) confidence = Math.min(confidence, 60);

  const threshold = Math.max(.0025, noise * .35);
  let label = 'Stable', dir = 0;
  if (signal > threshold) { label = 'Likely rising'; dir = 1; }
  else if (signal < -threshold) { label = 'Likely falling'; dir = -1; }
  else if (momentum < -.02 && deviation < -.015 && signal >= -threshold) { label = 'Possible rebound'; dir = 0.5; }
  return {label, dir, confidence, move: signal, volatility, deviation, imbalance};
}

// Which Wiki /timeseries timestep to fetch for a given forecast horizon -- mirrors the scanner's own
// pairing exactly (its Predict button forecasts '1h' from a 5-minute series, '6h' from an hourly
// series, and 'overnight' from a 6-hourly series; forecastFromSeries's n above assumes that pairing,
// not the horizon's own literal length). Returns null for an unrecognised horizon.
export function timestepForHorizon(horizon) {
  return {'1h': '5m', '6h': '1h', overnight: '6h'}[horizon] || null;
}

// ---- Volatility-relative margin safety cushion (EviLiveConfig.marginSafetyCushion, on by
// default). Reuses the exact same Wiki /timeseries fetch and price-history plumbing as the
// forecast feature above, but answers a different question: not "which way is this item's price
// heading" but "how thin is this predicted margin compared to how much this SPECIFIC item's price
// normally wobbles on its own." A flat percentage floor would either block legitimate thin-margin,
// high-volume flips (bad for a low-capital account) or let a volatile item's margin get swallowed
// by its own ordinary noise (the real risk this was built to catch) -- comparing against the
// item's own recent behaviour avoids both.

// series: the Wiki /timeseries response's "data" array (same shape forecastFromSeries takes,
// already fetched by the caller). n: how many of the most recent points to look at -- defaults to
// 24 (e.g. roughly 2 hours of 5-minute candles) as a general "how much does this item normally
// move over a short window" estimate, independent of any particular forecast horizon. Returns null
// when there isn't enough price history to say anything (fewer than 8 usable points) or the item
// shows no measurable movement in that window at all -- callers must treat null as "no signal",
// never as "zero volatility": an unknown wobble must never silently block a suggestion, which would
// be exactly the kind of guess the accuracy directive this feature exists to satisfy rules out.
export function estimateVolatility(series, n = 24) {
  const clean = (series || []).filter(x => midpointPoint(x) !== null).sort((a, b) => a.timestamp - b.timestamp);
  if (clean.length < 8) return null;
  const mids = clean.map(midpointPoint).slice(-n);
  const stepVol = volOf(mids);
  if (!(stepVol > 0)) return null;
  // Scales the per-candle noise up to roughly "how far this item's price randomly wanders over the
  // whole window looked at" -- the standard random-walk sqrt(steps) approximation, the same scaling
  // forecastFromSeries's own noise term already uses.
  const windowVol = stepVol * Math.sqrt(Math.max(1, mids.length - 1));
  return {stepVol, windowVol, points: mids.length};
}

// How many "typical price wobble" widths (see estimateVolatility above) a predicted per-unit margin
// must clear before a candidate is trusted. 1 keeps only candidates whose margin is at least as
// large as this item's own recent swings would often produce on their own -- so ordinary noise
// alone is unlikely to erase a predicted profit, or flip it into a loss, before the trade even
// completes. This can never prove a trade WILL be profitable, only that its margin isn't already
// sitting inside the item's own noise floor.
export const MARGIN_CUSHION_MULTIPLIER = 1;

// Pure decision. marginPerUnit: predicted buy/sell margin per unit, after tax. price: the current
// sell price, used to turn volEstimate's fraction into a gp figure comparable to marginPerUnit.
// Returns {blocked, noiseGp}: noiseGp is null (and blocked is always false) whenever volEstimate,
// price or marginPerUnit isn't a usable positive number -- unknown or non-positive inputs never
// block a candidate, only a confirmed thin-relative-to-noise margin does.
export function marginClearsCushion(marginPerUnit, price, volEstimate, cushionMultiplier = MARGIN_CUSHION_MULTIPLIER) {
  if (!volEstimate || !(price > 0) || !(marginPerUnit > 0)) return {blocked: false, noiseGp: null};
  const noiseGp = price * volEstimate.windowVol;
  return {blocked: marginPerUnit < noiseGp * cushionMultiplier, noiseGp};
}

// A forecast this confident and this negative is treated as "meaningfully unfavorable" by
// ForecastPolicy.SKIP in server.mjs -- deliberately above forecastFromSeries' own default-ish
// confidence band (most real forecasts land in the low-to-mid 40s-60s) so only a comparatively
// strong "likely falling" reading ever drops a candidate, not routine noise.
export const UNFAVORABLE_FORECAST_CONFIDENCE = 55;

// Human-readable horizon text folded into a forecast-carrying suggestion's reasoning.
export const FORECAST_HORIZON_LABEL = {'1h': '~1 hour', '6h': '~6 hours', overnight: 'overnight'};

// Pure decision: given a forecast (or null/undefined -- no data) and a policy ('warn'|'skip'),
// should the caller keep this candidate or retry with the next-best one? Split out from
// pickWithForecast below purely so the threshold logic itself has a direct, trivial unit test.
export function decideForecast(forecast, policy) {
  if (!forecast) return 'keep';
  if (policy === 'skip' && forecast.dir === -1 && forecast.confidence >= UNFAVORABLE_FORECAST_CONFIDENCE) return 'retry';
  return 'keep';
}

// Generic forecast-aware retry driver shared by the personal-history and market-wide "buy" tiers in
// server.mjs's GET /api/suggestion. Kept here (not inline in the HTTP handler) so the actual
// decision logic -- when to keep vs. retry, how a forecast gets folded into reasoning -- has direct
// test coverage with synthetic rank/forecastFor functions, no live HTTP server or real Wiki API call
// needed. rank(blocklist) is called fresh each attempt against the same (mutated) blocklist Set, so
// an excluded item compounds across attempts exactly like every other blocklist use in this file.
// forecastFor(itemId) is only ever awaited for a candidate whose action is 'buy' and only when
// horizon is set -- a 'sell' suggestion (a holding/inventory reminder) or a disabled forecast
// (horizon falsy, i.e. EviLiveConfig.forecastHorizon() is OFF) skips straight to the cushion check
// below, no extra call at all. cushionFor(candidate) (added alongside forecastFor, same "only for a
// 'buy' candidate" gating) is the margin-safety-cushion counterpart -- see marginClearsCushion above
// and EviLiveConfig.marginSafetyCushion() -- only awaited when requireCushion is truthy, and only
// ever expected to return {blocked, note} (note optional); a blocked candidate is retried exactly
// like an unfavourable SKIP-policy forecast, and a kept one has `note` (when present) folded into
// its reasoning the same way a forecast is. Both checks share the same blocklist and attempt
// budget, so a candidate that fails either one compounds into the next attempt's ranking exactly
// once, never twice. Returns null (never throws) when rank runs out of candidates (every attempt
// either found nothing, or every attempt so far failed forecast/cushion) -- the caller falls
// through to its own next fallback tier exactly as when nothing was eligible before either of these
// existed.
export async function pickWithForecast({rank, forecastFor, policy, horizon, cushionFor, requireCushion, blocklist, maxAttempts = 3}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = rank(blocklist);
    if (!candidate) return null;
    if (candidate.action !== 'buy') return candidate;
    if (forecastFor && horizon) {
      const forecast = await forecastFor(candidate.itemId);
      if (forecast) {
        candidate.forecast = forecast;
        candidate.reasoning += ` Price forecast (${FORECAST_HORIZON_LABEL[horizon] || horizon}): ${forecast.label}, ${forecast.confidence}% confidence.`;
        if (decideForecast(forecast, policy) === 'retry') { blocklist.add(candidate.itemId); continue; }
      }
    }
    if (cushionFor && requireCushion) {
      const cushion = await cushionFor(candidate);
      if (cushion) {
        if (cushion.blocked) { blocklist.add(candidate.itemId); continue; }
        if (cushion.note) candidate.reasoning += ` ${cushion.note}`;
      }
    }
    return candidate;
  }
  return null;
}
