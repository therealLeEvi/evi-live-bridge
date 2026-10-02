import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tradingPeriods, ENOUGH_CLOSED} from '../bridge/tradingPeriods.mjs';

// A synthetic hash of the right shape. The plugin sends a 64-hex account identifier and this test
// only needs a stable one -- a real identifier is what a journal is indexed by, so it never ships.
const ACCOUNT = 'a'.repeat(64);
const T = Date.UTC(2026, 8, 19, 12);
const row = (min, mins, over, extra = {}) => ({account: ACCOUNT, ts: T + over * 60000, minProfit: min,
  durationMinutes: mins, risk: 'medium', taken: false, ...extra});

test('trading periods: one row per stretch where the settings held, newest first', () => {
  const p = tradingPeriods([
    row(500000, 720, 0), row(500000, 720, 10), row(1000000, 720, 20), row(1000000, 720, 30), row(1000000, 720, 40),
  ]);
  assert.equal(p.length, 2);
  assert.deepEqual([p[0].minProfit, p[0].shown], [1000000, 3], 'newest first');
  assert.deepEqual([p[1].minProfit, p[1].shown], [500000, 2]);
  assert.equal(p[1].from, T);
  assert.equal(p[0].to, T + 40 * 60000);
  // Going back to earlier settings starts a new period rather than merging with the old one.
  assert.equal(tradingPeriods([row(500000, 720, 0), row(1000000, 720, 10), row(500000, 720, 20)]).length, 3);
});

test('trading periods: development requests against the bridge are not the player trading', () => {
  const p = tradingPeriods([
    {account: 'test', ts: T, minProfit: 500000, durationMinutes: 60, risk: 'low'},
    {account: null, ts: T + 60000, minProfit: 500000, durationMinutes: 720, risk: 'low'},
    row(500000, 720, 2),
  ]);
  assert.equal(p.length, 1, 'only the real account is counted');
  assert.equal(p[0].shown, 1);
});

test('trading periods: outcomes and what the checks did, summed per period', () => {
  const taken = (min, over, extra) => row(min, 720, over, {taken: true, ...extra});
  const p = tradingPeriods([
    taken(500000, 0, {filledFully: true, profit: 300000}),
    taken(500000, 1, {filledFully: true, profit: -100000, checks: {demoted: true, sellSupport: {supported: false}, exitRisk: {notable: true}}}),
    taken(500000, 2, {stillOpen: true}),
    row(500000, 720, 3),
  ])[0];
  assert.deepEqual([p.shown, p.taken, p.filledFully, p.stillOpen], [4, 3, 2, 1]);
  assert.deepEqual([p.closed, p.realisedProfit, p.winners, p.losers], [2, 200000, 1, 1]);
  assert.equal(p.worstProfit, -100000);
  assert.deepEqual([p.demoted, p.sellSupportFailed, p.exitRiskFlagged], [1, 1, 1]);
});

test('trading periods: a period with too few closed trades says so instead of inviting a comparison', () => {
  const few = tradingPeriods([row(500000, 720, 0, {taken: true, profit: 1000000})])[0];
  assert.equal(few.closed, 1);
  assert.equal(few.enoughToCompare, false, 'one flip is not evidence that a setting works');
  const many = tradingPeriods(Array.from({length: ENOUGH_CLOSED}, (_, i) => row(500000, 720, i, {taken: true, profit: 1000})));
  assert.equal(many[0].enoughToCompare, true);
  assert.deepEqual(tradingPeriods([]), []);
  assert.deepEqual(tradingPeriods(null), []);
});
