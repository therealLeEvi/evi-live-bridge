import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fillOutlook, fillOutlookSentence, FILL_OUTLOOK_MEASURED, MIN_INTERESTING_GAP, MIN_LABEL_SAMPLES} from '../bridge/fillOutlook.mjs';
import {pickWithForecast} from '../bridge/suggestions.mjs';

test('fill outlook: the exit-risk case is named as exit risk, never as a price direction', () => {
  // "Likely rising" is the label calibration found inverted: the buy fills easily and the sell does
  // not, so the player's real risk is being left holding it.
  const o = fillOutlook({label: 'Likely rising', dir: 1, confidence: 70});
  assert.ok(o.buy > o.sell, 'this pattern fills the buy more often than the sell');
  assert.equal(o.worst, 'sell');
  assert.ok(o.notable);
  const s = fillOutlookSentence(o);
  assert.match(s, /Exit risk/);
  assert.match(s, /left holding it/);
  assert.ok(!/rising|falling|Likely/.test(s), 'the direction label is measured to be misleading and must never reach the player');
});

test('fill outlook: the entry-risk case reads as entry risk', () => {
  const o = fillOutlook({label: 'Likely falling', dir: -1, confidence: 70});
  assert.ok(o.sell > o.buy);
  const s = fillOutlookSentence(o);
  assert.ok(!/falling/.test(s), 'still no direction claim');
  assert.match(s, /harder half|Entry risk/);
});

test('fill outlook: a label close to the ordinary rate says nothing at all', () => {
  const table = {...FILL_OUTLOOK_MEASURED, baseline: {buy: 0.88, sell: 0.84},
    byLabel: {Stable: {buy: 0.887, sell: 0.837, samples: 24948}}};
  const o = fillOutlook({label: 'Stable'}, table);
  assert.equal(o.notable, false, 'a one-point difference is inside the noise of a single window');
  assert.equal(fillOutlookSentence(o), null, 'and must produce no sentence rather than false precision');
  assert.ok(Math.abs(o.buyGap) < MIN_INTERESTING_GAP);
});

test('fill outlook: unknown or thin labels return null instead of a guess', () => {
  assert.equal(fillOutlook(null), null);
  assert.equal(fillOutlook({label: 'Something new'}), null);
  assert.equal(fillOutlookSentence(null), null);
  const thin = {...FILL_OUTLOOK_MEASURED, byLabel: {'Likely rising': {buy: 0.99, sell: 0.10, samples: MIN_LABEL_SAMPLES - 1}}};
  assert.equal(fillOutlook({label: 'Likely rising'}, thin), null, 'a dramatic-looking rate from too few offers must not be reported');
});

test('fill outlook: quoted only for the forecast setting it was measured with', () => {
  const f = {label: 'Likely rising', dir: 1, confidence: 70};
  assert.ok(fillOutlook(f, undefined, '6h'), 'the ~6 hours setting is what the rates were measured with');
  assert.equal(fillOutlook(f, undefined, '1h'), null, '~1 hour was never measured, so it gets no numbers at all');
  assert.equal(fillOutlook(f, undefined, 'overnight'), null, 'nor does Overnight');
  assert.ok(fillOutlook(f), 'called without a horizon it defaults to the measured one');
});

test('fill outlook: the shipped table stays a measurement, with its own provenance', () => {
  const t = FILL_OUTLOOK_MEASURED;
  assert.ok(t.samples > 10000 && t.items > 50, 'the table records the sample it came from');
  assert.ok(t.measuredOn && t.horizonHours > 0);
  for (const [label, v] of Object.entries(t.byLabel)) {
    assert.ok(v.buy > 0 && v.buy <= 1 && v.sell > 0 && v.sell <= 1, `${label} rates are rates`);
    assert.ok(v.samples > 0);
  }
  assert.ok(t.baseline.buy > 0 && t.baseline.sell > 0, 'every rate is reported against a baseline, or it means nothing');
});

test('a buy suggestion carries the fill outlook and no direction label', async () => {
  const candidate = {itemId: 1, action: 'buy', reasoning: 'base'};
  const forecast = {label: 'Likely rising', dir: 1, confidence: 80};
  const result = await pickWithForecast({rank: () => candidate, forecastFor: async () => forecast,
    policy: 'warn', horizon: '6h', blocklist: new Set()});
  assert.equal(result, candidate);
  assert.ok(result.fillOutlook, 'the outlook travels with the suggestion for anything that wants the numbers');
  assert.match(result.reasoning, /Exit risk/);
  assert.ok(!/Likely rising/.test(result.reasoning), 'the inverted direction label must not be shown');
  assert.ok(!/confidence/.test(result.reasoning), 'nor the strength score dressed up as one');
});
