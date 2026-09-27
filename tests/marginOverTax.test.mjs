// An edge thinner than the item's own Grand Exchange tax is not a trade.
//
// Written for a real first-user loss on 27 Sept 2026: EVI suggested buying 25,000 blood runes (item
// 565) at 334 gp -- the full buy limit, 8.35m of capital -- on a spread that cleared tax by about two
// gp a unit. The 500 gp Auto floor is a floor on TOTAL predicted profit, so 25,000 units satisfied it
// with 0.02 gp each. See marginClearsTax in bridge/suggestions.mjs for the 335-hour measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marginClearsTax, MARGIN_TAX_MULTIPLE, MARGIN_TAX_WARN_MULTIPLE,
  computeSuggestion, computeMarketSuggestion, computePushedSuggestion} from '../bridge/suggestions.mjs';
import {estimateUnitTax} from '../bridge/tax.mjs';

test('marginClearsTax: the bar is the item\'s own tax, and unknowns never block', () => {
  assert.equal(MARGIN_TAX_MULTIPLE, 0.5);
  assert.equal(MARGIN_TAX_WARN_MULTIPLE, 1);
  assert.equal(marginClearsTax(10, 6), true, '10 gp clears half of a 6 gp tax');
  assert.equal(marginClearsTax(3, 6), true, 'exactly half the tax is allowed through');
  assert.equal(marginClearsTax(2, 6), false, 'the blood rune case: 2 gp against a 6 gp tax');
  assert.equal(marginClearsTax(2, 6, MARGIN_TAX_WARN_MULTIPLE), false);
  assert.equal(marginClearsTax(7, 6, MARGIN_TAX_WARN_MULTIPLE), true);
  // A tax-free item has nothing to clear, and is also the safest band measured (7% loss rate).
  assert.equal(marginClearsTax(1, 0), true, 'a 1 gp margin on a tax-free item is untouched');
  // Fails open on anything it cannot judge, the standing rule for insufficient data here.
  assert.equal(marginClearsTax(undefined, 6), true);
  assert.equal(marginClearsTax(5, null), true);
  assert.equal(marginClearsTax(NaN, 6), true);
});

test('the blood rune trade is no longer offered market-wide, and a real spread still is', () => {
  const mapping = [
    {id: 565, name: 'Blood rune', limit: 25000, members: true},
    {id: 561, name: 'Nature rune', limit: 25000, members: true},
  ];
  // The shape of the incident: a 343/335 spread on a 6 gp tax is a 2 gp edge, 0.33x its own tax.
  const thin = {'565': {high: 343, low: 335, highTime: 1, lowTime: 1}};
  const vols = {'565': {highPriceVolume: 1168281, lowPriceVolume: 333402},
                '561': {highPriceVolume: 900000, lowPriceVolume: 500000}};
  const opts = {volumes: vols, maxSpend: 50_000_000, now: 1000, maxPriceAgeMinutes: Infinity};
  assert.equal(estimateUnitTax(565, 343), 6);
  assert.equal(computeMarketSuggestion(mapping, thin, vols, opts), null,
    'a 2 gp edge against a 6 gp tax is not offered, whatever the quantity would make it total');
  // The same item with an edge that covers its tax is offered as before.
  const real = {'565': {high: 360, low: 335, highTime: 1, lowTime: 1}};
  const ok = computeMarketSuggestion(mapping, real, vols, opts);
  assert.ok(ok && ok.itemId === 565, 'a 25 gp edge against a 7 gp tax is still a trade');
  // MinProfitTier.NONE ("no minimum at all") switches the bar off, the same escape the Auto floor has.
  const escaped = computeMarketSuggestion(mapping, thin, vols, {...opts, requireMarginOverTax: false});
  assert.ok(escaped && escaped.itemId === 565, 'NONE still gets the thin trade it asked for');
});

test('quantity cannot launder a thin edge past the minimum profit floor', () => {
  const mapping = [{id: 565, name: 'Blood rune', limit: 25000, members: true}];
  const thin = {'565': {high: 343, low: 335, highTime: 1, lowTime: 1}};
  const vols = {'565': {highPriceVolume: 1168281, lowPriceVolume: 333402}};
  // 2 gp a unit over 25,000 units totals 50,000 gp, which clears any floor the plugin sends by
  // default -- that is exactly how this got through, so the floor is not what is being relied on.
  const s = computeMarketSuggestion(mapping, thin, vols,
    {volumes: vols, maxSpend: 50_000_000, minProfit: 500, maxPriceAgeMinutes: Infinity});
  assert.equal(s, null);
});

test('a personal track record does not excuse an edge under half the tax', () => {
  const flips = [{itemId: 565, item: 'Blood rune', quantity: 3411, capital: 1156329,
    netProceeds: 1169973, profit: 13644, firstBuy: 1, lastSell: 2, hold: 0.09}];
  const thin = {'565': {high: 343, low: 335, highTime: 1, lowTime: 1}};
  const vols = {'565': {highPriceVolume: 1168281, lowPriceVolume: 333402}};
  assert.equal(computeSuggestion(flips, thin, Date.now(), {volumes: vols, maxSpend: 50_000_000}), null,
    'novi flipped blood runes once for +13,644; that does not make a 2 gp edge survive a 1 gp tick');
});

test('a scanner-pushed pick is held to the same bar', () => {
  const push = [{itemId: 565, name: 'Blood rune', buy: 335, sell: 343, net: 2, qty: 25000, score: 90}];
  const vols = {'565': {highPriceVolume: 1168281, lowPriceVolume: 333402}};
  assert.equal(computePushedSuggestion(push, {volumes: vols, maxSpend: 50_000_000}), null);
  const fat = [{itemId: 565, name: 'Blood rune', buy: 335, sell: 360, net: 18, qty: 25000, score: 90}];
  const ok = computePushedSuggestion(fat, {volumes: vols, maxSpend: 50_000_000});
  assert.ok(ok && ok.itemId === 565);
});
