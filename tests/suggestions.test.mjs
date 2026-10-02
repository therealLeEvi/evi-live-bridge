import {test} from 'node:test';
import assert from 'node:assert/strict';
import {personalHistory, computeSuggestion, computeMarketSuggestion, computeHoldingSuggestion, computeInventorySuggestion, computePushedSuggestion, pickPersistentOpenPosition, lookupItemPrice, forecastFromSeries, timestepForHorizon, UNFAVORABLE_FORECAST_CONFIDENCE, decideForecast, forecastPolicyNote, FORECAST_MAY_DROP_CANDIDATES, pickWithForecast, estimateOfferFill, estimateVolatility, marginClearsCushion, MARGIN_CUSHION_MULTIPLIER, breakEvenSellPrice, priceAgeMinutes, MAX_PRICE_AGE_MINUTES, slotCapacity, slotNote, slotExposure, withCostBasis, heldCostBasis, sellPriceSupport, sellSupportNote, volumeReadingFor, GE_SLOTS, mergeArchiveHours, volumeShareForDuration, limitAllowance, BULK_MIN_LIMIT, focusAllows, FOCUSES, resolveFocus} from '../bridge/suggestions.mjs';

const now = 1700000000000;
function flip(o = {}) {
  return {itemId: 1, item: 'Rune nails', quantity: 100, capital: 10000, netProceeds: 12000, profit: 2000,
    firstBuy: now - 3600000, lastSell: now - 1800000, hold: 0.5, confirmedAt: now - 1800000, removed: false, ...o};
}
function prices(o = {}) {return {'1': {high: 130, low: 100}, ...o};}

test('no flips means no suggestion', () => {
  assert.equal(computeSuggestion([], prices(), now), null);
});

test('a losing track record is not suggested', () => {
  const flips = [flip({profit: -500}), flip({profit: -200})];
  assert.equal(computeSuggestion(flips, prices(), now), null);
});

test('missing current price data excludes an otherwise-eligible item', () => {
  const flips = [flip()];
  assert.equal(computeSuggestion(flips, prices({'1': undefined}), now), null);
});

test('a profitable personal history with current positive margin is suggested', () => {
  const flips = [flip(), flip({quantity: 200})];
  const s = computeSuggestion(flips, prices(), now);
  assert.equal(s.itemId, 1);
  assert.equal(s.name, 'Rune nails');
  assert.equal(s.action, 'buy');
  assert.equal(s.buyPrice, 100); // buys at the current low, like the rest of this project's flip flow
  assert.equal(s.sellPrice, 130); // sells at the current high, matching the margin calc below
  assert.equal(s.quantity, 150); // median of [100,200]
  assert.equal(s.source, 'personal');
  assert.match(s.reasoning, /2 times/);
});

test('both a buy and a sell price are always returned, not just one side', () => {
  const flips = [flip(), flip({quantity: 200})];
  const s = computeSuggestion(flips, prices(), now);
  assert.equal(s.buyPrice, 100);
  assert.equal(s.sellPrice, 130);
  assert.ok(s.sellPrice > s.buyPrice, 'sell price must be the current high, above the buy price');
});

test('removed flips are excluded from personal history', () => {
  const flips = [flip(), flip({removed: true, profit: -100000})];
  const h = personalHistory(flips);
  assert.equal(h.length, 1);
  assert.equal(h[0].trades, 1);
});

test('higher expected value wins between two eligible items', () => {
  const flips = [flip({itemId: 1, item: 'Rune nails', profit: 500}), flip({itemId: 2, item: 'Adamant arrow', profit: 5000})];
  const s = computeSuggestion(flips, prices({'2': {high: 130, low: 100}}), now);
  assert.equal(s.itemId, 2);
});

test('a stale track record loses to a recent one of similar size', () => {
  const flips = [
    flip({itemId: 1, item: 'Rune nails', profit: 2000, lastSell: now - 60 * 86400000}), // ~60 days old
    flip({itemId: 2, item: 'Adamant arrow', profit: 2000, lastSell: now - 3600000}), // 1 hour old
  ];
  const s = computeSuggestion(flips, prices({'2': {high: 130, low: 100}}), now);
  assert.equal(s.itemId, 2);
});

test('a positive-margin exempt item is not penalized by tax', () => {
  // itemId 1755 is in the tax-exemption list carried over from bridge/tax.mjs.
  const flips = [flip({itemId: 1755, item: 'Chef\'s hat'})];
  const s = computeSuggestion(flips, prices({'1755': {high: 130, low: 100}}), now);
  assert.equal(s.itemId, 1755);
});

test('a margin that cannot clear estimated tax is not suggested', () => {
  const flips = [flip({itemId: 1})];
  // high-low spread of 1gp cannot clear even a modest per-unit tax at this price level
  const s = computeSuggestion(flips, prices({'1': {high: 101, low: 100}}), now);
  assert.equal(s, null);
});

// -- minProfit, blocklist, risk: the three suggestion-tuning settings surfaced in the plugin's config. --

test('minProfit filters out a suggestion below the predicted-profit floor', () => {
  const flips = [flip(), flip({quantity: 200})]; // predicted profit here is 28gp/unit * 150 = 4,200
  const below = computeSuggestion(flips, prices(), now, {minProfit: 5000});
  assert.equal(below, null);
  const above = computeSuggestion(flips, prices(), now, {minProfit: 4000});
  assert.equal(above.itemId, 1);
});

test('blocklist excludes an item even when it would otherwise be the top suggestion', () => {
  const flips = [flip({itemId: 1, item: 'Rune nails', profit: 500}), flip({itemId: 2, item: 'Adamant arrow', profit: 5000})];
  const allPrices = prices({'2': {high: 130, low: 100}});
  const unblocked = computeSuggestion(flips, allPrices, now);
  assert.equal(unblocked.itemId, 2); // the higher-EV item wins by default
  const blocked = computeSuggestion(flips, allPrices, now, {blocklist: new Set([2])});
  assert.equal(blocked.itemId, 1); // falls back to the next-best, non-blocked item
  const blockedAll = computeSuggestion(flips, allPrices, now, {blocklist: new Set([1, 2])});
  assert.equal(blockedAll, null);
});

test('risk:high accepts a thinner win rate that medium and low both reject', () => {
  // 2 wins of 5000, 3 losses of 500: trades=5, winRate=0.4, avgProfit=1700 -- clears high's 0.4
  // floor but not medium's or low's 0.5+/0.75+ floors.
  const flips = [
    flip({profit: 5000}), flip({profit: 5000}),
    flip({profit: -500}), flip({profit: -500}), flip({profit: -500}),
  ];
  assert.equal(computeSuggestion(flips, prices(), now), null); // default is medium
  assert.equal(computeSuggestion(flips, prices(), now, {risk: 'medium'}), null);
  assert.equal(computeSuggestion(flips, prices(), now, {risk: 'low'}), null);
  const s = computeSuggestion(flips, prices(), now, {risk: 'high'});
  assert.equal(s.itemId, 1);
});

test('risk:low demands more trades than the medium default, even at a perfect win rate', () => {
  const flips = [flip(), flip({quantity: 200})]; // trades=2, winRate=1.0 -- passes medium, not low's minTrades=3
  assert.ok(computeSuggestion(flips, prices(), now, {risk: 'medium'}));
  assert.equal(computeSuggestion(flips, prices(), now, {risk: 'low'}), null);
  const threeFlips = [flip(), flip({quantity: 200}), flip({quantity: 150})];
  assert.ok(computeSuggestion(threeFlips, prices(), now, {risk: 'low'}));
});

test('an unrecognized risk value falls back to medium rather than throwing or matching everything', () => {
  const flips = [flip(), flip({quantity: 200})];
  const s = computeSuggestion(flips, prices(), now, {risk: 'extreme'});
  assert.ok(s);
  assert.equal(s.itemId, 1);
});

// -- maxSpend: the player's actual current cash stack (read from their inventory), so a
// suggestion never assumes more GP than they actually have on hand right now. --

test('maxSpend caps suggested quantity to what the cash stack can afford', () => {
  const flips = [flip(), flip({quantity: 200})]; // median qty 150, buy price 100gp/unit
  const s = computeSuggestion(flips, prices(), now, {maxSpend: 5000});
  assert.equal(s.quantity, 50); // floor(5000 / 100)
  assert.match(s.reasoning, /reduced from your usual size/);
});

test('maxSpend drops a personal-history candidate that cannot be afforded even at quantity 1', () => {
  const flips = [flip()]; // buy price is 100gp/unit
  const s = computeSuggestion(flips, prices(), now, {maxSpend: 50});
  assert.equal(s, null);
});

test('a maxSpend big enough to afford the usual quantity leaves it unchanged and unflagged', () => {
  const flips = [flip(), flip({quantity: 200})];
  const s = computeSuggestion(flips, prices(), now, {maxSpend: 1000000});
  assert.equal(s.quantity, 150);
  assert.doesNotMatch(s.reasoning, /reduced from your usual size/);
});

// -- computeHoldingSuggestion: not a ranked pick, a reminder to close out a position the plugin
// has observed the player already opened (bought and collected) but not yet resold. --

test('holding: nothing held means no suggestion', () => {
  assert.equal(computeHoldingSuggestion(prices(), NaN, NaN, undefined), null);
  assert.equal(computeHoldingSuggestion(prices(), 0, 5, 'Rune nails'), null); // itemId 0 is not a real item
  assert.equal(computeHoldingSuggestion(prices(), 1, 0, 'Rune nails'), null); // quantity 0: nothing actually held
});

test('holding: current price unavailable falls back to null so the caller can rank normally', () => {
  assert.equal(computeHoldingSuggestion(prices({'1': undefined}), 1, 50, 'Rune nails'), null);
});

test('holding: a valid held item is returned as a sell suggestion, independent of any ranking', () => {
  const s = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails');
  assert.equal(s.itemId, 1);
  assert.equal(s.name, 'Rune nails');
  assert.equal(s.action, 'sell');
  assert.equal(s.quantity, 50);
  assert.equal(s.buyPrice, 100);
  assert.equal(s.sellPrice, 130);
  assert.equal(s.source, 'holding');
  assert.match(s.reasoning, /holding 50 Rune nails/);
});

test('holding: a missing name falls back to a generic label rather than throwing', () => {
  const s = computeHoldingSuggestion(prices(), 1, 50, undefined);
  assert.match(s.name, /item 1/);
});

