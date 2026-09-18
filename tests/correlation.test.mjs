import {test} from 'node:test';
import assert from 'node:assert/strict';
import {returnsFor, correlationOf, createCorrelationIndex, correlationNote,
  CORRELATED_THRESHOLD, CORRELATION_STEP_SECONDS, MIN_OVERLAP} from '../bridge/correlation.mjs';
import {pickWithForecast} from '../bridge/suggestions.mjs';

const STEP = CORRELATION_STEP_SECONDS;
// Two items moving together, one moving independently, over enough points to be comparable.
function buckets(n = 120) {
  const out = [];
  let a = 1000, b = 500, c = 2000;
  for (let i = 0; i < n; i++) {
    const shared = Math.sin(i / 3) * 0.02;              // the common move
    a *= 1 + shared;
    b *= 1 + shared;                                     // follows a exactly
    c *= 1 + Math.sin(i * 7.3) * 0.02;                   // unrelated rhythm
    const e = v => [v * 1.01, 500, v * 0.99, 500];
    out.push({ts: 1700000000 + i * STEP, d: {1: e(a), 2: e(b), 3: e(c)}});
  }
  return out;
}

test('correlation: two items moving together are recognised, an unrelated one is not', () => {
  const index = createCorrelationIndex(buckets());
  const together = index.strongestAgainst(1, [2]);
  const apart = index.strongestAgainst(1, [3]);
  assert.ok(together.correlation > CORRELATED_THRESHOLD, `items moving as one must clear the threshold (got ${together.correlation})`);
  assert.ok(apart.correlation < CORRELATED_THRESHOLD, `an unrelated item must not (got ${apart.correlation})`);
  assert.ok(together.overlap >= MIN_OVERLAP);
});

test('correlation: too little shared history reports nothing rather than a number', () => {
  const index = createCorrelationIndex(buckets(MIN_OVERLAP));   // fewer returns than points
  assert.equal(index.strongestAgainst(1, [2]), null, 'a correlation from a handful of points is noise with a decimal point on it');
  assert.equal(correlationOf(new Map(), new Map()), null);
  // An item whose price never moves cannot be correlated with anything.
  const flat = [...Array(120)].map((_, i) => ({ts: 1700000000 + i * STEP, d: {1: [100, 5, 100, 5], 2: [50, 5, 50, 5]}}));
  assert.equal(createCorrelationIndex(flat).strongestAgainst(1, [2]), null);
});

test('correlation: a gap in the archive never becomes a return spanning it', () => {
  const all = buckets(120);
  const holed = all.filter((_, i) => i < 40 || i > 60);
  const r = returnsFor(holed, 1, STEP);
  for (const ts of r.keys()) {
    assert.ok(holed.some(b => b.ts === ts - STEP), 'every return must have its own previous point present');
  }
});

test('correlation: the strongest match wins, and the item itself is never compared to itself', () => {
  const index = createCorrelationIndex(buckets());
  const hit = index.strongestAgainst(1, [3, 2, 1]);
  assert.equal(hit.itemId, 2, 'the genuinely correlated item is the one worth naming');
  assert.ok(correlationNote(hit, id => ({2: 'Rune scimitar'}[id])).includes('Rune scimitar'));
  assert.match(correlationNote(hit, () => null), /an item you already hold/);
  assert.equal(correlationNote(null), null);
});

test('correlation: a correlated candidate is skipped and the next-best returned', async () => {
  const blocklist = new Set();
  const held = [];
  const rank = bl => bl.has(1) ? {itemId: 2, action: 'buy', reasoning: 'second'} : {itemId: 1, action: 'buy', reasoning: 'first'};
  const correlationFor = async c => c.itemId === 1 ? {blocked: true, note: 'moves with something you hold'} : null;
  const result = await pickWithForecast({rank, correlationFor, blocklist, policy: 'warn', horizon: null, onBlocked: r => held.push(...r)});
  assert.equal(result.itemId, 2, 'the check hands the player the next trade, it does not leave them with nothing');
  assert.ok(blocklist.has(1));
  assert.equal(held.length, 0, 'nothing was reported as held back, because a suggestion was found');
});

test('correlation: when everything is correlated, the reason is reported rather than silence', async () => {
  const held = [];
  const rank = () => ({itemId: 1, action: 'buy', reasoning: 'only pick'});
  const correlationFor = async () => ({blocked: true, note: 'moves with Rune scimitar'});
  const result = await pickWithForecast({rank, correlationFor, blocklist: new Set(), policy: 'warn', horizon: null,
    maxAttempts: 2, onBlocked: r => held.push(...r)});
  assert.equal(result, null);
  assert.equal(held.length, 2, 'every held-back candidate is reported');
  assert.match(held[0].reason, /Rune scimitar/, 'so the sidebar can say why, instead of blaming the settings');
});

test('correlation: an unusable check never blocks a trade', async () => {
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  for (const correlationFor of [async () => null, async () => ({blocked: false}), async () => { throw new Error('archive unreadable'); }]) {
    const result = await pickWithForecast({rank: () => candidate, correlationFor: async c => {
      try { return await correlationFor(c); } catch { return null; }
    }, blocklist: new Set(), policy: 'warn', horizon: null});
    assert.equal(result, candidate, 'no data means no view, never a block');
  }
});
