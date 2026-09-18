import {test} from 'node:test';
import assert from 'node:assert/strict';
import {replayForecasts, summarizeForecastCalibration, seriesFor, tradeableItems, bandOf,
  calibratedConfidence, MIN_BAND_SAMPLES, HORIZONS} from '../bridge/forecastCalibration.mjs';
import {forecastFromSeries} from '../bridge/suggestions.mjs';

const HOUR = 3600;
// Archive-shaped buckets for one item: [avgHigh, highVol, avgLow, lowVol].
function buckets(prices, {itemId = 2, volume = 500, startTs = 1700000000} = {}) {
  return prices.map((p, i) => ({ts: startTs + i * HOUR, d: {[String(itemId)]: [p * 1.01, volume, p * 0.99, volume]}}));
}

test('forecast calibration: the forecaster reports the bar it judges a move by', () => {
  const series = Array.from({length: 24}, (_, i) => ({timestamp: 1700000000 + i * HOUR, avgHighPrice: 101 + i, avgLowPrice: 99 + i, highPriceVolume: 100, lowPriceVolume: 100}));
  const f = forecastFromSeries(series, '6h');
  assert.ok(Number.isFinite(f.threshold) && f.threshold > 0, 'a caller must be able to score outcomes by the same rule the model predicts by');
  assert.ok(Number.isFinite(f.noise) && f.noise > 0);
  assert.ok(f.threshold >= 0.0025, 'never below the floor the model itself uses');
});

test('forecast calibration: predictions never overlap and are timed from the real series', () => {
  const rising = buckets(Array.from({length: 60}, (_, i) => 1000 + i * 5));
  const {rows} = replayForecasts(rising, {horizon: '6h', minMedianVolume: 1});
  assert.ok(rows.length >= 3, 'a 60-hour series must yield several predictions');
  const spacing = HORIZONS['6h'].aheadPoints * HOUR;
  for (let i = 1; i < rows.length; i++)
    assert.equal(rows[i].ts - rows[i - 1].ts, spacing, 'samples on one item must be a full horizon apart, or they share an outcome period');
  assert.ok(rows.every(r => r.itemId === 2 && Number.isFinite(r.realised) && Number.isFinite(r.threshold)));
});

test('forecast calibration: a gap in the archive is skipped, never scored as a longer move', () => {
  const all = buckets(Array.from({length: 60}, (_, i) => 1000 + i * 5));
  // Drop a day out of the middle: every window spanning the hole must be refused.
  const holed = all.filter((_, i) => i < 20 || i > 43);
  const {rows, skippedGaps} = replayForecasts(holed, {horizon: '6h', minMedianVolume: 1});
  assert.ok(skippedGaps > 0, 'the hole must be noticed');
  const spacing = HORIZONS['6h'].aheadPoints * HOUR;
  for (const r of rows) {
    const from = holed.find(b => b.ts === r.ts);
    assert.ok(from, 'every row is anchored to a real bucket');
    assert.ok(holed.some(b => b.ts === r.ts + spacing), 'and its outcome is exactly one horizon later in real time');
  }
});

test('forecast calibration: a thin confidence band reports nothing rather than a number', () => {
  const rows = Array.from({length: MIN_BAND_SAMPLES - 1}, (_, i) => ({itemId: i, ts: i, label: 'Likely rising', dir: 1, confidence: 65, realised: 0.1, threshold: 0.01, outcome: 'up'}));
  const s = summarizeForecastCalibration({rows, items: rows.length, skippedGaps: 0});
  const band = s.byConfidence.find(b => b.band === '60-69');
  assert.equal(band.n, MIN_BAND_SAMPLES - 1);
  assert.equal(band.accuracy, null, 'below the sample floor it must refuse to report');
  assert.equal(band.enough, false);
  assert.equal(calibratedConfidence(s, 65), null, 'and must not hand back a number that looks measured');
  assert.equal(s.verdict, 'not enough evidence');
});