test('holding: the specific buy offer behind the position is passed through as buyId, or null when not supplied', () => {
  assert.equal(computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', 'buy-42').buyId, 'buy-42');
  assert.equal(computeHoldingSuggestion(prices(), 1, 50, 'Rune nails').buyId, null);
  assert.equal(computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', '').buyId, null);
});

// -- holdBuyPrice: the real cost-basis check that fixes the actual failure report -- EVI suggested
// a buy, the market moved before the position was even fully bought and collected, and the
// follow-up "you're holding this" reminder said nothing about it, reading identically whether
// selling now was a profit or an 11,000gp loss. Item 1 here is high:130/low:100, tax
// floor(130/50)=2gp/unit (see prices() above and tax.mjs).
test('holdBuyPrice omitted, zero, or negative: falls back to the original cost-agnostic wording, never a fabricated cost basis', () => {
  for (const bad of [undefined, 0, -5, NaN]) {
    const s = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', undefined, bad);
    assert.match(s.reasoning, /from an earlier buy that hasn't been resold yet/, `holdBuyPrice=${bad} must not change the reasoning`);
    assert.doesNotMatch(s.reasoning, /bought at/);
  }
});

test('holdBuyPrice below the current net sell price: reasoning states the real profit, not just "sell near X"', () => {
  // net/unit = 130 - 90 - 2 tax = 38; total = 38*50 = 1900
  const s = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', undefined, 90);
  assert.match(s.reasoning, /bought at 90 gp/);
  assert.match(s.reasoning, /net about \+1,900 gp/);
  assert.doesNotMatch(s.reasoning, /LOSS/);
  // buyPrice/sellPrice stay the plain current-market figures -- only reasoning carries the real cost basis.
  assert.equal(s.buyPrice, 100);
  assert.equal(s.sellPrice, 130);
});

test('holdBuyPrice above the current net sell price: reasoning explicitly says LOSS, with the true amount and no sell instruction', () => {
  // net/unit = 130 - 150 - 2 tax = -22; total = -22*50 = -1100 -> shown as a positive 1,100gp loss
  const s = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', undefined, 150);
  assert.match(s.reasoning, /bought at 150 gp/);
  assert.match(s.reasoning, /LOSS of about 1,100 gp/);
  assert.doesNotMatch(s.reasoning, /-1,100/, 'the loss amount must read as a plain positive figure after "LOSS of", never a redundant double negative');
  assert.match(s.reasoning, /not a recommendation/i);
});

test('holdBuyPrice exactly breaking even: treated as a (non-)profit of 0, not a loss', () => {
  // net/unit = 130 - 128 - 2 tax = 0 exactly
  const s = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', undefined, 128);
  assert.match(s.reasoning, /net about \+0 gp/);
  assert.doesNotMatch(s.reasoning, /LOSS/);
});

// -- pickPersistentOpenPosition: the fallback source for the holding reminder when the plugin's
// own live hold signal is empty, most notably right after a RuneLite/plugin restart. Derived from
// Store.state().autoOpenPositions, which survives any restart because it's built from the
// bridge's own on-disk journal. --

function position(o = {}) {
  return {account: 'acct-a', itemId: 1, item: 'Rune nails', buyId: 'buy-1', remaining: 40, totalQty: 100,
    firstSeen: now - 3600000, partiallySold: false, ...o};
}

test('persistent: no account means no fallback pick', () => {
  assert.equal(pickPersistentOpenPosition([position()], undefined), null);
  assert.equal(pickPersistentOpenPosition([position()], ''), null);
});

test('persistent: no open positions means no fallback pick', () => {
  assert.equal(pickPersistentOpenPosition([], 'acct-a'), null);
  assert.equal(pickPersistentOpenPosition(null, 'acct-a'), null);
});

test('persistent: only positions for the asking account are considered', () => {
  const positions = [position({account: 'acct-a', itemId: 1}), position({account: 'acct-b', itemId: 2})];
  const pick = pickPersistentOpenPosition(positions, 'acct-a');
  assert.equal(pick.itemId, 1);
  assert.equal(pickPersistentOpenPosition(positions, 'acct-c'), null); // an account this bridge has never seen
});

test('persistent: a position already fully closed out (remaining 0) is never picked', () => {
  const positions = [position({remaining: 0})];
  assert.equal(pickPersistentOpenPosition(positions, 'acct-a'), null);
});

test('persistent: an item in the exclusion blocklist (e.g. an active GE slot right now) is skipped', () => {
  const positions = [position({itemId: 1}), position({itemId: 2, firstSeen: now - 1800000})];
  const pick = pickPersistentOpenPosition(positions, 'acct-a', new Set([1]));
  assert.equal(pick.itemId, 2); // item 1 excluded even though it would otherwise win on firstSeen
});

test('persistent: the earliest-bought-first position wins when more than one is open', () => {
  const positions = [
    position({itemId: 1, firstSeen: now - 1800000}), // 30 minutes ago
    position({itemId: 2, firstSeen: now - 7200000}), // 2 hours ago -- older, should win
  ];
  const pick = pickPersistentOpenPosition(positions, 'acct-a');
  assert.equal(pick.itemId, 2);
});

// -- lookupItemPrice: a plain live-market price for a single, arbitrary item ID -- no ranking, no
// flip-history gate, no volume/affordability filtering. Lets the plugin's hint/hotkey work for any
// item currently open in a GE offer, not only EVI's own top-ranked pick. --

test('lookupItemPrice: an invalid item ID returns null rather than throwing', () => {
  assert.equal(lookupItemPrice(prices(), NaN), null);
  assert.equal(lookupItemPrice(prices(), 0), null);
  assert.equal(lookupItemPrice(prices(), -1), null);
});

test('lookupItemPrice: no live price data for this item returns null', () => {
  assert.equal(lookupItemPrice(prices({'1': undefined}), 1), null);
  assert.equal(lookupItemPrice(prices(), 99999), null); // not present in `prices()` at all
});

test('lookupItemPrice: a valid item returns its current low/high, independent of any flip history', () => {
  const p = lookupItemPrice(prices(), 1);
  assert.equal(p.itemId, 1);
  assert.equal(p.buyPrice, 100);
  assert.equal(p.sellPrice, 130);
});

// -- targetDurationMinutes: the player's own preferred trade length, checked against Wiki /1h
// recent-volume data. A coarse feasibility estimate, not a real order-book simulation. --

test('duration: enough recent volume leaves quantity unchanged and unflagged', () => {
  const flips = [flip(), flip({quantity: 200})]; // median qty 150
  const vols = volumes({'1': {highPriceVolume: 2000, lowPriceVolume: 2000}}); // 2000/hr -- plenty for 150 units in 10 min
  const s = computeSuggestion(flips, prices(), now, {targetDurationMinutes: 10, volumes: vols});
  assert.equal(s.quantity, 150);
  assert.doesNotMatch(s.reasoning, /estimated ~\d+-minute trade/);
});

test('duration: thin recent volume caps the suggested quantity', () => {
  const flips = [flip(), flip({quantity: 200})]; // median qty 150
  const vols = volumes({'1': {highPriceVolume: 100, lowPriceVolume: 100}}); // 100/hr = ~1.67/min
  // The volume-share cap is opted out of here so this stays a test of the duration cap alone.
  const s = computeSuggestion(flips, prices(), now, {targetDurationMinutes: 10, volumes: vols, maxVolumeShare: 0});
  // Sizing now divides by the measured passive-offer factor (see PASSIVE_FILL_FACTOR): a passive
  // offer takes about 1.5x longer than raw volume suggests, so fewer units fit the same window.
  assert.equal(s.quantity, 11); // floor(100/60*10 / 1.5)
  assert.match(s.reasoning, /reduced to fit an estimated ~10-minute trade/);
});

test('duration: too little recent volume to trade even one unit drops the candidate', () => {
  const flips = [flip()];
  const vols = volumes({'1': {highPriceVolume: 1, lowPriceVolume: 1}}); // 1/hr: far too slow for a 1-minute target
  const s = computeSuggestion(flips, prices(), now, {targetDurationMinutes: 1, volumes: vols});
  assert.equal(s, null);
});

test('duration: no volume data for the item leaves it unconstrained rather than dropping it', () => {
  const flips = [flip(), flip({quantity: 200})];
  const vols = volumes({'1': undefined});
  const s = computeSuggestion(flips, prices(), now, {targetDurationMinutes: 10, volumes: vols});
  assert.equal(s.quantity, 150);
});

test('market: duration too slow to trade even one unit drops the candidate', () => {
  const items = mapping([{id: 3, name: 'Slow mover', limit: 100}]);
  const p = prices({'3': {high: 130, low: 100}});
  const vols = {'3': {highPriceVolume: 5, lowPriceVolume: 5}}; // exactly the liquidity floor: 5/hr
  const unconstrained = computeMarketSuggestion(items, p, vols, {blocklist: new Set([1, 2])});
  assert.equal(unconstrained.itemId, 3); // liquid enough to pass the floor with no duration set
  const constrained = computeMarketSuggestion(items, p, vols, {blocklist: new Set([1, 2]), targetDurationMinutes: 1});
  assert.equal(constrained, null); // 5/hr cannot realistically move even one unit inside a 1-minute window
});

test('market: targetDurationMinutes switches ranking to total achievable profit, not just per-unit margin', () => {
  const items = mapping([
    {id: 3, name: 'Expensive rare', limit: 100},
    {id: 4, name: 'Cheap bulk item', limit: 100},
  ]);
  const p = prices({'3': {high: 1300000, low: 1000000}, '4': {high: 9000, low: 5000}});
  // Item 1/2 have no volume entry here at all, so the liquidity floor excludes them regardless of price.
  const vols = {'3': {highPriceVolume: 20, lowPriceVolume: 20}, '4': {highPriceVolume: 6000, lowPriceVolume: 6000}};
  const unconstrained = computeMarketSuggestion(items, p, vols);
  assert.equal(unconstrained.itemId, 3); // per-unit margin alone favors the expensive item
  // 8 minutes rather than 3: no passive offer fills in under FILL_FLOOR_MINUTES x
  // PASSIVE_FILL_FACTOR (7.5 min), so a 3-minute target now correctly leaves nothing at all.
  const constrained = computeMarketSuggestion(items, p, vols, {targetDurationMinutes: 8});
  assert.equal(computeMarketSuggestion(items, p, vols, {targetDurationMinutes: 3}), null,
    'a target no passive offer could ever meet must return nothing, not a fake candidate');
  // At an 8-minute target: item 3's thin volume (20/hr) only realistically moves 1 unit
  // (~274,000gp); item 4's deep volume (6000/hr) still moves its full quantity of 100 (~382,000gp)
  // and wins on total achievable profit.
  assert.equal(constrained.itemId, 4);
  assert.equal(constrained.quantity, 100);
});

// -- computeMarketSuggestion: the item-catalogue-wide fallback used only when computeSuggestion
// finds nothing eligible in personal history, and only when the plugin opted in. --

function mapping(items = []) {
  return [{id: 1, name: 'Rune nails', limit: 10000}, {id: 2, name: 'Adamant arrow', limit: 11000}, ...items];
}
function volumes(o = {}) {
  return {'1': {highPriceVolume: 500, lowPriceVolume: 500}, '2': {highPriceVolume: 500, lowPriceVolume: 500}, ...o};
}

test('market: no mapping means no suggestion', () => {
  assert.equal(computeMarketSuggestion(null, prices(), volumes()), null);
  assert.equal(computeMarketSuggestion([], prices(), volumes()), null);
});

test('market: no price data means no suggestion', () => {
  assert.equal(computeMarketSuggestion(mapping(), null, volumes()), null);
});

test('market: an item below the hourly-volume liquidity floor is excluded even at a great margin', () => {
  const thin = volumes({'1': {highPriceVolume: 2, lowPriceVolume: 500}}); // the lower side is what counts
  const s = computeMarketSuggestion(mapping(), prices({'2': {high: 130, low: 100}}), thin);
  assert.equal(s.itemId, 2); // item 1 excluded by liquidity, item 2 still eligible
});

test('market: a positive-margin, liquid item across the whole catalogue is suggested with source "market"', () => {
  const s = computeMarketSuggestion(mapping(), prices(), volumes());
  assert.equal(s.itemId, 1);
  assert.equal(s.name, 'Rune nails');
  assert.equal(s.action, 'buy');
  assert.equal(s.buyPrice, 100);
  assert.equal(s.sellPrice, 130);
  assert.equal(s.source, 'market');
  assert.match(s.reasoning, /no flip history/i);
});

test('market: a margin that cannot clear estimated tax is not suggested', () => {
  const s = computeMarketSuggestion(mapping(), prices({'1': {high: 101, low: 100}}), volumes());
  assert.equal(s, null); // item 1 the only candidate here and its 1gp spread can't clear tax
});

// Sizing to the item's own GE buy limit (the real ceiling the GE enforces per 4 hours) replaced a
// flat 100-unit cap on every market-wide pick, on the user's explicit instruction: that cap made a
// 500k minimum predicted profit unreachable for exactly the high-volume, thinner-margin items that
// get there through quantity. Cash stack and trade duration still cap the size afterwards.
test('market: quantity is the item\'s own GE buy limit when the limit is known', () => {
  const s = computeMarketSuggestion(mapping(), prices(), volumes(), {maxVolumeShare: 0}); // the volume cap is tested separately
  assert.equal(s.quantity, 10000); // Rune nails' own limit
  assert.match(s.reasoning, /sized to this item's own GE buy limit of 10,000 per 4 hours/);
});

test('market: an unknown GE buy limit falls back to the small default cap, and says so', () => {
  const items = [{id: 3, name: 'No limit listed'}];
  const s = computeMarketSuggestion(items, prices({'3': {high: 1130, low: 1000}}), volumes({'3': {highPriceVolume: 50, lowPriceVolume: 50}}), {maxVolumeShare: 0});
  assert.equal(s.itemId, 3);
  assert.equal(s.quantity, 100);
  assert.match(s.reasoning, /GE buy limit is unknown/);
});

test('market: quantity uses the GE buy limit when it is below the default cap', () => {
  const items = mapping([{id: 3, name: 'Dragon dagger', limit: 8}]);
  const withDagger = prices({'3': {high: 15000, low: 14000}});
  const vols = volumes({'3': {highPriceVolume: 50, lowPriceVolume: 50}});
  const s = computeMarketSuggestion(items, withDagger, vols, {blocklist: new Set([1, 2]), maxVolumeShare: 0});
  assert.equal(s.itemId, 3);
  assert.equal(s.quantity, 8);
});

test('market: an unknown GE buy limit falls back to the default cap, not an unbounded quantity', () => {
  const items = mapping([{id: 3, name: 'No-limit item'}]); // no "limit" field at all
  const withItem = prices({'3': {high: 130, low: 100}});
  const vols = volumes({'3': {highPriceVolume: 50, lowPriceVolume: 50}});
  const s = computeMarketSuggestion(items, withItem, vols, {blocklist: new Set([1, 2]), maxVolumeShare: 0});
  assert.equal(s.itemId, 3);
  assert.equal(s.quantity, 100);
});

test('market: blocklist excludes an item even when it would otherwise win', () => {
  const both = prices({'2': {high: 130, low: 100}}); // give item 2 a price too, so it's a real candidate
  const s = computeMarketSuggestion(mapping(), both, volumes(), {blocklist: new Set([1])});
  assert.equal(s.itemId, 2);
  const none = computeMarketSuggestion(mapping(), both, volumes(), {blocklist: new Set([1, 2])});
  assert.equal(none, null);
});

test('market: minProfit filters out a candidate below the predicted-profit floor', () => {
  // net margin 28gp/unit * quantity 10,000 (Rune nails' buy limit) = 280,000 predicted profit
  const below = computeMarketSuggestion(mapping(), prices(), volumes(), {minProfit: 300000, blocklist: new Set([2]), maxVolumeShare: 0});
  assert.equal(below, null);
  const above = computeMarketSuggestion(mapping(), prices(), volumes(), {minProfit: 200000, blocklist: new Set([2]), maxVolumeShare: 0});
  assert.equal(above.itemId, 1);
});

test('market: a deeper margin can outrank a thinly-liquid one even with less raw volume', () => {
  const items = mapping([{id: 3, name: 'Big margin', limit: 100}]);
  const p = prices({'2': {high: 130, low: 100}, '3': {high: 1130, low: 1000}}); // item 3's margin dwarfs 1 and 2
  const vols = volumes({'3': {highPriceVolume: 10, lowPriceVolume: 10}}); // still clears the liquidity floor
  const s = computeMarketSuggestion(items, p, vols);
  assert.equal(s.itemId, 3);
});

// -- maxSpend: the player's actual current cash stack. Without it, a huge-margin, low-limit item
// (the "buy Confliction gauntlets x100" problem) can win the ranking and get sized at a quantity
// nobody could actually afford -- OSRS's own cash stack caps out at ~2.147bn gp regardless. --

test('market: maxSpend drops a candidate that cannot be afforded even at quantity 1', () => {
  const items = mapping([{id: 3, name: 'Confliction gauntlets', limit: 100}]);
  const withGauntlets = prices({'3': {high: 21500000, low: 20000000}});
  const vols = volumes({'3': {highPriceVolume: 10, lowPriceVolume: 10}});
  const blocklist = new Set([1, 2]);
  const unconstrained = computeMarketSuggestion(items, withGauntlets, vols, {blocklist});
  assert.equal(unconstrained.itemId, 3); // huge per-unit margin wins with no cash constraint at all
  const constrained = computeMarketSuggestion(items, withGauntlets, vols, {blocklist, maxSpend: 5000000});
  assert.equal(constrained, null); // 5m gp cannot afford even one unit at 20m gp each
});

test('market: maxSpend switches ranking to total achievable profit, not just per-unit margin', () => {
  const items = mapping([
    {id: 3, name: 'Expensive rare', limit: 100},
    {id: 4, name: 'Cheap bulk item', limit: 100},
  ]);
  const p = prices({'3': {high: 1300000, low: 1000000}, '4': {high: 8000, low: 5000}});
  const vols = volumes({'3': {highPriceVolume: 20, lowPriceVolume: 20}, '4': {highPriceVolume: 20, lowPriceVolume: 20}});
  const blocklist = new Set([1, 2]);
  const unconstrained = computeMarketSuggestion(items, p, vols, {blocklist, maxVolumeShare: 0});
  assert.equal(unconstrained.itemId, 3); // per-unit margin alone favors the expensive item
  const constrained = computeMarketSuggestion(items, p, vols, {blocklist, maxSpend: 1200000, maxVolumeShare: 0});
  // With only 1.2m gp: the expensive item is capped to quantity 1 (~274,000gp predicted profit);
  // the cheap item still fits its full quantity of 100 (~284,000gp) and wins on total profit.
  assert.equal(constrained.itemId, 4);
  assert.equal(constrained.quantity, 100);
  assert.match(constrained.reasoning, /no flip history/i);
});

test('market: a maxSpend big enough to afford the full quantity leaves it unchanged and unflagged', () => {
  const s = computeMarketSuggestion(mapping(), prices(), volumes(), {maxSpend: 1000000, maxVolumeShare: 0}); // exactly 10,000 units at 100 gp
  assert.equal(s.itemId, 1);
  assert.equal(s.quantity, 10000);
  assert.doesNotMatch(s.reasoning, /capped to what your current cash stack/);
});

// -- computeInventorySuggestion: the last-resort fallback for stock with no observed buy behind
// it at all (a drop, a quest reward, supplies bought before this bridge ever started watching). --

test('inventory: no inventory items means no suggestion', () => {
  assert.equal(computeInventorySuggestion(prices(), {}, mapping()), null);
  assert.equal(computeInventorySuggestion(prices(), null, mapping()), null);
});

test('inventory: a non-array mapping means no suggestion', () => {
  assert.equal(computeInventorySuggestion(prices(), {1: 1000}, null), null);
});

test('inventory: an empty mapping still suggests -- mapping only supplies display names, not the candidate pool', () => {
  const s = computeInventorySuggestion(prices(), {1: 1000}, []);
  assert.equal(s.itemId, 1);
  assert.equal(s.name, 'item 1'); // no mapping entry to resolve a real name from
});

test('inventory: platinum tokens are never suggested either -- they are gp, and are now counted as cash', () => {
  // Added 30 Sept 2026 with the Beyond Max Cash change. The plugin counts tokens as spending power
  // (refreshCashStack), so offering them as stock told a player holding 5,000 tokens both that they
  // had 5m to spend and that they should sell 5m of stock. Found by /code-review before it shipped.
  const withTokens = prices({'13204': {high: 1000, low: 1000}});
  assert.equal(computeInventorySuggestion(withTokens, {13204: 5000}, mapping()), null);
  // A real item alongside them is still offered, so the exclusion is the token and not the tier.
  const both = prices({'13204': {high: 1000, low: 1000}, '1': {high: 130, low: 100}});
  const s = computeInventorySuggestion(both, {13204: 5000, 1: 1000}, mapping());
  assert.equal(s && s.itemId, 1, 'the ordinary item is still suggested');
});

test('inventory: coins are never suggested regardless of quantity', () => {
  const withCoins = prices({'995': {high: 1, low: 1}});
  assert.equal(computeInventorySuggestion(withCoins, {995: 50000000}, mapping()), null);
});

test('inventory: below the minimum value floor is excluded', () => {
  // 100 * 130gp = 13,000gp, well under the 100,000gp floor
  assert.equal(computeInventorySuggestion(prices(), {1: 100}, mapping()), null);
});

test('inventory: a candidate above the value floor is suggested as a sell with no buyId', () => {
  // 1000 * 130gp = 130,000gp, clears the floor
  const s = computeInventorySuggestion(prices(), {1: 1000}, mapping());
  assert.equal(s.itemId, 1);
  assert.equal(s.name, 'Rune nails');
  assert.equal(s.action, 'sell');
  assert.equal(s.quantity, 1000);
  assert.equal(s.buyPrice, 100);
  assert.equal(s.sellPrice, 130);
  assert.equal(s.source, 'inventory');
  assert.equal(s.buyId, null);
});

test('inventory: an item with no live price data is excluded', () => {
  assert.equal(computeInventorySuggestion(prices({'1': undefined}), {1: 1000}, mapping()), null);
});

test('inventory: an unknown item ID falls back to a generic name', () => {
  const withUnknown = prices({'3': {high: 200, low: 150}});
  const s = computeInventorySuggestion(withUnknown, {3: 1000}, mapping());
  assert.equal(s.name, 'item 3');
});

test('inventory: blocklist excludes an item even when it is the only candidate', () => {
  assert.equal(computeInventorySuggestion(prices(), {1: 1000}, mapping(), {blocklist: new Set([1])}), null);
});

test('inventory: the highest total-value candidate wins, not the highest quantity or price', () => {
  const allPrices = prices({'2': {high: 130, low: 100}});
  // item 1: 1000 * 130 = 130,000gp; item 2: 2000 * 130 = 260,000gp -- item 2 wins on total value
  const s = computeInventorySuggestion(allPrices, {1: 1000, 2: 2000}, mapping());
  assert.equal(s.itemId, 2);
});

// ---- computePushedSuggestion (scanner-pushed shortlist -- see POST /api/scanner-suggestions) ----
function pushed(o = {}) { return {itemId: 1, name: 'Rune nails', buy: 100, sell: 130, net: 25, qty: 50, score: 80, mode: 'Medium', ...o}; }

test('pushed: not an array returns null', () => {
  assert.equal(computePushedSuggestion(undefined), null);
  assert.equal(computePushedSuggestion(null), null);
  assert.equal(computePushedSuggestion({}), null);
});

test('pushed: an empty or all-invalid list returns null, never throws', () => {
  assert.equal(computePushedSuggestion([]), null);
  assert.equal(computePushedSuggestion([{}, {itemId: 1}, {itemId: 1, buy: -5, sell: 10, net: 5, name: 'x'}]), null);
});

test('pushed: the highest-score candidate wins, re-sorted regardless of input order', () => {
  const s = computePushedSuggestion([pushed({itemId: 1, score: 40}), pushed({itemId: 2, score: 90}), pushed({itemId: 3, score: 60})]);
  assert.equal(s.itemId, 2);
});

test('pushed: blocklist excludes an item even when it would otherwise be the top score', () => {
  const s = computePushedSuggestion([pushed({itemId: 1, score: 90}), pushed({itemId: 2, score: 40})], {blocklist: new Set([1])});
  assert.equal(s.itemId, 2);
});

test('pushed: a cash stack too small for the top pick is skipped, falls through to the next', () => {
  const s = computePushedSuggestion([pushed({itemId: 1, score: 90, buy: 1000000}), pushed({itemId: 2, score: 40, buy: 100})], {maxSpend: 500});
  assert.equal(s.itemId, 2);
});

test('pushed: quantity is capped to what the cash stack affords, marked in the reasoning', () => {
  const s = computePushedSuggestion([pushed({qty: 50, buy: 100})], {maxSpend: 1000});
  assert.equal(s.quantity, 10);
  assert.match(s.reasoning, /reduced to what your current cash stack can afford/);
});

test('pushed: minProfit filters out a candidate whose total predicted profit falls short', () => {
  assert.equal(computePushedSuggestion([pushed({net: 10, qty: 5})], {minProfit: 1000}), null);
  const s = computePushedSuggestion([pushed({net: 10, qty: 5})], {minProfit: 40});
  assert.equal(s.itemId, 1);
});

test('pushed: an unnamed candidate falls back to a generic "item <id>" name', () => {
  const s = computePushedSuggestion([pushed({name: undefined})]);
  assert.equal(s.name, 'item 1');
});

test('pushed: source is "scanner" and both prices/action are populated like every other suggestion source', () => {
  const s = computePushedSuggestion([pushed()]);
  assert.equal(s.source, 'scanner');
  assert.equal(s.action, 'buy');
  assert.equal(s.buyPrice, 100);
  assert.equal(s.sellPrice, 130);
});

// ---- Forecast (mirrors the scanner's own Predict button -- see forecastFromSeries' own doc) ----
function seriesTrend(n, startPrice, stepPct, highVol, lowVol) {
  const out = []; let p = startPrice;
  for (let i = 0; i < n; i++) {
    out.push({timestamp: 1700000000 + i * 3600, avgHighPrice: Math.round(p), avgLowPrice: Math.round(p * 0.98), highPriceVolume: highVol, lowPriceVolume: lowVol});
    p *= (1 + stepPct);
  }
  return out;
}

test('forecastFromSeries: too little data is Uncertain, never a fabricated direction', () => {
  const f = forecastFromSeries(seriesTrend(5, 1000, -0.01, 10, 120), '6h');
  assert.equal(f.label, 'Uncertain');
  assert.equal(f.dir, 0);
  assert.equal(f.confidence, 20);
});

test('forecastFromSeries: a sustained, sell-heavy downtrend forecasts Likely falling with high confidence', () => {
  const f = forecastFromSeries(seriesTrend(60, 1000, -0.01, 10, 120), 'overnight');
  assert.equal(f.label, 'Likely falling');
  assert.equal(f.dir, -1);
  assert.ok(f.confidence >= UNFAVORABLE_FORECAST_CONFIDENCE, `expected confidence >= ${UNFAVORABLE_FORECAST_CONFIDENCE}, got ${f.confidence}`);
});

test('forecastFromSeries: a sustained, buy-heavy uptrend forecasts Likely rising', () => {
  const f = forecastFromSeries(seriesTrend(60, 1000, 0.01, 120, 10), 'overnight');
  assert.equal(f.label, 'Likely rising');
  assert.equal(f.dir, 1);
});

test('timestepForHorizon mirrors the scanner\'s own Predict-button pairing', () => {
  assert.equal(timestepForHorizon('1h'), '5m');
  assert.equal(timestepForHorizon('6h'), '1h');
  assert.equal(timestepForHorizon('overnight'), '6h');
  assert.equal(timestepForHorizon('bogus'), null);
});

// The forecast no longer drops candidates, and that is a measurement rather than a preference: see
// FORECAST_MAY_DROP_CANDIDATES and bridge/forecastCalibration.mjs. Calibrated over 90 days, the
// candidates this policy used to drop went on to move +4.261% while the ones it kept moved +0.553%.
test('decideForecast: an unproven forecast never removes a candidate, whatever the policy says', () => {
  const falling = {dir: -1, confidence: 80};
  const rising = {dir: 1, confidence: 90};
  assert.equal(FORECAST_MAY_DROP_CANDIDATES, false, 'the forecast has not earned the right to rule a trade out');
  assert.equal(decideForecast(null, 'skip'), 'keep');
  assert.equal(decideForecast(falling, 'warn'), 'keep');
  assert.equal(decideForecast(falling, 'skip'), 'keep', 'the strongest possible unfavourable reading must still only warn');
  assert.equal(decideForecast({dir: -1, confidence: 88}, 'skip'), 'keep');
  assert.equal(decideForecast(rising, 'skip'), 'keep');
  // Asking for skipping and silently getting nothing would be a setting that does nothing at all.
  assert.match(forecastPolicyNote('skip'), /inactive/);
  assert.equal(forecastPolicyNote('warn'), null, 'nothing to explain when nothing was asked for');
});

test('pickWithForecast: no horizon means the first candidate is returned untouched, no forecast call', async () => {
  let calls = 0;
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const result = await pickWithForecast({rank: () => candidate, forecastFor: async () => { calls++; return null; }, policy: 'warn', horizon: null, blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(calls, 0);
});

test('pickWithForecast: a "sell" suggestion is never forecast', async () => {
  let calls = 0;
  const candidate = {itemId: 1, action: 'sell', reasoning: 'base'};
  const result = await pickWithForecast({rank: () => candidate, forecastFor: async () => { calls++; return {label: 'x', dir: -1, confidence: 90}; }, policy: 'skip', horizon: 'overnight', blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(calls, 0);
});

test('pickWithForecast: the forecast is reported as fill risk, never as a price direction', async () => {
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const forecast = {label: 'Likely falling', dir: -1, confidence: 80};
  // ~6 hours: the only setting the fill rates were measured with (see fillOutlook).
  const result = await pickWithForecast({rank: () => candidate, forecastFor: async () => forecast, policy: 'warn', horizon: '6h', blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(result.forecast, forecast, 'the raw forecast still travels with the candidate');
  // Calibration found the direction labels wrong more often than chance and the strength score
  // uninformative, so neither is shown; the same signal's measured fill behaviour is.
  assert.ok(!/Likely falling|Likely rising/.test(result.reasoning), 'no direction claim reaches the player');
  assert.ok(!/confidence/.test(result.reasoning));
  assert.ok(result.fillOutlook, 'and the fill outlook is attached for anything that wants the numbers');
  assert.match(result.reasoning, /fill|sold within|Entry risk|Exit risk/i);
});

test('pickWithForecast: skip mode keeps the top candidate and explains why it did not skip', async () => {
  const blocklist = new Set();
  const seen = [];
  const rank = bl => {
    seen.push(new Set(bl));
    if (bl.has(1)) return {itemId: 2, action: 'buy', reasoning: 'second pick'};
    return {itemId: 1, action: 'buy', reasoning: 'first pick'};
  };
  const forecastFor = async itemId => itemId === 1 ? {label: 'Likely falling', dir: -1, confidence: 90} : {label: 'Stable', dir: 0, confidence: 50};
  const result = await pickWithForecast({rank, forecastFor, policy: 'skip', horizon: 'overnight', blocklist});
  // The old behaviour dropped item 1 and returned item 2 -- which measurement showed was throwing
  // away the better trade, so the best-ranked candidate now stands.
  assert.equal(result.itemId, 1);
  assert.ok(!blocklist.has(1), 'an unproven forecast must not exclude an item from ranking');
  assert.equal(seen.length, 1, 'and must not cost an extra ranking pass');
  assert.match(result.reasoning, /inactive/);
});

test('pickWithForecast: the retry machinery still works, for the checks that did earn it', async () => {
  // The cushion check is measured and still drops candidates; this is the same retry path the
  // forecast used, so it must keep working for whenever a calibrated forecast earns it back.
  let attempts = 0;
  const rank = () => { attempts++; return {itemId: attempts, action: 'buy', reasoning: 'pick'}; };
  const result = await pickWithForecast({rank, cushionFor: async () => ({blocked: true}), requireCushion: true,
    policy: 'warn', horizon: null, blocklist: new Set(), maxAttempts: 3});
  assert.equal(result, null);
  assert.equal(attempts, 3);
});

test('pickWithForecast: a missing forecast (network hiccup) never blocks the suggestion', async () => {
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const result = await pickWithForecast({rank: () => candidate, forecastFor: async () => null, policy: 'skip', horizon: 'overnight', blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(result.reasoning, 'base');
});

// -- Volatility-relative margin safety cushion (EviLiveConfig.marginSafetyCushion, on by default) --
// estimateVolatility: how much a specific item's own recent price wobbles, from real Wiki
// /timeseries data only. marginClearsCushion: the pure decision on whether a predicted margin
// clears that wobble. See both functions' own doc in bridge/suggestions.mjs.
function seriesNoisy(n, base, swing) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = i % 2 === 0 ? base + swing : base - swing;
    out.push({timestamp: 1700000000 + i * 300, avgHighPrice: p, avgLowPrice: p, highPriceVolume: 50, lowPriceVolume: 50});
  }
  return out;
}

test('estimateVolatility: fewer than 8 usable points is null, never a fabricated wobble', () => {
  assert.equal(estimateVolatility(seriesNoisy(5, 1000, 20)), null);
});

test('estimateVolatility: a perfectly flat price (no movement at all) is null, not zero-as-a-number', () => {
  const flat = seriesNoisy(10, 1000, 0); // swing 0 -> every price identical
  assert.equal(estimateVolatility(flat), null);
});

test('estimateVolatility: a genuinely noisy item returns a positive stepVol and a larger windowVol', () => {
  const v = estimateVolatility(seriesNoisy(12, 1000, 20));
  assert.ok(v.stepVol > 0, `expected a positive stepVol, got ${v && v.stepVol}`);
  assert.ok(v.windowVol > v.stepVol, 'windowVol must scale up from the single-step figure, not equal it');
  assert.equal(v.points, 12);
});

test('estimateVolatility: only looks at the most recent n points', () => {
  // 10 noisy points up front, then a dead-flat tail at least as long as the default window (24) --
  // that window must land entirely inside the flat tail, reading as no movement, not the earlier
  // noise.
  const noisy = seriesNoisy(10, 1000, 50);
  const flatTail = [];
  for (let i = 0; i < 24; i++) flatTail.push({timestamp: 1700100000 + i * 300, avgHighPrice: 2000, avgLowPrice: 2000, highPriceVolume: 50, lowPriceVolume: 50});
  assert.equal(estimateVolatility([...noisy, ...flatTail]), null);
});

test('marginClearsCushion: a margin below the item\'s own noise floor is blocked', () => {
  const vol = {stepVol: 0.01, windowVol: 0.02}; // this item typically wobbles ~2% of its price
  const {blocked, noiseGp} = marginClearsCushion(15, 1000, vol); // noise floor: 1000*0.02 = 20gp
  assert.equal(noiseGp, 20);
  assert.equal(blocked, true);
});

test('marginClearsCushion: a margin clearing the noise floor is kept', () => {
  const vol = {stepVol: 0.01, windowVol: 0.02};
  const {blocked, noiseGp} = marginClearsCushion(25, 1000, vol);
  assert.equal(noiseGp, 20);
  assert.equal(blocked, false);
});

test('marginClearsCushion: exactly at the noise floor counts as clearing it, not blocked', () => {
  const vol = {stepVol: 0.01, windowVol: 0.02};
  assert.equal(marginClearsCushion(20, 1000, vol).blocked, false);
});

test('marginClearsCushion: unknown volatility (null) never blocks -- missing data is never treated as risk', () => {
  const {blocked, noiseGp} = marginClearsCushion(1, 1000, null);
  assert.equal(blocked, false);
  assert.equal(noiseGp, null);
});

test('marginClearsCushion: a non-positive price or margin never blocks either', () => {
  const vol = {stepVol: 0.01, windowVol: 0.02};
  assert.equal(marginClearsCushion(15, 0, vol).blocked, false);
  assert.equal(marginClearsCushion(0, 1000, vol).blocked, false);
  assert.equal(marginClearsCushion(-5, 1000, vol).blocked, false);
});

test('marginClearsCushion: a larger cushion multiplier demands a wider margin', () => {
  const vol = {stepVol: 0.01, windowVol: 0.02}; // noise floor 20gp at 1x
  assert.equal(marginClearsCushion(35, 1000, vol, 2).blocked, true); // needs 40gp at 2x
  assert.equal(marginClearsCushion(45, 1000, vol, 2).blocked, false);
});

test('MARGIN_CUSHION_MULTIPLIER is the documented default (1x the item\'s own recent wobble)', () => {
  assert.equal(MARGIN_CUSHION_MULTIPLIER, 1);
});

// -- pickWithForecast's cushion integration (cushionFor/requireCushion) --
test('pickWithForecast: cushion disabled (requireCushion false) never calls cushionFor', async () => {
  let calls = 0;
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const result = await pickWithForecast({rank: () => candidate, cushionFor: async () => { calls++; return {blocked: true}; }, requireCushion: false, blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(calls, 0);
});

test('pickWithForecast: a "sell" suggestion is never cushion-checked either', async () => {
  let calls = 0;
  const candidate = {itemId: 1, action: 'sell', reasoning: 'base'};
  const result = await pickWithForecast({rank: () => candidate, cushionFor: async () => { calls++; return {blocked: true}; }, requireCushion: true, blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(calls, 0);
});

test('pickWithForecast: a blocked cushion retries the next-best candidate and excludes the rejected one', async () => {
  const blocklist = new Set();
  const rank = bl => bl.has(1) ? {itemId: 2, action: 'buy', reasoning: 'second pick'} : {itemId: 1, action: 'buy', reasoning: 'first pick'};
  const cushionFor = async c => c.itemId === 1 ? {blocked: true} : {blocked: false, note: 'clears it'};
  const result = await pickWithForecast({rank, cushionFor, requireCushion: true, blocklist});
  assert.equal(result.itemId, 2);
  assert.ok(blocklist.has(1), 'the rejected item must be added to the shared blocklist');
  assert.match(result.reasoning, /clears it/);
});

test('pickWithForecast: a cleared cushion folds its note into the reasoning', async () => {
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const cushionFor = async () => ({blocked: false, note: 'Margin also clears this item\'s own recent price wobble (~20 gp).'});
  const result = await pickWithForecast({rank: () => candidate, cushionFor, requireCushion: true, blocklist: new Set()});
  assert.equal(result, candidate);
  assert.match(result.reasoning, /base Margin also clears/);
});

test('pickWithForecast: a missing cushion read (network hiccup / too little history) never blocks and adds no note', async () => {
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const result = await pickWithForecast({rank: () => candidate, cushionFor: async () => null, requireCushion: true, blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(result.reasoning, 'base');
});

test('pickWithForecast: the cushion still drops candidates while the forecast only annotates them', async () => {
  const blocklist = new Set();
  const rank = bl => {
    if (bl.has(1)) return {itemId: 2, action: 'buy', reasoning: 'second pick'};
    return {itemId: 1, action: 'buy', reasoning: 'first pick'};
  };
  // Item 1: unfavourable forecast AND blocked by the cushion -> retried, on the cushion's evidence
  // alone. Item 2: same unfavourable forecast, clears the cushion -> kept, forecast noted only.
  // This is the whole shape of the change: a measured check may exclude, an unproven one may not.
  const forecastFor = async () => ({label: 'Likely falling', dir: -1, confidence: 90});
  const cushionFor = async c => c.itemId === 1 ? {blocked: true} : {blocked: false};
  const result = await pickWithForecast({rank, forecastFor, policy: 'skip', horizon: '6h', cushionFor, requireCushion: true, blocklist, maxAttempts: 5});
  assert.equal(result.itemId, 2);
  assert.ok(blocklist.has(1), 'the cushion-blocked candidate is still excluded');
  assert.match(result.reasoning, /Entry risk|Exit risk|sold within|fill/i, 'and the kept one still carries the fill warning');
});

test('pickWithForecast: cushion blocking every candidate exhausts maxAttempts and returns null', async () => {
  let attempts = 0;
  const rank = () => { attempts++; return {itemId: attempts, action: 'buy', reasoning: 'pick'}; };
  const cushionFor = async () => ({blocked: true});
  const result = await pickWithForecast({rank, cushionFor, requireCushion: true, blocklist: new Set(), maxAttempts: 3});
  assert.equal(result, null);
  assert.equal(attempts, 3);
});

// -- estimateOfferFill: a rough, volume-based estimate of how long an ALREADY-PLACED offer's
// remaining quantity typically takes to trade, for the sidebar's fill-time hint (offerFillHint on
// the plugin side). Reuses the exact same estimatedFillMinutes math and the same conservative
// liquidity=min(high,low) volume every other duration check in this file already uses -- never a
// new or different heuristic, and never anything sent back as a real prediction (see its own doc).
test('estimateOfferFill: no remaining quantity, no target duration, or no volume data at all must all return null, never a fabricated estimate', () => {
  assert.equal(estimateOfferFill(0, {highPriceVolume: 1000, lowPriceVolume: 1000}, 60), null, 'zero remaining quantity');
  assert.equal(estimateOfferFill(-5, {highPriceVolume: 1000, lowPriceVolume: 1000}, 60), null, 'negative remaining quantity');
  assert.equal(estimateOfferFill(100, {highPriceVolume: 1000, lowPriceVolume: 1000}, undefined), null, 'no target duration set');
  assert.equal(estimateOfferFill(100, {highPriceVolume: 1000, lowPriceVolume: 1000}, 0), null, 'a zero target duration');
  assert.equal(estimateOfferFill(100, undefined, 60), null, 'no volume entry for this item at all -- absence of data is never a reason to flag it');
});

test('estimateOfferFill: a fast-trading item well within the target duration is marked on pace', () => {
  // liquidity = min(1200, 1000) = 1000/hour; 100 remaining -> 6 minutes raw, x1.5 for a passive
  // offer = 9 (see PASSIVE_FILL_FACTOR, measured against real offers)
  const fill = estimateOfferFill(100, {highPriceVolume: 1200, lowPriceVolume: 1000}, 360);
  assert.deepEqual(fill, {estimatedFillMinutes: 9, likelyToFillInTime: true});
});

test('estimateOfferFill: a slow-trading item well past the target duration is flagged, with a rounded real estimate', () => {
  // liquidity = min(2000, 1000) = 1000/hour; 100000 remaining -> 6000 minutes raw, 9000 corrected
  const fill = estimateOfferFill(100000, {highPriceVolume: 2000, lowPriceVolume: 1000}, 360);
  assert.deepEqual(fill, {estimatedFillMinutes: 9000, likelyToFillInTime: false});
});

test('estimateOfferFill: exactly at the target duration counts as on pace (<=), not flagged', () => {
  // liquidity = 60/hour; 40 remaining -> 40 minutes raw, x1.5 = exactly the 60-minute target
  const fill = estimateOfferFill(40, {highPriceVolume: 60, lowPriceVolume: 60}, 60);
  assert.deepEqual(fill, {estimatedFillMinutes: 60, likelyToFillInTime: true});
});

test('estimateOfferFill: zero recent volume on either side (no real liquidity) is sent as the -1 sentinel, never Infinity or a fabricated number', () => {
  assert.deepEqual(estimateOfferFill(50, {highPriceVolume: 0, lowPriceVolume: 500}, 60), {estimatedFillMinutes: -1, likelyToFillInTime: false}, 'zero on the high side alone still means zero conservative liquidity');
  assert.deepEqual(estimateOfferFill(50, {highPriceVolume: 500, lowPriceVolume: 0}, 60), {estimatedFillMinutes: -1, likelyToFillInTime: false}, 'zero on the low side alone still means zero conservative liquidity');
});

// ---- Break-even sell price and the loss warning (warn, never block) ----
test('breakEvenSellPrice: lowest whole price whose after-tax proceeds cover the cost, hand-checked', () => {
  assert.equal(breakEvenSellPrice(1, 90), 91);            // 91 - floor(91/50)=1 -> 90; 90 - 1 -> 89 falls short
  assert.equal(breakEvenSellPrice(1, 150), 153);          // 153 - 3 = 150; 152 - 3 = 149
  assert.equal(breakEvenSellPrice(1, 49), 49);            // under 50 gp: no tax
  assert.equal(breakEvenSellPrice(1, 36.5), 37);          // a real average paid needn't be whole
  assert.equal(breakEvenSellPrice(1, 100000000), 102040816); // 102,040,816 - 2,040,816 = 100,000,000
  assert.equal(breakEvenSellPrice(1, 300000000), 305000000); // tax capped at 5m per item
  assert.equal(breakEvenSellPrice(13190, 1000), 1000);    // tax-exempt item
  for (const bad of [undefined, 0, -5, NaN]) assert.equal(breakEvenSellPrice(1, bad), null);
});

test('holding at a loss: still suggested, but flagged with the loss amount and the break-even price', () => {
  const s = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', undefined, 150);
  assert.equal(s.action, 'sell', 'a losing sell is never hidden');
  assert.equal(s.lossIfSoldNow, 1100);
  assert.equal(s.breakEvenPrice, 153);
  assert.match(s.reasoning, /^WARNING/);
  assert.match(s.reasoning, /Break-even after tax: 153 gp/);
});

test('holding at a profit: break-even is still given, no loss flagged; unknown cost gives neither', () => {
  const s = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails', undefined, 90);
  assert.equal(s.lossIfSoldNow, null);
  assert.equal(s.breakEvenPrice, 91);
  const unknown = computeHoldingSuggestion(prices(), 1, 50, 'Rune nails');
  assert.equal(unknown.breakEvenPrice, null);
  assert.equal(unknown.lossIfSoldNow, null);
});

// ---- Three gates that protect a new user from trades that cost GP or cannot happen:
// stale last-traded prices, members-only items on a free-to-play world, and the GE's 4-hour buy
// limit. All fail open: unknown data never blocks a candidate.
const FRESH = Math.floor(Date.now() / 1000);
function fresh(o = {}) {
  return {'1': {high: 130, low: 100, highTime: FRESH, lowTime: FRESH}, '2': {high: 130, low: 100, highTime: FRESH, lowTime: FRESH}, ...o};
}

test('priceAgeMinutes reports the staler side, and nothing when timestamps are missing', () => {
  const now = 1758000000000, s = now / 1000;
  assert.equal(priceAgeMinutes({highTime: s - 600, lowTime: s - 120}, now), 10);
  assert.equal(priceAgeMinutes({highTime: s, lowTime: s}, now), 0);
  assert.equal(priceAgeMinutes({highTime: s}, now), null, 'one side only is not enough to judge');
  assert.equal(priceAgeMinutes({}, now), null);
  assert.equal(priceAgeMinutes(undefined, now), null);
});

test('market: a spread nobody has traded recently is dropped, fresh prices are kept, unknown timestamps fail open', () => {
  const stale = {'1': {high: 30000, low: 6400, highTime: FRESH - 7 * 3600, lowTime: FRESH - 9 * 3600}};
  assert.equal(computeMarketSuggestion(mapping(), stale, volumes(), {blocklist: new Set([2])}), null,
    'a 7-9 hour old "free GP" spread must not be suggested');
  assert.equal(computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2])}).itemId, 1);
  assert.equal(computeMarketSuggestion(mapping(), prices(), volumes(), {blocklist: new Set([2])}).itemId, 1,
    'no timestamps at all must not block anything');
  const justInside = {'1': {high: 130, low: 100, highTime: FRESH - (MAX_PRICE_AGE_MINUTES - 5) * 60, lowTime: FRESH}};
  assert.equal(computeMarketSuggestion(mapping(), justInside, volumes(), {blocklist: new Set([2])}).itemId, 1);
});

const proven = () => [flip(), flip({quantity: 200})]; // median quantity 150, 28 gp net per unit

test('personal history: a stale price is noted, never a reason to withhold your own proven flip', () => {
  const stale = {'1': {high: 130, low: 100, highTime: FRESH - 5 * 3600, lowTime: FRESH - 5 * 3600}};
  const s = computeSuggestion(proven(), stale, Date.now());
  assert.equal(s.itemId, 1);
  assert.match(s.reasoning, /5 hour\(s\) old/);
  assert.doesNotMatch(computeSuggestion(proven(), fresh(), Date.now()).reasoning, /hour\(s\) old/);
});

test('members-only items are not suggested on a free-to-play world, in any tier', () => {
  const membersBlocked = id => id === 1;
  assert.equal(computeMarketSuggestion(mapping(), fresh(), volumes(), {membersBlocked, blocklist: new Set([2])}), null);
  assert.equal(computeMarketSuggestion(mapping(), fresh(), volumes(), {membersBlocked}).itemId, 2, 'a free-to-play item is still fine');
  assert.equal(computeSuggestion(proven(), fresh(), Date.now(), {membersBlocked}), null);
  assert.equal(computePushedSuggestion([{itemId: 1, name: 'Members item', buy: 100, sell: 130, net: 28, qty: 5, score: 9}], {membersBlocked}), null);
  const inv = computeInventorySuggestion(fresh(), {1: 5000}, mapping(), {membersBlocked});
  assert.equal(inv, null, 'a members item cannot be sold there either');
});

test('buy limit: quantity is reduced to what is left of the 4-hour limit, and an exhausted limit is skipped', () => {
  const limitFor = id => id === 1 ? {limit: 10000, remaining: 250} : null;
  const m = computeMarketSuggestion(mapping(), fresh(), volumes(), {limitFor, blocklist: new Set([2]), maxVolumeShare: 0});
  assert.equal(m.quantity, 250);
  // The wording changed with the sizing: this is one window's remainder, which is what can actually be
  // placed, rather than the whole allowance across every window a long trade spans.
  assert.match(m.reasoning, /all that can fill before the limit resets in 4 hours/);
  const tighter = id => id === 1 ? {limit: 10000, remaining: 100} : null; // below the usual size of 150
  const p = computeSuggestion(proven(), fresh(), Date.now(), {limitFor: tighter});
  assert.equal(p.quantity, 100);
  assert.match(p.reasoning, /all that can fill before the limit resets in 4 hours/);
  const used = id => ({limit: 10000, remaining: 0});
  assert.equal(computeMarketSuggestion(mapping(), fresh(), volumes(), {limitFor: used, blocklist: new Set([2]), maxVolumeShare: 0}), null);
  assert.equal(computeSuggestion(proven(), fresh(), Date.now(), {limitFor: used}), null);
  assert.equal(computePushedSuggestion([{itemId: 1, name: 'x', buy: 100, sell: 130, net: 28, qty: 5000, score: 9}], {limitFor}).quantity, 250);
  assert.equal(computeMarketSuggestion(mapping(), fresh(), volumes(), {limitFor: () => null, blocklist: new Set([2]), maxVolumeShare: 0}).quantity, 10000,
    'an unknown limit must not constrain anything');
});

// -- maxStackShare: how much of the cash stack one market-wide suggestion may commit. Added after a
// 90-day backtest found uncapped sizing, not item choice, was what turned this tier into a loss. --

test('market: maxStackShare caps one trade to a share of the cash stack, and says so', () => {
  const s = computeMarketSuggestion(mapping(), fresh(), volumes(), {maxSpend: 1000000, maxStackShare: 0.25, blocklist: new Set([2]), maxVolumeShare: 0});
  assert.equal(s.quantity, 2500, 'floor(1,000,000 * 0.25 / 100 gp per unit)');
  assert.match(s.reasoning, /at most 25% of your cash stack/);
});

test('market: an item too expensive to buy even one unit within the share is skipped, not shrunk to one', () => {
  const pricey = fresh({'3': {high: 900000, low: 800000, highTime: FRESH, lowTime: FRESH}});
  const items = mapping([{id: 3, name: 'Expensive thing', limit: 8}]);
  const vols = volumes({'3': {highPriceVolume: 50, lowPriceVolume: 50}});
  // 25% of a 1m stack is 250k, less than one 800k unit.
  const s = computeMarketSuggestion(items, pricey, vols, {maxSpend: 1000000, maxStackShare: 0.25, blocklist: new Set([1, 2])});
  assert.equal(s, null);
  // Without the cap the same stack affords one unit.
  assert.equal(computeMarketSuggestion(items, pricey, vols, {maxSpend: 1000000, blocklist: new Set([1, 2])}).quantity, 1);
});

test('market: no maxStackShare leaves sizing exactly as before', () => {
  const capped = computeMarketSuggestion(mapping(), fresh(), volumes(), {maxSpend: 1000000, maxStackShare: 0.25, blocklist: new Set([2]), maxVolumeShare: 0});
  const uncapped = computeMarketSuggestion(mapping(), fresh(), volumes(), {maxSpend: 1000000, blocklist: new Set([2]), maxVolumeShare: 0});
  assert.equal(uncapped.quantity, 10000);
  assert.ok(capped.quantity < uncapped.quantity);
  assert.doesNotMatch(uncapped.reasoning, /of your cash stack/);
});

test('market: maxVolumeShare caps a trade to a share of a typical hour of trading', () => {
  // 500/hour on the thin side, 5% = 25 units.
  const s = computeMarketSuggestion(mapping(), fresh(), volumes(), {maxVolumeShare: 0.05, blocklist: new Set([2])});
  assert.equal(s.quantity, 25);
  assert.match(s.reasoning, /5% of what this item trades in a typical hour/);
});

// -- taxFreeOnly / the Starter profile: market-wide picks restricted to items the GE charges no tax
// on. Backtested as a large improvement in completion and risk for a small stack. --

test('market: taxFreeOnly keeps only items the GE charges no tax on', () => {
  // Item 1 (130 gp) is taxed; item 3 priced under 50 gp is not, and 1755 is on the exemption list.
  const items = mapping([{id: 3, name: 'Cheap bulk item', limit: 10000}, {id: 1755, name: 'Chef\'s hat', limit: 100}]);
  // Item 1 has the best margin (28 after tax), so it wins on merit until the filter excludes it.
  const p = prices({'3': {high: 40, low: 30, highTime: FRESH, lowTime: FRESH}, '1755': {high: 105, low: 100, highTime: FRESH, lowTime: FRESH}});
  const vols = volumes({'3': {highPriceVolume: 5000, lowPriceVolume: 5000}, '1755': {highPriceVolume: 500, lowPriceVolume: 500}});
  const taxed = computeMarketSuggestion(items, p, vols, {maxVolumeShare: 0});
  assert.equal(taxed.itemId, 1, 'without the filter the taxed item still wins on margin');
  const free = computeMarketSuggestion(items, p, vols, {taxFreeOnly: true, maxVolumeShare: 0});
  assert.ok(free.itemId === 3 || free.itemId === 1755, 'with it, only untaxed items remain: ' + free.itemId);
  const onlyTaxed = computeMarketSuggestion(mapping(), prices(), volumes(), {taxFreeOnly: true, maxVolumeShare: 0});
  assert.equal(onlyTaxed, null, 'when every candidate is taxed, nothing is suggested rather than something taxed');
});

test('market: minHourlyVolume raises the liquidity floor without touching the default', () => {
  const thin = volumes({'1': {highPriceVolume: 50, lowPriceVolume: 50}});
  assert.equal(computeMarketSuggestion(mapping(), fresh(), thin, {blocklist: new Set([2]), maxVolumeShare: 0}).itemId, 1);
  assert.equal(computeMarketSuggestion(mapping(), fresh(), thin, {blocklist: new Set([2]), minHourlyVolume: 100, maxVolumeShare: 0}), null);
});

test('market: the default volume-share cap is applied unless a caller opts out', () => {
  // volumes() is 500/hour, so the 10% default allows 50 units of Rune nails' 10,000 limit.
  const capped = computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2])});
  assert.equal(capped.quantity, 50);
  assert.match(capped.reasoning, /10% of what this item trades in a typical hour/);
  assert.equal(computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2]), maxVolumeShare: 0}).quantity, 10000);
});

// Measured in tools/fill-by-size.mjs over 427 of this account's own offers: with a cancellation
// treated as "stopped watching" rather than a failure, an order up to half an item's hourly volume
// filled about as often within 12 hours (70-82%) as a small one (82%), while anything past that fell
// away (49% at 50-100%, 25% past 200%). At 6 hours the larger sizes were already worse, and at 1 hour
// only the smallest held up -- hence steps rather than one flat 10%.
test("sizing: how much of an hour's trading one order may be depends on how long the player will wait", () => {
  assert.equal(volumeShareForDuration(undefined), 0.10, 'no duration set: unchanged from before');
  assert.equal(volumeShareForDuration(30), 0.10);
  assert.equal(volumeShareForDuration(5 * 60), 0.10, 'under six hours keeps the tight cap');
  assert.equal(volumeShareForDuration(6 * 60), 0.25);
  assert.equal(volumeShareForDuration(12 * 60), 1.00, 'raised 28 Sept 2026 on two measurements that agree');
  assert.equal(volumeShareForDuration(0), 0.10);

  // Past twelve hours it now continues instead of stopping. It used to return 0.50 for any longer
  // duration, with the note "never past half an hour's volume on this evidence" -- but the ladder had
  // simply never been extended when TradePace added Overnight and Slow on 26 Sept. On the Slow pace
  // that left the market-wide tier with nothing to suggest at all against a 1m minimum, since every
  // liquid item was sized to a handful of units. 0.25 at six hours and 0.50 at twelve are both exactly
  // hours/24, so this is the same rule continued, not a new one.
  // The ladder climbs at twice the old rate and STOPS at 2x an hour's volume. Changed 28 Sept 2026:
  // the old rule came from fill-by-size.mjs, whose finding was narrower than it read -- orders up to
  // half an hour's volume filled as often as small ones, and there was almost nothing above that line
  // to judge, because 52 of the 61 largest orders were cancelled within minutes. An observation
  // ceiling, not a measured cliff. tools/copilot-fill-sizes.mjs supplied the missing half from 392 of
  // this account's own COMPLETED Copilot flips, 59% of which were larger than the old cap allowed:
  // median profit runs 34,510 at or under 0.5x and 122,167 from 0.5x to 2x, then flattens while hold
  // time keeps climbing. tools/market-tier-ranking.mjs agreed on outcomes rather than survivors --
  // at twelve hours the wider cap held the median return at 5.56% and raised total profit 33%, while
  // doubling again was clearly worse, and widening the already-2x two-day pace took the loss rate
  // from 8% to 14%. So 2x is where the evidence stops and the cap stops there too.
  assert.equal(volumeShareForDuration(24 * 60), 2.00, 'a full day reaches the ceiling');
  assert.equal(volumeShareForDuration(48 * 60), 2.00, "Slow's two days, unchanged from before");
  assert.equal(volumeShareForDuration(30 * 24 * 60), 2.00, 'and never past it, however long the wait');
  // Everything at or below twelve hours is untouched: making a short trade more permissive would be
  // extrapolating the risky way with nothing behind it.
  assert.equal(volumeShareForDuration(11 * 60), 0.25);
  assert.equal(volumeShareForDuration(7 * 60), 0.25);
  assert.equal(volumeShareForDuration(2 * 60), 0.10);
});

test('sizing: a twelve-hour trade may be ten times the order a one-hour trade may be', () => {
  // volumes() is 500/hour. 10% = 50 units; 100% = 500 since 28 Sept 2026 (was 50% = 250).
  const short = computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2]), targetDurationMinutes: 60});
  const long = computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2]), targetDurationMinutes: 12 * 60});
  assert.equal(short.quantity, 50);
  assert.equal(long.quantity, 500);
  assert.match(long.reasoning, /100% of what this item trades in a typical hour[^.]*over your 12-hour trade window/);
  assert.match(short.reasoning, /10% of what this item trades in a typical hour/);
  assert.doesNotMatch(short.reasoning, /trade window/, 'the unchanged 10% cap says nothing new');
  // The player's own history is sized the same way.
  const vols = volumes({'1': {highPriceVolume: 300, lowPriceVolume: 300}});
  assert.equal(computeSuggestion([flip(), flip({quantity: 200})], fresh(), Date.now(), {volumes: vols, targetDurationMinutes: 12 * 60}).quantity, 150,
    'half of 300 is 150, which is the usual size here, so nothing is capped');
  assert.equal(computeSuggestion([flip(), flip({quantity: 200})], fresh(), Date.now(), {volumes: vols}).quantity, 30, 'with no duration set, the old 10% still applies');
  // An explicit override still turns the share cap off entirely; what is left is the fill-time
  // estimate for that same window, which is a different cap with its own wording.
  const off = computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2]), targetDurationMinutes: 12 * 60, maxVolumeShare: 0});
  assert.ok(off.quantity > 250, 'no share cap left: ' + off.quantity);
  assert.doesNotMatch(off.reasoning, /hourly trading/);
});

