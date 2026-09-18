import {test} from 'node:test';
import assert from 'node:assert/strict';
import {personalHistory, computeSuggestion, computeMarketSuggestion, computeHoldingSuggestion, computeInventorySuggestion, computePushedSuggestion, pickPersistentOpenPosition, lookupItemPrice, forecastFromSeries, timestepForHorizon, UNFAVORABLE_FORECAST_CONFIDENCE, decideForecast, pickWithForecast, estimateOfferFill, estimateVolatility, marginClearsCushion, MARGIN_CUSHION_MULTIPLIER, breakEvenSellPrice, priceAgeMinutes, MAX_PRICE_AGE_MINUTES, slotCapacity, slotNote, GE_SLOTS} from '../bridge/suggestions.mjs';

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
  const withGauntlets = prices({'3': {high: 20500000, low: 20000000}});
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

test('decideForecast: only skip-policy plus a confident falling forecast retries', () => {
  const falling = {dir: -1, confidence: 80};
  const weakFalling = {dir: -1, confidence: UNFAVORABLE_FORECAST_CONFIDENCE - 1};
  const rising = {dir: 1, confidence: 90};
  assert.equal(decideForecast(null, 'skip'), 'keep');
  assert.equal(decideForecast(falling, 'warn'), 'keep');
  assert.equal(decideForecast(falling, 'skip'), 'retry');
  assert.equal(decideForecast(weakFalling, 'skip'), 'keep');
  assert.equal(decideForecast(rising, 'skip'), 'keep');
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

test('pickWithForecast: warn mode keeps an unfavourable forecast, folding it into reasoning', async () => {
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const forecast = {label: 'Likely falling', dir: -1, confidence: 80};
  const result = await pickWithForecast({rank: () => candidate, forecastFor: async () => forecast, policy: 'warn', horizon: 'overnight', blocklist: new Set()});
  assert.equal(result, candidate);
  assert.equal(result.forecast, forecast);
  assert.match(result.reasoning, /Price forecast \(overnight\): Likely falling, 80% confidence\./);
});

test('pickWithForecast: skip mode retries the next-best candidate and excludes the rejected one via blocklist', async () => {
  const blocklist = new Set();
  const seen = [];
  const rank = bl => {
    seen.push(new Set(bl));
    if (bl.has(1)) return {itemId: 2, action: 'buy', reasoning: 'second pick'};
    return {itemId: 1, action: 'buy', reasoning: 'first pick'};
  };
  const forecastFor = async itemId => itemId === 1 ? {label: 'Likely falling', dir: -1, confidence: 90} : {label: 'Stable', dir: 0, confidence: 50};
  const result = await pickWithForecast({rank, forecastFor, policy: 'skip', horizon: 'overnight', blocklist});
  assert.equal(result.itemId, 2);
  assert.ok(blocklist.has(1), 'the rejected item must be added to the shared blocklist');
  assert.equal(seen.length, 2);
});

test('pickWithForecast: gives up after maxAttempts and returns null, same as nothing eligible', async () => {
  let attempts = 0;
  const rank = () => { attempts++; return {itemId: attempts, action: 'buy', reasoning: 'pick'}; };
  const forecastFor = async () => ({label: 'Likely falling', dir: -1, confidence: 90});
  const result = await pickWithForecast({rank, forecastFor, policy: 'skip', horizon: 'overnight', blocklist: new Set(), maxAttempts: 3});
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

test('pickWithForecast: forecast and cushion both apply, compounding across independent retries', async () => {
  const blocklist = new Set();
  const rank = bl => {
    if (bl.has(1) && bl.has(2)) return {itemId: 3, action: 'buy', reasoning: 'third pick'};
    if (bl.has(1)) return {itemId: 2, action: 'buy', reasoning: 'second pick'};
    return {itemId: 1, action: 'buy', reasoning: 'first pick'};
  };
  // Item 1: unfavourable forecast, skip policy -> retried. Item 2: fine forecast, but blocked by
  // cushion -> retried. Item 3: fine forecast, clears cushion -> kept.
  const forecastFor = async itemId => itemId === 1 ? {label: 'Likely falling', dir: -1, confidence: 90} : {label: 'Stable', dir: 0, confidence: 50};
  const cushionFor = async c => c.itemId === 2 ? {blocked: true} : {blocked: false};
  const result = await pickWithForecast({rank, forecastFor, policy: 'skip', horizon: 'overnight', cushionFor, requireCushion: true, blocklist, maxAttempts: 5});
  assert.equal(result.itemId, 3);
  assert.ok(blocklist.has(1) && blocklist.has(2), 'both rejected candidates must be blocklisted');
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
  assert.match(m.reasoning, /left of this item's 4-hour GE buy limit/);
  const tighter = id => id === 1 ? {limit: 10000, remaining: 100} : null; // below the usual size of 150
  const p = computeSuggestion(proven(), fresh(), Date.now(), {limitFor: tighter});
  assert.equal(p.quantity, 100);
  assert.match(p.reasoning, /left of this item's 4-hour GE buy limit/);
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

test('market: maxVolumeShare caps a trade to a share of recent hourly trading', () => {
  // 500/hour on the thin side, 5% = 25 units.
  const s = computeMarketSuggestion(mapping(), fresh(), volumes(), {maxVolumeShare: 0.05, blocklist: new Set([2])});
  assert.equal(s.quantity, 25);
  assert.match(s.reasoning, /5% of this item's recent hourly trading/);
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
  assert.match(capped.reasoning, /10% of this item's recent hourly trading/);
  assert.equal(computeMarketSuggestion(mapping(), fresh(), volumes(), {blocklist: new Set([2]), maxVolumeShare: 0}).quantity, 10000);
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
  assert.match(s.reasoning, /10% of this item's recent hourly trading/);
  // Opting out restores the old sizing, and no volume data at all never constrains anything.
  assert.equal(computeSuggestion(flips, fresh(), Date.now(), {volumes: vols, maxVolumeShare: 0}).quantity, 150);
  assert.equal(computeSuggestion(flips, fresh(), Date.now(), {}).quantity, 150);
});


// --- Grand Exchange slot capacity (8 offers, no more) ---

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