test('forecast calibration: accuracy is always reported against the base rate it has to beat', () => {
  // A market that is flat 80% of the time, and a model that always says "Stable". Scoring 80% here
  // is worth nothing, and the summary has to make that visible rather than flattering the model.
  const rows = Array.from({length: 100}, (_, i) => ({itemId: i % 10, ts: i, label: 'Stable', dir: 0,
    confidence: 50, realised: 0, threshold: 0.01, outcome: i < 80 ? 'flat' : 'up'}));
  const s = summarizeForecastCalibration({rows, items: 10, skippedGaps: 0});
  assert.equal(s.majority, 'flat');
  assert.equal(s.baseRates.flat, 0.8);
  assert.equal(s.byLabel['Stable'].accuracy, 0.8);
  assert.equal(s.byLabel['Stable'].baseline, 0.8, 'the naive baseline scored exactly the same, which is the point');
  assert.equal(s.items, 10, 'ten items, not a hundred independent pieces of evidence');
});

test('forecast calibration: a hedge is counted but never scored as a direction', () => {
  const rows = [
    ...Array.from({length: 40}, (_, i) => ({itemId: i, ts: i, label: 'Possible rebound', dir: 0.5, confidence: 55, realised: 0.2, threshold: 0.01, outcome: 'up'})),
    ...Array.from({length: 40}, (_, i) => ({itemId: i, ts: i, label: 'Likely rising', dir: 1, confidence: 55, realised: 0.2, threshold: 0.01, outcome: 'up'})),
  ];
  const s = summarizeForecastCalibration({rows, items: 40, skippedGaps: 0});
  assert.equal(s.byLabel['Possible rebound'].claims, null);
  assert.equal(s.byLabel['Possible rebound'].accuracy, null, '"possible rebound" claims no direction, so it cannot be right or wrong');
  assert.equal(s.directional.scored, 40, 'only the directional calls are scored');
});

test('forecast calibration: a model that is right more often when more confident reads as such', () => {
  const make = (n, confidence, hitRate) => Array.from({length: n}, (_, i) => ({itemId: i, ts: i, label: 'Likely rising', dir: 1,
    confidence, realised: 0.2, threshold: 0.01, outcome: i < Math.round(n * hitRate) ? 'up' : 'down'}));
  const rows = [...make(100, 55, 0.4), ...make(100, 65, 0.55), ...make(100, 75, 0.7)];
  const s = summarizeForecastCalibration({rows, items: 100, skippedGaps: 0});
  assert.equal(s.monotonic, true);
  assert.ok(s.spread > 0.25);
  assert.equal(s.verdict, 'confidence tracks accuracy');
  assert.equal(calibratedConfidence(s, 75), 0.7, 'the measured accuracy replaces the raw score');
  // A flat model must read as exactly that, not as a weak positive.
  const flat = summarizeForecastCalibration({rows: [...make(100, 55, 0.4), ...make(100, 75, 0.405)], items: 100, skippedGaps: 0});
  assert.equal(flat.verdict, 'confidence does not distinguish anything');
});

test('forecast calibration: item selection and band helpers', () => {
  const b = [
    ...buckets(Array.from({length: 40}, () => 1000), {itemId: 2, volume: 500}),
    ...buckets(Array.from({length: 40}, () => 50), {itemId: 3, volume: 1}),
  ].sort((x, y) => x.ts - y.ts);
  const items = tradeableItems(b, {minPoints: 24, minMedianVolume: 50});
  assert.deepEqual(items, [2], 'an item that barely trades produces forecasts from noise and is left out');
  assert.equal(seriesFor(b, 2).length, 40);
  assert.equal(seriesFor(b, 999).length, 0);
  assert.equal(bandOf(42), '42-49');assert.equal(bandOf(88), '80-88');assert.equal(bandOf(200), null);
  assert.throws(() => replayForecasts(b, {horizon: '3d'}), /Unknown horizon/);
});