test('personal history: maxStackShare caps a proven flip the same way, and drops what one unit would overcommit', () => {
  const capped = computeSuggestion(proven(), fresh(), Date.now(), {maxSpend: 1000000, maxStackShare: 0.25});
  assert.equal(capped.quantity, 150, 'the usual size already fits inside a quarter of the stack');
  const tight = computeSuggestion(proven(), fresh(), Date.now(), {maxSpend: 40000, maxStackShare: 0.25});
  assert.equal(tight.quantity, 100, 'floor(40,000 * 0.25 / 100 gp)');
  assert.match(tight.reasoning, /at most 25% of your cash stack/);
  assert.equal(computeSuggestion(proven(), fresh(), Date.now(), {maxSpend: 300, maxStackShare: 0.25}), null,
    'one unit would commit more than the allowed share, so the candidate is skipped');
});

test('personal history: the volume-share cap applies here too, so a proven item is not over-ordered', () => {
  const flips = [flip(), flip({quantity: 200})]; // usual size 150
  const vols = volumes({'1': {highPriceVolume: 300, lowPriceVolume: 300}}); // 10% of 300 = 30
  const s = computeSuggestion(flips, fresh(), Date.now(), {volumes: vols});
  assert.equal(s.quantity, 30);
  assert.match(s.reasoning, /10% of what this item trades in a typical hour/);
  // Opting out restores the old sizing, and no volume data at all never constrains anything.
  assert.equal(computeSuggestion(flips, fresh(), Date.now(), {volumes: vols, maxVolumeShare: 0}).quantity, 150);
  assert.equal(computeSuggestion(flips, fresh(), Date.now(), {}).quantity, 150);
});


