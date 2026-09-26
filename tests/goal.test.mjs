import {test} from 'node:test';
import assert from 'node:assert/strict';
import {goalStatus, wealthRate, flipRate, MIN_SPAN_HOURS} from '../bridge/goal.mjs';

const NOW = Date.UTC(2026, 8, 20, 12);
const H = 3600000;
const TWISTED_BOW = 20997;
const priceOf = id => id === TWISTED_BOW ? {buyPrice: 1_200_000_000, sellPrice: 1_190_000_000} : null;
const itemName = id => id === TWISTED_BOW ? 'Twisted bow' : null;
// Wealth climbing 1m an hour for two days.
const history = Array.from({length: 49}, (_, i) => ({at: NOW - (48 - i) * H, total: 100_000_000 + i * 1_000_000}));
const wealth = total => ({total, cash: 1, inBuyOffers: 0, inSellOffers: 0, held: 0});

test('goal: the gap is today\'s price times the quantity, less what you actually have', () => {
  const g = goalStatus({goal: {itemId: TWISTED_BOW, quantity: 1}, wealth: wealth(148_000_000), priceOf, itemName, history, now: NOW});
  assert.equal(g.name, 'Twisted bow');
  assert.equal(g.unitPrice, 1_200_000_000);
  assert.equal(g.targetGp, 1_200_000_000);
  assert.equal(g.have, 148_000_000);
  assert.equal(g.gap, 1_052_000_000);
  assert.ok(Math.abs(g.share - 148 / 1200) < 1e-9);
  assert.equal(g.why, null, 'nothing to explain: there is a rate and a gap');
  // Two of them cost twice as much.
  assert.equal(goalStatus({goal: {itemId: TWISTED_BOW, quantity: 2}, wealth: wealth(1), priceOf, itemName, history, now: NOW}).targetGp, 2_400_000_000);
  // A plain GP target needs no item at all.
  const gp = goalStatus({goal: {gp: 500_000_000}, wealth: wealth(100_000_000), priceOf, history, now: NOW});
  assert.deepEqual([gp.targetGp, gp.gap, gp.name], [500_000_000, 400_000_000, null]);
  assert.equal(goalStatus({goal: null, wealth: wealth(1), priceOf}), null);
});

test('goal: both rates are measured and kept apart, and the estimate follows from them', () => {
  const flips = Array.from({length: 10}, (_, i) => ({profit: 500_000, lastSell: NOW - (10 - i) * H}));
  const g = goalStatus({goal: {gp: 200_000_000}, wealth: wealth(100_000_000), priceOf, history, flips, now: NOW});
  assert.equal(Math.round(g.rates.wealth.gpPerHour), 1_000_000, 'what the stack actually did, Slayer drops and all');
  assert.equal(Math.round(g.rates.wealth.hoursToGo), 100, '100m to go at 1m an hour');
  assert.ok(g.rates.flips.gpPerHour > 0 && g.rates.flips.gpPerHour < 1_000_000, 'flipping alone is the smaller number here');
  assert.equal(Math.round(g.rates.flips.hoursToGo), Math.round(g.gap / g.rates.flips.gpPerHour));
});

test('goal: what cannot be known is said, never estimated', () => {
  // No coin count: the gap itself is unknown, rather than the cash stack counting as zero.
  const noCash = goalStatus({goal: {itemId: TWISTED_BOW}, wealth: {total: null}, priceOf, itemName, history, now: NOW});
  assert.deepEqual([noCash.have, noCash.gap], [null, null]);
  assert.match(noCash.why, /does not know your coin count/);
  assert.equal(noCash.rates.wealth.hoursToGo, null, 'an unknown gap has no estimate -- null/number is 0 in JS, and "0 hours to go" would be the worst possible answer');
  // No price for the item: no target.
  const noPrice = goalStatus({goal: {itemId: 4151}, wealth: wealth(1), priceOf, history, now: NOW});
  assert.equal(noPrice.targetGp, null);
  assert.match(noPrice.why, /No current price/);
  // Too little history for a rate.
  const thin = goalStatus({goal: {gp: 1e9}, wealth: wealth(1), priceOf, now: NOW,
    history: [{at: NOW - H, total: 1}, {at: NOW, total: 2}]});
  assert.equal(thin.rates.wealth, null);
  assert.match(thin.why, new RegExp(`at least ${MIN_SPAN_HOURS} hours`));
  // Going backwards: no estimate at all rather than a negative or infinite one.
  const falling = goalStatus({goal: {gp: 1e9}, wealth: wealth(1), priceOf, now: NOW,
    history: history.map((r, i) => ({at: r.at, total: 200_000_000 - i * 1_000_000}))});
  assert.ok(falling.rates.wealth.gpPerHour < 0);
  assert.equal(falling.rates.wealth.hoursToGo, null);
  assert.match(falling.why, /not positive/);
  // Already there: no estimate needed and none offered.
  const done = goalStatus({goal: {gp: 100}, wealth: wealth(1_000_000), priceOf, history, now: NOW});
  assert.deepEqual([done.gap, done.why], [0, null]);
});

test('goal: the rate helpers refuse thin or empty records outright', () => {
  assert.equal(wealthRate([], {now: NOW}), null);
  assert.equal(wealthRate([{at: NOW, total: 5}], {now: NOW}), null, 'one snapshot is not a rate');
  assert.equal(wealthRate(history, {hours: 2, now: NOW}), null, 'inside the window there is too little span');
  assert.equal(flipRate(null, {now: NOW}), null);
  assert.equal(flipRate([{profit: 1, lastSell: NOW}], {now: NOW}), null);
  assert.equal(flipRate([{profit: 1, lastSell: NOW - 100 * H}, {profit: 1, lastSell: NOW - 99 * H}], {hours: 24, now: NOW}), null,
    'flips older than the window are not counted');
});
