import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sharePreview, timeBand} from '../bridge/sharePreview.mjs';

const H = Date.UTC(2026, 8, 18, 14) / 1000;
const buckets = [{ts: H, d: {'4151': [1_010_000, 400, 990_000, 300], '2': [250, 0, 240, 5000]}}];
const at = min => H * 1000 + min * 60000;

test('share preview: describes an offer without its account, exact price, quantity or time of day', () => {
  const o = {offerId: 'secret-id', account: 'novi-salt', itemId: 4151, state: 'BOUGHT', price: 995_000, total: 20, filled: 20,
    firstSeen: at(10), completedAt: at(10 + 90), knownStart: true};
  const {records, sentAnywhere} = sharePreview([o], buckets);
  assert.equal(sentAnywhere, false);
  assert.deepEqual(records, [{itemId: 4151, side: 'buy', placedDay: '2026-09-18', priceVsMarketPct: -0.5,
    size: 'small (1-10%)', outcome: 'filled', filledShare: 1, took: '1-4 h'}]);
  const text = JSON.stringify(records);
  for (const leak of ['secret-id', 'novi-salt', '995000', '14:', 'T1']) assert.ok(!text.includes(leak), 'leaked ' + leak);
});

test('share preview: offers it cannot describe honestly are counted as left out, never guessed at', () => {
  const base = {itemId: 4151, state: 'BUYING', price: 1_000_000, total: 10, filled: 0, knownStart: true};
  const {records, skipped} = sharePreview([
    {...base, total: 1, filled: 1, state: 'BOUGHT', firstSeen: at(0), completedAt: at(0), ticksToFill: 1, price: 1_020_000, spent: 1_005_000}, // margin check
    {...base, firstSeen: at(0), knownStart: false},
    {...base, firstSeen: at(120)},                       // hour not in the archive
    {...base, itemId: 2, price: 245, firstSeen: at(5)},  // one side traded nothing that hour
    {...base, itemId: 999, firstSeen: at(5)},            // item not in that hour at all
  ], buckets);
  assert.equal(records.length, 0);
  assert.deepEqual(skipped, {marginCheck: 1, notWatchedFromStart: 1, hourNotArchived: 1, noMarketReading: 2});
});

test('share preview: a cancelled offer gave up after the time it was up; an open one has no duration yet', () => {
  const base = {itemId: 4151, price: 1_020_000, total: 1000, knownStart: true, firstSeen: at(0)};
  const {records} = sharePreview([
    {...base, state: 'CANCELLED_SELL', filled: 340, updated: at(300)},
    {...base, state: 'SELLING', filled: 0},
  ], buckets);
  assert.deepEqual(records.map(r => [r.side, r.outcome, r.filledShare, r.took, r.size]),
    [['sell', 'gave up', 0.3, '4-12 h', 'huge (over 200%)'], ['sell', 'open', 0, null, 'huge (over 200%)']]);
  assert.equal(timeBand(-1), null);
  assert.equal(timeBand(4.9), 'under 5 min');
});