// --- Grand Exchange slot capacity (8 offers, no more) ---

// The sell-side reserve, and the bug the user found with it from the live client: suggestions
// stopped at FOUR slots out of eight. The original reasoning counted every in-progress buy as owing
// an exit slot, but a buy vacates its own slot when collected and the sell goes straight into it --
// so four buys reserved four more slots they would never need.
test('slot exposure: buys in progress owe no extra slot, so all eight can be used', () => {
  const buying = [1, 2, 3, 4, 5, 6, 7].map(itemId => ({itemId, state: 'BUYING', account: 'a'}));
  const e = slotExposure([], buying, 'a');
  assert.equal(e.sellSlotsOwed, 0, 'a buy brings its own slot for its sell -- this is the four-slot bug');
  assert.equal(e.exposure.size, 7, 'but every one of them is still exposure, for the correlation check');
});

test('slot exposure: a finished buy not yet collected still holds its own slot for the sell', () => {
  const e = slotExposure([{itemId: 9, account: 'a'}], [{itemId: 9, state: 'BOUGHT', account: 'a'}], 'a');
  assert.equal(e.sellSlotsOwed, 0, 'collecting it frees exactly the slot the sell will use');
  assert.ok(e.exposure.has(9));
});

test('slot exposure: only stock with no slot at all owes one', () => {
  // Bought, collected, left in the inventory: nothing to reuse, so a sell genuinely needs a free slot.
  const positions = [{itemId: 1, account: 'a'}, {itemId: 2, account: 'a'}, {itemId: 3, account: 'a'}];
  const occupied = [{itemId: 3, state: 'SELLING', account: 'a'}, {itemId: 8, state: 'BUYING', account: 'a'}];
  const e = slotExposure(positions, occupied, 'a');
  assert.deepEqual(e.owedItems.sort(), [1, 2], 'item 3 already has its sell standing; items 1 and 2 have nowhere to go');
  assert.equal(e.sellSlotsOwed, 2);
  assert.deepEqual([...e.exposure].sort(), [1, 2, 3, 8]);
});

