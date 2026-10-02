import {test} from 'node:test';
import assert from 'node:assert/strict';
import {returnsFor, correlationOf, createCorrelationIndex, correlationNote,
  CORRELATED_THRESHOLD, CORRELATION_STEP_SECONDS, MIN_OVERLAP, aggregateToStep} from '../bridge/correlation.mjs';
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

test('correlation: the six-hour series is AGGREGATED, not sampled -- sampling nullified this check entirely', () => {
  // FOUND 2 OCT 2026. This check had never once fired in practice. The server built its
  // six-hour series by taking every 6th HOURLY bucket, which is sampling, not aggregating: it keeps
  // the whole single-hour bid-ask bounce that six-hourly exists to average away, and merely uses a
  // sixth as many observations of the same noisy quantity. Measured on the real archive, a genuine
  // equipment family read 0.198 sampled against 0.627 aggregated, against a 0.5 threshold -- so it
  // could never clear it, while the only pairs that DID clear it were low-overlap noise.
  //
  // Nothing in the suite noticed, because every existing test here feeds returnsFor a series that is
  // already at the step it asks for. This test is built the way the BRIDGE builds it: hourly buckets
  // in, six-hour returns out.
  //
  // Two items whose six-hour LEVELS move together, each with large independent hour-to-hour noise --
  // which is exactly the real shape, bid-ask bounce on top of a shared trend.
  const lcg = seed => { let s = seed; return () => (s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5; };
  const nA = lcg(7), nB = lcg(99999);
  const buckets = [];
  for (let h = 0; h < 6 * 120; h++) {
    const blk = Math.floor(h / 6);
    // Sized deliberately, because the first attempt failed for the wrong reason: a slow signal had
    // too small a BLOCK-TO-BLOCK change to beat the residual noise even after averaging, and the test
    // failed against the fix. Averaging 6 hours cuts noise by sqrt(6), so the shared signal's return
    // per block has to sit between the raw noise and that -- below it sampling must miss the family,
    // above it aggregating must catch it. A period of 1.5 blocks at 0.35 noise lands in that window.
    const level = 1000 * (1 + 0.20 * Math.sin(blk / 1.5));
    const a = level * (1 + 0.35 * nA());
    const b = level * (1 + 0.35 * nB());
    buckets.push({ts: h * 3600, d: {'1': [a, 1, a, 1], '2': [b, 1, b, 1]}});
  }

  // What SHIPPED: every 6th hourly bucket. The bounce survives and swamps the shared signal.
  const sampled = createCorrelationIndex(buckets.filter((_, i) => i % 6 === 0));
  const bad = sampled.strongestAgainst(1, [2]);
  assert.ok(bad === null || bad.correlation < CORRELATED_THRESHOLD,
    `sampling must FAIL to see a real family -- that is the bug being fixed, got ${bad && bad.correlation.toFixed(3)}`);

  // What ships NOW: the hours in each block averaged into one point. The noise averages down, the
  // shared signal survives, and the threshold is cleared.
  const aggregated = createCorrelationIndex(aggregateToStep(buckets));
  const good = aggregated.strongestAgainst(1, [2]);
  assert.ok(good, 'aggregating must produce a reading at all');
  assert.ok(good.correlation >= CORRELATED_THRESHOLD,
    `aggregating must see the family it was calibrated to see, got ${good.correlation.toFixed(3)}`);
  assert.ok(good.overlap >= MIN_OVERLAP, `and on enough shared history: ${good.overlap}`);

  // Blocks must land exactly CORRELATION_STEP_SECONDS apart, since returnsFor rejects any other
  // spacing outright -- that exact-match check is what silently discarded everything before.
  const blocks = aggregateToStep(buckets);
  for (let i = 1; i < blocks.length; i++)
    assert.equal(blocks[i].ts - blocks[i - 1].ts, CORRELATION_STEP_SECONDS, 'blocks must be evenly spaced');

  // And it must NOT manufacture correlation where there is none: two items that share no signal
  // stay uncorrelated after aggregating. Otherwise the fix would simply move the false-positive
  // problem rather than solve it.
  const nC = lcg(555), nD = lcg(31337);
  const noise = [];
  for (let h = 0; h < 6 * 120; h++) {
    const c = 1000 * (1 + 0.30 * nC()), d = 1000 * (1 + 0.30 * nD());
    noise.push({ts: h * 3600, d: {'1': [c, 1, c, 1], '2': [d, 1, d, 1]}});
  }
  const unrelated = createCorrelationIndex(aggregateToStep(noise)).strongestAgainst(1, [2]);
  assert.ok(!unrelated || Math.abs(unrelated.correlation) < CORRELATED_THRESHOLD,
    `unrelated items must stay uncorrelated after aggregating, got ${unrelated && unrelated.correlation.toFixed(3)}`);

  // KNOWN COVERAGE GAP, stated because it is the same shape as the bug this test exists for.
  // Verified by sabotage on 2 Oct 2026: reverting `correlationIndex()` in server.mjs to
  // `.filter((_,i)=>i%6===0)` leaves this file GREEN, because everything above calls aggregateToStep
  // directly rather than going through the bridge. So the helper is covered and the WIRING is not --
  // which is exactly how the original fired 0 times for weeks with a green suite.
  // Testing it properly needs a booted bridge with a synthetic archive AND injected slot exposure
  // (the correlation check only runs against items the plugin reports as held), which no harness
  // here provides yet. Until then this comment is the only thing standing between a revert and a
  // silently inert check. Do not treat these assertions as proof the bridge uses it.
});
