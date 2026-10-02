// A 12-hour sell-support average has no sense of time WITHIN its window, so a short burst at high
// volume can leave it describing a market that has already passed.
//
// Found 1 Oct 2026: a buy of Ape atoll teleports offered at 10,051 to sell at 20,000. The support
// said 7,392 buyers at an average of 22,231 -- but 86% of them were inside a two-hour spike that had
// ended six hours earlier, nothing had gone at or above 20,000 since, and buyers were paying 13,486.
//
// The thresholds are measured, not chosen: tools/support-staleness.mjs over 584,245 item-hours.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sellPriceSupport, supportIsStale, supportedPriceForHeadline,
  STALE_SUPPORT_RATIO, SOFT_STALE_SUPPORT_RATIO} from '../bridge/suggestions.mjs';

const HOUR = 3600;
// now is pinned to an exact hour boundary, because sellPriceSupport floors to one.
const NOW_MS = 1_800_000_000_000;
const END = Math.floor(NOW_MS / 3600000) * 3600;

/** A series of {hoursAgo, price, volume} turned into what the Wiki/archive hand over. */
const series = rows => rows.map(r => ({
  timestamp: END - r.hoursAgo * HOUR, avgHighPrice: r.price, highPriceVolume: r.volume,
}));

test('a steady market is not stale, and the support stands', () => {
  const steady = series(Array.from({length: 12}, (_, i) => ({hoursAgo: i + 1, price: 1000, volume: 100})));
  const d = sellPriceSupport(steady, 1, 900, {nowMs: NOW_MS});
  assert.equal(Math.round(d.averagePaid), 1000);
  assert.equal(d.latestPaid, 1000);
  assert.equal(d.staleness, 1);
  assert.equal(supportIsStale(d), false);
  assert.equal(supportedPriceForHeadline(d), d.averagePaid, 'nothing is capped on a steady market');
});

test('the Ape atoll shape: a huge spike early, quiet since', () => {
  // Two hours at 20x volume and double the price, then six hours of ordinary trade at the real one.
  const spiky = series([
    {hoursAgo: 8, price: 22000, volume: 5000},
    {hoursAgo: 7, price: 26000, volume: 6000},
    {hoursAgo: 6, price: 20000, volume: 300},
    {hoursAgo: 5, price: 19000, volume: 300},
    {hoursAgo: 4, price: 17000, volume: 300},
    {hoursAgo: 3, price: 15000, volume: 300},
    {hoursAgo: 2, price: 14000, volume: 300},
    {hoursAgo: 1, price: 13000, volume: 300},
  ]);
  const d = sellPriceSupport(spiky, 1, 10000, {nowMs: NOW_MS});
  assert.ok(d.averagePaid > 20000, 'the spike dominates the volume-weighted mean: ' + Math.round(d.averagePaid));
  assert.equal(d.latestPaid, 13000, 'the most recent hour anyone actually bought in');
  assert.ok(d.staleness > STALE_SUPPORT_RATIO, 'staleness: ' + d.staleness.toFixed(2));
  assert.equal(supportIsStale(d), true);
  // The intervention: the price is capped at what buyers pay NOW, not the historical average.
  assert.equal(supportedPriceForHeadline(d), 13000);
  assert.ok(supportedPriceForHeadline(d) < d.averagePaid);
});

test('the pick is NOT blocked -- only the number is made honest', () => {
  // Buying at today's price may still be a fine trade. What was wrong was promising the old one.
  const spiky = series([
    {hoursAgo: 6, price: 30000, volume: 9000},
    {hoursAgo: 1, price: 12000, volume: 200},
  ]);
  const d = sellPriceSupport(spiky, 1, 8000, {nowMs: NOW_MS});
  assert.equal(d.supported, true, 'it still reports as supported; nothing here withholds the pick');
  assert.equal(supportedPriceForHeadline(d), 12000);
});

test('an unmeasurable reading is never called stale -- fail open', () => {
  // "We could not tell" must not read as "we found a problem", the same rule every check here
  // follows. A missing reading, a null, and an empty window all say nothing.
  assert.equal(supportIsStale(null), false);
  assert.equal(supportIsStale({}), false);
  assert.equal(supportIsStale({staleness: null}), false);
  // Infinity is the case Number.isFinite actually earns its place on: a ratio computed against a
  // zero latest price would otherwise be "infinitely stale" and cap the headline to nothing. The
  // first version of this test did not cover it, and weakening the guard passed six of six.
  assert.equal(supportIsStale({staleness: Infinity, averagePaid: 100, latestPaid: 0}), false);
  assert.equal(supportIsStale({staleness: NaN}), false);
  assert.equal(supportedPriceForHeadline(null), null);
  const empty = sellPriceSupport(series([{hoursAgo: 99, price: 1000, volume: 100}]), 1, 900, {nowMs: NOW_MS});
  assert.equal(empty.units, 0);
  assert.equal(empty.staleness, null);
  assert.equal(supportIsStale(empty), false);
});

test('the thresholds are the measured ones and do not drift', () => {
  // 1.5 is where the median shortfall reaches 20% (80.4% realised over the next 12h); 1.25 is where
  // it is worth stating but not acting on (90.6%). Changing either means re-running
  // tools/support-staleness.mjs, not editing this number.
  assert.equal(STALE_SUPPORT_RATIO, 1.5);
  assert.equal(SOFT_STALE_SUPPORT_RATIO, 1.25);
});

test('a RISING market is not penalised', () => {
  // Staleness is a ratio of average to latest, so a market where buyers now pay MORE than the
  // window's average gives a ratio below 1. That is the opposite of the problem and must not fire.
  const rising = series([
    {hoursAgo: 4, price: 1000, volume: 500},
    {hoursAgo: 3, price: 1200, volume: 500},
    {hoursAgo: 2, price: 1500, volume: 500},
    {hoursAgo: 1, price: 2000, volume: 500},
  ]);
  const d = sellPriceSupport(rising, 1, 900, {nowMs: NOW_MS});
  assert.ok(d.staleness < 1, 'staleness: ' + d.staleness.toFixed(2));
  assert.equal(supportIsStale(d), false);
  assert.equal(supportedPriceForHeadline(d), d.averagePaid, 'a rising market is never capped downward');
});