test('slot exposure: another account is never counted, and nothing known owes nothing', () => {
  const e = slotExposure([{itemId: 1, account: 'other'}], [{itemId: 2, state: 'BUYING', account: 'other'}], 'a');
  assert.equal(e.sellSlotsOwed, 0);
  assert.equal(e.exposure.size, 0);
  assert.equal(slotExposure(null, null, 'a').sellSlotsOwed, 0, 'missing data reserves nothing -- fail open');
});

// Reported from the live client, and it cost GP: holding an Eclipse Moon chestplate (broken) bought
// at 595,350, the offer prompt offered to sell at the market's 595,350 with no warning -- because the
// plain open-item price never knew what the player paid. Selling there lost exactly the tax.
test('open item price: warns with the break-even when selling a held item would lose GP', () => {
  const plain = {itemId: 29049, buyPrice: 595350, sellPrice: 595350};
  const warned = withCostBasis(plain, 595350, 1);
  assert.equal(warned.action, 'sell', 'marked as a sale of held stock, which is what lets the prompt warn');
  assert.equal(warned.breakEvenPrice, 607499, 'the same break-even the sidebar computed for this exact trade');
  assert.equal(warned.lossIfSoldNow, 11907, 'exactly the tax -- the loss the player actually took');
  assert.equal(warned.sellPrice, 595350, 'a warning, never a block: the price itself is unchanged');
  // Same arithmetic as the sidebar's holding reminder, so the two can never disagree.
  const sidebar = computeHoldingSuggestion({'29049': {high: 595350, low: 590000}}, 29049, 1, 'Eclipse Moon chestplate (broken)', undefined, 595350);
  assert.equal(warned.breakEvenPrice, sidebar.breakEvenPrice);
  assert.equal(warned.lossIfSoldNow, sidebar.lossIfSoldNow);
});

