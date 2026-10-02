// An edge thinner than the item's own Grand Exchange tax is not a trade.
//
// Written for a real first-user loss on 27 Sept 2026: EVI suggested buying 25,000 blood runes (item
// 565) at 334 gp -- the full buy limit, 8.35m of capital -- on a spread that cleared tax by about two
// gp a unit. The 500 gp Auto floor is a floor on TOTAL predicted profit, so 25,000 units satisfied it
// with 0.02 gp each. See marginClearsTax in bridge/suggestions.mjs for the 335-hour measurement.
import test from 'node:test';
import assert from 'node:assert/strict';
import {marginClearsTax, MARGIN_TAX_MULTIPLE, MARGIN_TAX_WARN_MULTIPLE,
  computeSuggestion, computeMarketSuggestion, computePushedSuggestion, pickWithForecast,
  implausibleSpread, IMPLAUSIBLE_MARGIN_MULTIPLE} from '../bridge/suggestions.mjs';
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
  // A profitable flip on this item is all the test needs; the figures are invented rather than taken
  // from anyone's journal, since a quantity and a capital together describe how someone trades.
  const flips = [{itemId: 565, item: 'Blood rune', quantity: 2000, capital: 670000,
    netProceeds: 682000, profit: 12000, firstBuy: 1, lastSell: 2, hold: 0.09}];
  const thin = {'565': {high: 343, low: 335, highTime: 1, lowTime: 1}};
  const vols = {'565': {highPriceVolume: 1168281, lowPriceVolume: 333402}};
  assert.equal(computeSuggestion(flips, thin, Date.now(), {volumes: vols, maxSpend: 50_000_000}), null,
    'one profitable blood-rune flip does not make a 2 gp edge survive a 1 gp tick');
});

test('a margin under the tax at the SUPPORTED price is held back, never shown as a last resort', async () => {
  // The 27 Sept blood runes. Quoted 332 -> 345 is a 7 gp edge on a 6 gp tax, 1.17x, so the tier let it
  // through. But 10.4m units had changed hands at 339 over 12 hours, making the real edge 1 gp -- 0.17x
  // the tax -- and 172,266 units turned that into a 172,266 gp "profit" that cleared every floor.
  //
  // It was demoted, and that was not enough: pickWithForecast shows the best demoted pick when nothing
  // else passes, which is exactly what happened. A block has to mean blocked.
  const candidate = {itemId: 565, name: 'Blood rune', quantity: 172266, buyPrice: 332, sellPrice: 345,
    action: 'buy', source: 'market', reasoning: 'Market pick.'};
  const heldBack = [];
  const result = await pickWithForecast({
    // Respects the blocklist, as the real ranking functions do -- so a blocked item is offered once.
    rank: list => list.has(565) ? null : {...candidate},
    supportFor: async () => ({blocked: true, warning: 'Set aside: worth about 1 gp a unit against a 6 gp tax.',
      detail: {supported: true, netAtAverage: 1, thinnerThanTax: true}}),
    blocklist: new Set(),
    onBlocked: rows => heldBack.push(...rows),
  });
  assert.equal(result, null, 'nothing is better than a trade worth less than its own tax');
  assert.equal(heldBack.length, 1, 'and it is reported as held back, not silently dropped');
  assert.equal(heldBack[0].itemId, 565);
  assert.match(heldBack[0].reasoning, /Set aside/);

  // A merely weak pick still behaves as before: demoted, and shown when nothing better exists, because
  // withholding every suggestion would be its own kind of wrong answer.
  const weak = await pickWithForecast({
    rank: list => list.has(565) ? null : {...candidate},
    supportFor: async () => ({warning: 'Warning: thin.', detail: {supported: true, netAtAverage: 40}}),
    blocklist: new Set(),
  });
  assert.ok(weak, 'a warning still leaves something on screen');
  assert.equal(weak.demoted, true);
  assert.match(weak.reasoning, /No other candidate passed this check/);
});

test('implausibleSpread: a margin too good to be true, on something nobody is trading', () => {
  // EVI offered to buy 1,301 Rune dart(p++) at 10 gp to sell at 874 -- an 8,470% margin -- where the
  // 10 gp was a single print from ten hours earlier, against a 24-hour average sell of 357, with
  // nothing traded in the intervening hour. Every other check here asks whether a margin is too THIN.
  assert.equal(IMPLAUSIBLE_MARGIN_MULTIPLE, 5);
  assert.equal(implausibleSpread(847, 10, null), true, 'the real case: 85x margin, nothing traded');
  assert.equal(implausibleSpread(847, 10, 0), true, 'an explicit zero reads the same as absence here');

  // The half that keeps it honest: someone trading it means the spread is real enough to judge by the
  // other checks. Cheap items carry huge percentage margins legitimately and that band is protected --
  // a 1 gp item selling at 3 is a 200% margin and a perfectly good small-stack flip.
  assert.equal(implausibleSpread(847, 10, 40), false, 'traded this hour: not this check\'s business');
  assert.equal(implausibleSpread(84, 10, 4), false, 'a cheap liquid flip at 840% stays');
  assert.equal(implausibleSpread(2, 1, 500), false);
  assert.equal(implausibleSpread(127057, 2268726, 3), false, 'an ordinary flip is nowhere near');
  assert.equal(implausibleSpread(40, 10, null), false, 'untraded but only 4x: under the bar');

  // Fails open on anything it cannot judge, the standing rule.
  for (const bad of [[undefined, 10, null], [847, 0, null], [847, -1, null], [-5, 10, null], [NaN, 10, null], [847, NaN, null]])
    assert.equal(implausibleSpread(...bad), false, JSON.stringify(bad));
});

test('the dart is refused by the tier that used to offer it', () => {
  // The personal tier deliberately does not drop stale prices -- "an old last-trade is context" -- so
  // nothing else here would have caught this one.
  const flips = [{itemId: 5641, item: 'Rune dart(p++)', quantity: 1301, capital: 13010,
    netProceeds: 200000, profit: 186990, firstBuy: 1, lastSell: 2, hold: 1}];
  const stale = {'5641': {high: 874, low: 10, highTime: 1, lowTime: 1}};
  const noTrades = {};                      // the Wiki omits an item entirely when nothing traded
  assert.equal(computeSuggestion(flips, stale, Date.now(), {volumes: noTrades, maxSpend: 205_516_281}), null);
  // The same item, same prices, once it is actually trading: judged on its merits again.
  const trading = {'5641': {highPriceVolume: 900, lowPriceVolume: 700}};
  const s = computeSuggestion(flips, stale, Date.now(), {volumes: trading, maxSpend: 205_516_281});
  assert.ok(s && s.itemId === 5641, 'liquidity is what makes the spread judgeable, not the ratio alone');
});

test('a scanner-pushed pick is held to the same bar', () => {
  const push = [{itemId: 565, name: 'Blood rune', buy: 335, sell: 343, net: 2, qty: 25000, score: 90}];
  const vols = {'565': {highPriceVolume: 1168281, lowPriceVolume: 333402}};
  assert.equal(computePushedSuggestion(push, {volumes: vols, maxSpend: 50_000_000}), null);
  const fat = [{itemId: 565, name: 'Blood rune', buy: 335, sell: 360, net: 18, qty: 25000, score: 90}];
  const ok = computePushedSuggestion(fat, {volumes: vols, maxSpend: 50_000_000});
  assert.ok(ok && ok.itemId === 565);
});