// Asked for by the user: collecting 2,200 of a 12,001 diamond dragon bolt order while the rest keeps
// filling. The FIFO journal only admits a purchase once the offer finishes, so the prompt had no idea
// what those collected bolts cost.
test('held cost: a buy order still running counts, at what has actually been paid so far', () => {
  const running = {itemId: 9244, account: 'a', state: 'BUYING', filled: 2200, spent: 2200 * 1500, total: 12001};
  const basis = heldCostBasis([], [running], 9244, 'a');
  assert.equal(basis.unitCost, 1500, 'the average price actually paid on the open order');
  assert.equal(basis.quantity, 2200);
  // End to end with the prompt's warning: selling below that price now warns.
  const warned = withCostBasis({itemId: 9244, buyPrice: 1450, sellPrice: 1480}, basis.unitCost, basis.quantity);
  assert.ok(warned.lossIfSoldNow > 0, 'selling below what was paid on a still-running order must warn');
  assert.ok(warned.breakEvenPrice > 1500);
});

test('held cost: finished lots and a running order average together, never double counted', () => {
  const lot = {itemId: 9244, account: 'a', unitCost: 1400, remaining: 1000};
  const running = {itemId: 9244, account: 'a', state: 'BUYING', filled: 1000, spent: 1000 * 1600};
  const basis = heldCostBasis([lot], [running], 9244, 'a');
  assert.equal(basis.quantity, 2000);
  assert.equal(basis.unitCost, 1500, 'each unit at its own price, averaged over everything held');
});

test('held cost: only buys that filled, only this item and account, and nothing known means null', () => {
  const offers = [
    {itemId: 9244, account: 'a', state: 'BUYING', filled: 0, spent: 0},          // nothing bought yet
    {itemId: 9244, account: 'a', state: 'SELLING', filled: 50, spent: 80000},     // a sale, not a cost
    {itemId: 9244, account: 'b', state: 'BUYING', filled: 10, spent: 15000},      // another account
    {itemId: 4151, account: 'a', state: 'BUYING', filled: 1, spent: 1500000},     // another item
  ];
  assert.equal(heldCostBasis([], offers, 9244, 'a'), null, 'no price ever guessed from offers that bought nothing here');
  assert.equal(heldCostBasis(null, null, 9244, 'a'), null);
});

test('open item price: a profitable sale carries its break-even and no loss', () => {
  const r = withCostBasis({itemId: 29049, buyPrice: 595350, sellPrice: 618004}, 595350, 1);
  assert.equal(r.lossIfSoldNow, null);
  assert.equal(r.breakEvenPrice, 607499);
});

test('open item price: an unknown cost leaves the price exactly as it was', () => {
  const plain = {itemId: 29049, buyPrice: 595350, sellPrice: 595350};
  for (const cost of [null, undefined, 0, -5, NaN]) assert.equal(withCostBasis(plain, cost), plain, `cost ${cost} must never be guessed`);
  assert.equal(withCostBasis(null, 595350), null);
  // Loss scales with what is actually held.
  assert.equal(withCostBasis(plain, 595350, 3).lossIfSoldNow, 11907 * 3);
});

// The chestplate loss, root cause: EVI said buy at 595,350 / sell at 618,004, but over the previous 12
// hours 48 buyers had paid an average of 587,104. The margin existed only at one outlier trade.
const HOUR_S = 3600;
const nowMs = Date.UTC(2026, 8, 18, 12, 47);
const endS = Math.floor(nowMs / 3600000) * 3600;
const series = pts => pts.map(([hoursAgo, price, vol]) => ({timestamp: endS - hoursAgo * HOUR_S, avgHighPrice: price, highPriceVolume: vol}));

test('sell support: a margin that exists only at one outlier print is flagged, with the real price', () => {
  // 48 buyers across the window averaging 587,104 -- below even the suggested buy price.
  const s = sellPriceSupport(series([[12, 587104, 24], [8, 587104, 24]]), 29049, 595350, {nowMs});
  assert.equal(s.supported, false);
  assert.equal(s.units, 48);
  assert.equal(Math.round(s.averagePaid), 587104);
  assert.ok(s.netAtAverage < 0, 'at what buyers actually pay, this flip loses');
  const note = sellSupportNote(s, 618004);
  assert.match(note, /618,004/);
  assert.match(note, /48 buyers paid an average of 587,104/);
  assert.match(note, /loses about/);
});

test('sell support: a margin that holds at what buyers really pay says nothing', () => {
  const s = sellPriceSupport(series([[6, 640000, 30], [2, 645000, 30]]), 29049, 595350, {nowMs});
  assert.equal(s.supported, true);
  assert.equal(sellSupportNote(s, 650000), null, 'no warning when the trade stands up -- noise gets ignored');
});

test('sell support: nobody buying at all over the window is its own warning', () => {
  const s = sellPriceSupport(series([[30, 600000, 5]]), 29049, 595350, {nowMs});   // only data 30h ago
  assert.equal(s.units, 0, 'trades outside the 12-hour window do not count');
  assert.match(sellSupportNote(s, 618004), /nobody bought this item at all in the last 12 hours/);
});

test('sell support: no series is no view, never a guess', () => {
  assert.equal(sellPriceSupport(null, 29049, 595350), null);
  assert.equal(sellPriceSupport([], 29049, 595350), null);
  assert.equal(sellPriceSupport(series([[3, 600000, 5]]), 29049, 0), null, 'no buy price, nothing to compare');
  assert.equal(sellSupportNote(null, 618004), null);
  // Hours with no buyers or no price are skipped, not averaged in as zeros.
  const s = sellPriceSupport(series([[4, null, 0], [3, 640000, 10], [2, 0, 5]]), 29049, 595350, {nowMs});
  assert.equal(s.units, 10);
  assert.equal(Math.round(s.averagePaid), 640000);
});

// Reported live: EVI's top personal picks included a Mummy's head whose sell price was 58.6 hours old
// and nobody had bought for 12 hours. A warning alone left it ranked first, so a failing pick is now
// demoted below the next candidates -- never hidden.
const stalePick = id => ({itemId: id, action: 'buy', reasoning: `pick ${id}`});
const supportFails = ids => async c => ids.includes(c.itemId) ? {warning: `Warning: item ${c.itemId} rests on very few trades.`, detail: {units: 0}} : null;

test('demotion: a pick failing the buyer check makes way for the next one that passes', async () => {
  const blocklist = new Set();
  const rank = bl => [1, 2, 3].filter(id => !bl.has(id)).map(stalePick)[0] || null;
  const result = await pickWithForecast({rank, supportFor: supportFails([1]), blocklist, policy: 'warn', horizon: null});
  assert.equal(result.itemId, 2, 'the stale top pick loses its place to the next candidate that holds up');
  assert.ok(!result.demoted);
  assert.ok(!/Warning/.test(result.reasoning), 'and the one shown carries no warning, because it passed');
});

test('demotion: a pick pushed down is reported even when a better one replaces it, so it can be logged', async () => {
  const seen = [];
  const rank = bl => [1, 2, 3].filter(id => !bl.has(id)).map(stalePick)[0] || null;
  const result = await pickWithForecast({rank, supportFor: supportFails([1]), blocklist: new Set(), policy: 'warn', horizon: null,
    onDemoted: c => seen.push(c.itemId)});
  assert.equal(result.itemId, 2);
  assert.deepEqual(seen, [1], 'otherwise the check is invisible exactly when it works');
});

test('demotion: when nothing passes, the best demoted pick is still shown, warned and explained', async () => {
  const rank = bl => [1, 2, 3].filter(id => !bl.has(id)).map(stalePick)[0] || null;
  const result = await pickWithForecast({rank, supportFor: supportFails([1, 2, 3]), blocklist: new Set(), policy: 'warn', horizon: null});
  assert.equal(result.itemId, 1, 'never left with nothing because of this check -- the best-ranked comes back');
  assert.equal(result.demoted, true);
  assert.match(result.reasoning, /^Warning: item 1/, 'the warning leads the reasoning');
  assert.match(result.reasoning, /No other candidate passed this check right now/);
});

test('demotion: no reading means no demotion, and a sell is never checked', async () => {
  const pick = stalePick(1);
  const noView = await pickWithForecast({rank: () => pick, supportFor: async () => null, blocklist: new Set(), policy: 'warn', horizon: null});
  assert.equal(noView, pick, 'a failed fetch or missing history demotes nothing -- fail open');
  let checked = 0;
  const sell = {itemId: 9, action: 'sell', reasoning: 'holding'};
  const r = await pickWithForecast({rank: () => sell, supportFor: async () => { checked++; return {warning: 'x'}; }, blocklist: new Set(), policy: 'warn', horizon: null});
  assert.equal(r, sell);
  assert.equal(checked, 0, 'this checks buys only: a sell reminder has nothing left to buy');
});

test('volume reading: a measured zero constrains sizing, a missing reading does not', () => {
  // Listed with 0 bought and 1 sold: exactly what the bridge saw for the chestplate at 12:47.
  assert.equal(volumeReadingFor({'29049': {highPriceVolume: 0, lowPriceVolume: 1}}, 29049), 0);
  assert.equal(volumeReadingFor({'4151': {highPriceVolume: 90, lowPriceVolume: 80}}, 29049), null, 'absent stays unknown for sizing');
  assert.equal(volumeReadingFor(undefined, 29049), null);
  // End to end through the real ranking: the chestplate is now sized to 1, not 3.
  const flips = [flip({itemId: 29049, item: 'Eclipse Moon chestplate (broken)', quantity: 3, capital: 1645365, netProceeds: 3424356, profit: 1778991})];
  const prices = {'29049': {high: 618004, low: 595350, highTime: nowMs / 1000 - 120, lowTime: nowMs / 1000 - 60}};
  const s = computeSuggestion(flips, prices, nowMs, {volumes: {'29049': {highPriceVolume: 0, lowPriceVolume: 1}}, maxSpend: 50_000_000});
  assert.equal(s.quantity, 1, 'zero buyers in the last hour is a reading, and it caps the size');
});

test('slot capacity: a free slot means no constraint at all', () => {
  const c = slotCapacity('3', '1');
  assert.deepEqual(c, {free: 3, collectable: 1, full: false, tight: false});
  assert.equal(slotNote(c), null);
});

test('slot capacity: all eight in use with nothing collectable is full', () => {
  const c = slotCapacity('0', '0');
  assert.equal(c.full, true);
  assert.equal(c.tight, false);
  // Nothing to append: the caller stops ranking entirely and says so on its own.
  assert.equal(slotNote(c), null);
});

test('slot capacity: all eight in use but something finished is tight, not full', () => {
  const c = slotCapacity('0', '2');
  assert.equal(c.full, false, 'collecting is one click -- a real suggestion must not be suppressed over it');
  assert.equal(c.tight, true);
  assert.match(slotNote(c), /2 finished offers can be collected/);
  assert.match(slotNote(slotCapacity('0', '1')), /1 finished offer can be collected/);
});

test('slot capacity: an unknown count never invents a constraint', () => {
  for (const [free, collectable] of [[null, null], [undefined, undefined], ['', ''], ['x', '2'], ['-1', '0'], ['9', '0']]) {
    const c = slotCapacity(free, collectable);
    assert.equal(c.full, false, `${free}/${collectable} must not read as a full Grand Exchange`);
  }
  // Slots known full, finished count unknown: still not suppressed, but the note says why.
  const partial = slotCapacity('0', null);
  assert.equal(partial.full, false);
  assert.equal(partial.tight, true);
  assert.match(slotNote(partial), /collect or cancel an offer/);
  assert.equal(GE_SLOTS, 8);
});
// Measured 19 Sep 2026: the Wiki's per-item series still lacked the newest complete hour at ten past
// the next one, while the archive had it -- so the live check often saw 11 of its 12 hours.
test('sell support: the archive fills the hour the Wiki series has not published yet', () => {
  const H = Date.UTC(2026, 8, 19, 3) / 1000, nowMs = (H + 600) * 1000;
  const series = Array.from({length: 11}, (_, i) => ({timestamp: H - (12 - i) * 3600, avgHighPrice: 615000, highPriceVolume: 2}));
  const newest = {ts: H - 3600, d: {'29049': [580000, 40, 570000, 30]}};
  const merged = mergeArchiveHours(series, [newest, {ts: H - 7200, d: {}}], 29049);
  assert.equal(merged.length, 12, 'the missing hour is added; an hour the item did not trade in adds nothing');
  assert.deepEqual(merged.at(-1), {timestamp: H - 3600, avgHighPrice: 580000, highPriceVolume: 40, avgLowPrice: 570000, lowPriceVolume: 30});
  const without = sellPriceSupport(series, 29049, 595350, {nowMs});
  const withIt = sellPriceSupport(merged, 29049, 595350, {nowMs});
  assert.equal(without.units, 22);
  assert.equal(withIt.units, 62, 'the busiest hour was the one being missed');
  assert.equal(without.supported, true);
  assert.equal(withIt.supported, false, 'and here it changes the call');
  assert.deepEqual(mergeArchiveHours(null, null, 1), [], 'nothing in, nothing out');
});


// The buy limit resets four hours after the first purchase of a window (the OSRS Wiki's own wording),
// so a 12-hour trade spans three windows -- capping every order at one limit left two thirds of a long
// trade's allowance unused on exactly the bulk items where the limit binds.
test('buy limit: a trade window spanning several resets allows one limit per window that opens in time', () => {
  const H = 3600000, now = Date.UTC(2026, 8, 21, 12);
  assert.equal(limitAllowance({limit: 11000, targetDurationMinutes: undefined, now}), 11000, 'no duration: one window, as before');
  assert.equal(limitAllowance({limit: 11000, targetDurationMinutes: 60, now}), 11000, 'an hour is inside one window');
  assert.equal(limitAllowance({limit: 11000, targetDurationMinutes: 12 * 60, now}), 33000, 'windows open at 0, 4h and 8h: three limits');
  assert.equal(limitAllowance({limit: 11000, targetDurationMinutes: 10 * 60, now}), 33000, 'the third window opens at 8h, inside 10h');
  assert.equal(limitAllowance({limit: 11000, targetDurationMinutes: 8 * 60, now}), 22000, 'a window opening exactly at the deadline adds nothing');
  assert.equal(limitAllowance({limit: 11000, targetDurationMinutes: 24 * 60, now}), 66000);
  // Part of the current window already used, resetting in an hour: what is left now, plus the windows
  // opening at 1h, 5h and 9h inside a 12-hour trade.
  assert.equal(limitAllowance({limit: 11000, used: 8000, windowEndsAt: now + H, targetDurationMinutes: 12 * 60, now}), 3000 + 3 * 11000);
  // Used up, resetting in three hours, on a two-hour trade: nothing more is buyable in time.
  assert.equal(limitAllowance({limit: 11000, used: 11000, windowEndsAt: now + 3 * H, targetDurationMinutes: 120, now}), 0);
  assert.equal(limitAllowance({limit: 0, targetDurationMinutes: 720, now}), null, 'unknown limit: no constraint invented');
});

test('buy limit: the market tier starts a long trade from the whole allowance, and the volume cap still binds', () => {
  // volumes() is 500/hour; at 12 hours the volume cap is 100% since 28 Sept 2026 (it was 50%), so
  // 500 -- still far below three limits of 10,000, which is the point of the test.
  const long = computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2]), targetDurationMinutes: 12 * 60});
  assert.equal(long.quantity, 500, 'the market, not the limit, is what binds here');
  // With the volume cap switched off, the allowance itself shows through.
  const uncapped = computeMarketSuggestion(mapping(), fresh(), volumes({'1': {highPriceVolume: 1e7, lowPriceVolume: 1e7}}),
    {blocklist: new Set([2]), targetDurationMinutes: 12 * 60, maxVolumeShare: 0});
  assert.equal(uncapped.quantity, 30000, 'three windows of the 10,000 limit');
});


// Opt-in focus on items bought by the thousand. The user found the market for gear crowded; consumables
// and ammunition carry buy limits of 2,000-18,000, gear 4-125, so the limit draws the line.
test('bulk focus: only items the GE sells by the thousand are suggested, and it is off unless asked for', () => {
  const items = mapping([{id: 3, name: 'Steel cannonball', limit: 11000}]);
  const all = computeMarketSuggestion(items, fresh(), volumes(), {maxVolumeShare: 0});
  const bulkOnly = id => !(items.find(m => m.id === id)?.limit >= BULK_MIN_LIMIT);
  const bulk = computeMarketSuggestion(items, fresh(), volumes(), {maxVolumeShare: 0, focusBlocked: bulkOnly});
  assert.ok(all, 'without the focus, anything eligible can be suggested');
  if (bulk) assert.ok(items.find(m => m.id === bulk.itemId).limit >= BULK_MIN_LIMIT, 'with it, never an item with a small limit');
  // The personal tier obeys it too: a proven item with a small limit is not offered under the focus.
  const personal = computeSuggestion(proven(), fresh(), Date.now(), {focusBlocked: () => true});
  assert.equal(personal, null, 'nothing passes when every item is outside the focus');
  assert.equal(BULK_MIN_LIMIT, 1000);
});


test("focus: gear and bulk split by the item's own buy limit, and an unknown limit fits neither", () => {
  assert.equal(focusAllows('any', undefined), true);
  assert.equal(focusAllows('bulk', 11000), true, 'Steel cannonball');
  assert.equal(focusAllows('bulk', 8), false, 'Spiked manacles');
  assert.equal(focusAllows('gear', 8), true, 'Spiked manacles');
  assert.equal(focusAllows('gear', 11000), false);
  assert.equal(focusAllows('gear', undefined), false, 'cannot be shown to be gear');
  assert.equal(focusAllows('bulk', undefined), false, 'cannot be shown to be bulk');
  assert.deepEqual(FOCUSES, ['any', 'bulk', 'gear']);
});


test("focus: the plugin's own setting wins for its request, and 'same as scanner' defers to the stored switch", () => {
  assert.equal(resolveFocus('gear', 'bulk'), 'gear', 'the plugin named one');
  assert.equal(resolveFocus(null, 'bulk'), 'bulk', "the plugin sent nothing: the scanner's switch applies");
  assert.equal(resolveFocus('nonsense', 'bulk'), 'bulk', 'an unknown value is ignored, not adopted');
  assert.equal(resolveFocus(null, undefined), 'any');
});

// -- Skipping positions that are already listed. Found on novi's own bridge, 29 Sept 2026: the
// picker returned the OLDEST open position and the caller then silenced it for being on the market,
// but stopped there -- so a Cannon base listed since 00:02 hid three newer holdings behind it all
// day, including 103 Black d'hide shields sitting unsold. The queue only advances when a position
// CLOSES, never while it is merely selling, so a slow sale starves everything newer indefinitely. --

test('persistent: a position already listed for sale is skipped, not left blocking the queue', () => {
  const positions = [
    position({itemId: 1, item: 'Cannon base', firstSeen: now - 40 * 3600000}),   // oldest, on the market
    position({itemId: 2, item: "Black d'hide shield", firstSeen: now - 3600000}), // newer, sitting unsold
  ];
  const listed = id => id === 1;
  assert.equal(pickPersistentOpenPosition(positions, 'acct-a', undefined, listed).itemId, 2,
    'the first position NOT on the market is the one waiting to be sold');
  // Without the predicate the old behaviour stands, so every existing caller is unaffected.
  assert.equal(pickPersistentOpenPosition(positions, 'acct-a').itemId, 1);
});

test('persistent: age still decides among positions that are all unlisted', () => {
  const positions = [
    position({itemId: 2, firstSeen: now - 3600000}),
    position({itemId: 1, firstSeen: now - 40 * 3600000}),
  ];
  assert.equal(pickPersistentOpenPosition(positions, 'acct-a', undefined, () => false).itemId, 1,
    'oldest first is unchanged when nothing is listed');
});

test('persistent: everything listed means nothing is waiting to be sold', () => {
  const positions = [position({itemId: 1}), position({itemId: 2})];
  assert.equal(pickPersistentOpenPosition(positions, 'acct-a', undefined, () => true), null);
});

test('persistent: the blocklist and the listed check both apply', () => {
  const positions = [position({itemId: 1}), position({itemId: 2}), position({itemId: 3})];
  const pick = pickPersistentOpenPosition(positions, 'acct-a', new Set([1]), id => id === 2);
  assert.equal(pick.itemId, 3, 'blocked and listed are both stepped over');
});

// -- An empty coin pouch is a real answer, not a missing one. Found by novi on 29 Sept 2026 after
// banking their coins: EVI offered four 3rd Age robe tops at 131,812,123 each -- over half a billion
// gp -- to a player carrying nothing. The guard was "maxSpend > 0", which treats a genuine zero as
// "not supplied", and not supplied means no limit. The plugin already distinguishes the two: it
// omits the cash parameter entirely when it has not read the inventory yet, so absent is unknown
// and 0 is zero. --

test('cash: zero cash can afford nothing, and is not read as no limit', () => {
  const history = [flip(), flip()];
  assert.equal(computeSuggestion(history, fresh(), Date.now(), {maxSpend: 0}), null,
    'carrying nothing must buy nothing');
  // Above zero the cap still works normally: 100 gp a unit, so 100 gp affords exactly one.
  const barely = computeSuggestion(history, fresh(), Date.now(), {maxSpend: 100});
  assert.equal(barely && barely.quantity, 1, 'a hundred gp affords exactly one unit at 100 each');
  // And genuinely absent still means unknown, so a missing reading never silences EVI.
  const unknown = computeSuggestion(history, fresh(), Date.now(), {});
  assert.ok(unknown && unknown.quantity >= 1, 'no cash figure at all leaves the suggestion unconstrained');
});

test('cash: zero cash stops the market tier too, not only the history tier', () => {
  const items = mapping([{id: 3, name: 'Slow mover', limit: 100}]);
  const p = prices({'3': {high: 130, low: 100}});
  const vols = {'3': {highPriceVolume: 500, lowPriceVolume: 500}};
  // The fixture genuinely produces a pick, so the zero-cash assertion below cannot pass trivially.
  const normal = computeMarketSuggestion(items, p, vols, {blocklist: new Set([1, 2])});
  assert.equal(normal && normal.itemId, 3, 'the fixture must produce a suggestion when cash is unknown');
  assert.equal(computeMarketSuggestion(items, p, vols, {blocklist: new Set([1, 2]), maxSpend: 0}), null,
    'the market tier must respect an empty pouch as well');
});

// -- The idle-inventory tier must not claim an item was never bought when EVI holds its cost basis.
// 30 Sept 2026, from novi's own suggestion log one minute apart: at minProfit 1 the HOLDING tier
// answered for Gilded d'hide vambraces with breakEven 4,183,673; at minProfit 1,000,000
// holdingPreempts silenced it and this tier answered for the SAME item with breakEven null and the
// sentence "no buy EVI ever observed for it -- likely a drop, a quest reward, or stock from before
// this bridge started watching". EVI had watched the buy and knew they paid 4,100,000. --
test('idle stock excludes items EVI holds a cost basis for', () => {
  const prices = {23261: {low: 4271186, high: 4442921}, 1234: {low: 900000, high: 1000000}};
  const mapping = [{id: 23261, name: "Gilded d'hide vambraces"}, {id: 1234, name: 'Something else'}];
  const inventory = {23261: 1, 1234: 1};

  const withoutPositions = computeInventorySuggestion(prices, inventory, mapping, {});
  assert.equal(withoutPositions.itemId, 23261, 'by value alone the vambraces win');

  const withPosition = computeInventorySuggestion(prices, inventory, mapping,
    {positionItemIds: new Set([23261])});
  assert.equal(withPosition.itemId, 1234,
    'an item with an open position belongs to the holding tier, which can say what was paid');

  // And when the ONLY thing held is a tracked position, this tier says nothing at all. Silence is
  // the honest answer: it is what holdingPreempts decided, no longer hidden behind a wrong sentence.
  assert.equal(computeInventorySuggestion(prices, {23261: 1}, mapping,
    {positionItemIds: new Set([23261])}), null);
});

// -- "Yours, not stock" is quantity-aware: only the SURPLUS above what you keep is stock. --
// novi, 29 Sept 2026: "if I get an ancestral robe top for example as a drop, it will probably still
// not suggest to sell that one." Correct, and a design gap: marking an item hid EVERY unit of it for
// ever, because "I own one of these for use" and "I never sell this item" were the same statement.
test('only the surplus above what is kept for use is offered', () => {
  const prices = {4151: {low: 1900000, high: 2000000}};
  const mapping = [{id: 4151, name: 'Abyssal whip'}];

  // Holding exactly what you keep: nothing to sell, and this is the common case.
  assert.equal(computeInventorySuggestion(prices, {4151: 1}, mapping, {keptForUse: {4151: 1}}), null);

  // A second one dropped. The one being worn stays silent; the spare is stock.
  const two = computeInventorySuggestion(prices, {4151: 2}, mapping, {keptForUse: {4151: 1}});
  assert.equal(two.itemId, 4151);
  assert.equal(two.quantity, 1, 'one kept, one sellable -- never the whole stack');

  const four = computeInventorySuggestion(prices, {4151: 4}, mapping, {keptForUse: {4151: 2}});
  assert.equal(four.quantity, 2);
});

test('a mark with no kept count keeps the old blanket behaviour', () => {
  // Marks written before 1 Oct 2026 carry no count. They stay in the wholesale blocklist rather
  // than being assumed to be 1: guessing would retroactively offer to sell a second unit the player
  // had deliberately protected, and we cannot know how many they held when they marked it.
  const prices = {4151: {low: 1900000, high: 2000000}};
  const mapping = [{id: 4151, name: 'Abyssal whip'}];
  assert.equal(computeInventorySuggestion(prices, {4151: 5}, mapping, {blocklist: new Set([4151])}), null);
});

test('a kept count of zero still protects one', () => {
  // Marking an item while not actually holding it would record 0 and switch the exclusion off
  // entirely -- the exact opposite of what pressing the button means. Floored at 1 on both sides.
  const prices = {4151: {low: 1900000, high: 2000000}};
  const mapping = [{id: 4151, name: 'Abyssal whip'}];
  assert.equal(computeInventorySuggestion(prices, {4151: 1}, mapping, {keptForUse: {4151: 0}}), null);
  assert.equal(computeInventorySuggestion(prices, {4151: 2}, mapping, {keptForUse: {4151: 0}}).quantity, 1);
});
