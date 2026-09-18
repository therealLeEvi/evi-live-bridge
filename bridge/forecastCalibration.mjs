import {forecastFromSeries} from './suggestions.mjs';

// Does EVI's price forecast actually predict anything, and does a higher confidence number mean a
// better chance of being right?
//
// forecastFromSeries reports a "confidence" of 42-88 that is a rescaled signal-to-noise ratio:
// `clamp(42 + strength * 22, 42, 88)`. Nothing in it had ever been compared to an outcome, so 80
// meant "this signal stood out from its own noise", not "right eight times in ten". That number is
// not cosmetic -- UNFAVORABLE_FORECAST_CONFIDENCE gates the skip policy, so a forecast above it can
// drop a candidate EVI would otherwise have suggested. A threshold chosen by reasoning and never
// measured is exactly the kind of thing this project refuses to leave standing.
//
// This module replays the real forecaster over the archived price history and scores it. No waiting
// for data: forecastFromSeries is a pure function of a price series, and the archive already holds
// months of them.
//
// Four traps this is deliberately built around, all of them ways to produce a confident-looking
// number that means nothing:
//
//  1. BASE RATE. If prices sit flat most of the time, a model that always says "Stable" looks
//     excellent. Every accuracy here is reported next to what the naive baselines would have
//     scored on the same samples; accuracy alone is never presented as evidence of skill.
//  2. A MOVE HAS TO MATTER. "Correct" cannot mean the price ticked up 0.1%. Outcomes are judged by
//     the forecaster's OWN threshold (see forecastFromSeries' returned `threshold`), which is
//     derived from that item's own recent volatility -- per item and per moment, never a flat
//     percentage across every item.
//  3. OVERLAPPING SAMPLES ARE NOT INDEPENDENT. Predictions on the same item from sliding windows
//     share most of their data and their outcome periods. Samples are therefore spaced at least a
//     full horizon apart per item, and the number of distinct items is reported alongside the
//     number of predictions, because 10,000 predictions over 30 items is 30-ish pieces of
//     evidence, not 10,000.
//  4. THIN BANDS. A confidence band with too few samples reports null rather than a number from a
//     handful of predictions, exactly as the fill model does.
//
// What it cannot tell you: whether following the forecast makes GP. Direction is not profit -- a
// correct call that moves less than the spread and tax still loses. That is the backtester's
// question, and this module deliberately does not answer it.

export const MIN_BAND_SAMPLES = 30;
// Bands over the reachable confidence range (42-88). Chosen to be wide enough to fill.
export const CONFIDENCE_BANDS = [[42, 50], [50, 60], [60, 70], [70, 80], [80, 89]];
export const OUTCOMES = ['up', 'flat', 'down'];

// How many series points each horizon's forecast consumes, mirroring forecastFromSeries' own `n`,
// plus the pairing of horizon to series resolution that timestepForHorizon encodes. A '6h' forecast
// reads an hourly series, so its outcome is measured 6 points later.
export const HORIZONS = {
  '1h': {points: 12, stepSeconds: 300, aheadPoints: 12},      // 5-minute series, one hour ahead
  '6h': {points: 18, stepSeconds: 3600, aheadPoints: 6},      // hourly series, six hours ahead
  overnight: {points: 28, stepSeconds: 6 * 3600, aheadPoints: 2}, // 6-hourly series, twelve hours ahead
};

export function bandOf(confidence) {
  const i = CONFIDENCE_BANDS.findIndex(([lo, hi]) => confidence >= lo && confidence < hi);
  return i < 0 ? null : `${CONFIDENCE_BANDS[i][0]}-${CONFIDENCE_BANDS[i][1] - 1}`;
}

// Archive buckets ({ts, d:{itemId:[avgHigh, highVol, avgLow, lowVol]}}) into the point shape
// forecastFromSeries reads. Only items present in a bucket appear in it, so a series is naturally
// sparse; gaps are left as gaps rather than interpolated, since inventing a price is exactly the
// kind of guess this project does not make.
export function seriesFor(buckets, itemId) {
  const key = String(itemId), out = [];
  for (const b of buckets) {
    const e = b.d?.[key];
    if (!e) continue;
    out.push({timestamp: b.ts, avgHighPrice: e[0], highPriceVolume: e[1], avgLowPrice: e[2], lowPriceVolume: e[3]});
  }
  return out;
}

// Items worth replaying at all: enough points to forecast from, and actually traded. An item with
// three sales a day produces a "forecast" from noise, and scoring the model on those would measure
// the archive's sparseness rather than the model.
export function tradeableItems(buckets, {minPoints, minMedianVolume = 50} = {}) {
  const counts = new Map(), volumes = new Map();
  for (const b of buckets) {
    for (const [id, e] of Object.entries(b.d || {})) {
      counts.set(id, (counts.get(id) || 0) + 1);
      if (!volumes.has(id)) volumes.set(id, []);
      volumes.get(id).push(Math.min(e[1] || 0, e[3] || 0));
    }
  }
  const keep = [];
  for (const [id, n] of counts) {
    if (n < minPoints) continue;
    const v = volumes.get(id).sort((a, b) => a - b);
    if (v[Math.floor(v.length / 2)] < minMedianVolume) continue;
    keep.push(Number(id));
  }
  return keep.sort((a, b) => a - b);
}

const mid = p => {
  const hi = Number(p.avgHighPrice), lo = Number(p.avgLowPrice);
  if (Number.isFinite(hi) && hi > 0 && Number.isFinite(lo) && lo > 0) return (hi + lo) / 2;
  if (Number.isFinite(hi) && hi > 0) return hi;
  if (Number.isFinite(lo) && lo > 0) return lo;
  return null;
};

// Replays the forecaster across every eligible item and moment, returning one row per prediction.
// Each row carries what was predicted, what happened, and by how much -- the scoring itself is left
// to summarize() so the raw rows can be re-scored under a different definition without re-running.
export function replayForecasts(buckets, {horizon = '6h', items, minMedianVolume = 50, maxItems = Infinity} = {}) {
  const spec = HORIZONS[horizon];
  if (!spec) throw new Error('Unknown horizon: ' + horizon);
  const sorted = [...(buckets || [])].sort((a, b) => a.ts - b.ts);
  // A forecast needs `points` of history; the outcome needs `aheadPoints` beyond it.
  const need = spec.points + spec.aheadPoints;
  const chosen = (items ?? tradeableItems(sorted, {minPoints: need, minMedianVolume})).slice(0, maxItems);
  const rows = [];
  let skippedGaps = 0;
  for (const itemId of chosen) {
    const series = seriesFor(sorted, itemId);
    if (series.length < need) continue;
    // Non-overlapping: step a full horizon each time, so no two predictions for this item share an
    // outcome period. This is the single biggest difference between an honest sample count and a
    // flattering one.
    for (let i = spec.points; i + spec.aheadPoints < series.length; i += spec.aheadPoints) {
      const window = series.slice(i - spec.points, i);
      const at = series[i - 1], after = series[i - 1 + spec.aheadPoints];
      // The outcome must be the right distance away in TIME, not merely in array positions: a gap
      // in the archive would otherwise silently score a 6-hour forecast against a 40-hour move.
      const expected = spec.stepSeconds * spec.aheadPoints;
      if (Math.abs((after.timestamp - at.timestamp) - expected) > spec.stepSeconds) { skippedGaps++; continue; }
      const from = mid(at), to = mid(after);
      if (!(from > 0) || !(to > 0)) { skippedGaps++; continue; }
      const f = forecastFromSeries(window, horizon);
      const realised = to / from - 1;
      // Judged by the forecaster's own bar for calling a move (see forecastFromSeries).
      const threshold = Number.isFinite(f.threshold) ? f.threshold : 0.0025;
      const outcome = realised > threshold ? 'up' : realised < -threshold ? 'down' : 'flat';
      rows.push({itemId, ts: at.timestamp, label: f.label, dir: f.dir, confidence: f.confidence,
        predictedMove: f.move, threshold, realised, outcome});
    }
  }
  return {rows, skippedGaps, items: chosen.length};
}

// What a prediction claims about the outcome, so "correct" is defined once and in one place.
// 'Possible rebound' (dir 0.5) is a hedge, not a direction -- it is counted and reported, never
// scored as if it had claimed a rise.
const claimOf = label => label === 'Likely rising' ? 'up' : label === 'Likely falling' ? 'down' : label === 'Stable' ? 'flat' : null;

function tally(rows) {
  const scored = rows.filter(r => claimOf(r.label) !== null);
  const correct = scored.filter(r => claimOf(r.label) === r.outcome).length;
  return {n: rows.length, scored: scored.length, correct,
    accuracy: scored.length ? correct / scored.length : null,
    items: new Set(rows.map(r => r.itemId)).size};
}

// Scores a replay. Every accuracy is reported beside what the naive baselines would have scored on
// exactly the same samples, because accuracy without a base rate is not evidence of anything.
export function summarizeForecastCalibration(replay, {minBandSamples = MIN_BAND_SAMPLES} = {}) {
  const rows = replay.rows || [];
  const counts = Object.fromEntries(OUTCOMES.map(o => [o, rows.filter(r => r.outcome === o).length]));
  const total = rows.length;
  const baseRates = Object.fromEntries(OUTCOMES.map(o => [o, total ? counts[o] / total : null]));
  // The bar any real model has to clear: always guessing the commonest outcome.
  const majority = OUTCOMES.reduce((best, o) => counts[o] > counts[best] ? o : best, OUTCOMES[0]);

  const byLabel = {};
  for (const label of [...new Set(rows.map(r => r.label))]) {
    const sub = rows.filter(r => r.label === label);
    byLabel[label] = {...tally(sub), claims: claimOf(label),
      // What the same samples would have scored by always guessing the majority outcome.
      baseline: sub.length ? sub.filter(r => r.outcome === majority).length / sub.length : null};
  }

  // The question the whole exercise exists to answer: does a higher confidence number mean a better
  // chance of being right? Directional calls only -- "Stable" is a different claim and mixing it in
  // would let a flat market carry the curve.
  const directional = rows.filter(r => r.dir === 1 || r.dir === -1);
  const byConfidence = CONFIDENCE_BANDS.map(([lo, hi]) => {
    const sub = directional.filter(r => r.confidence >= lo && r.confidence < hi);
    const t = tally(sub);
    const enough = sub.length >= minBandSamples;
    return {band: `${lo}-${hi - 1}`, n: sub.length, items: t.items,
      // Null, never a guess, when the band is too thin to mean anything.
      accuracy: enough ? t.accuracy : null,
      baseline: enough && sub.length ? sub.filter(r => r.outcome === majority).length / sub.length : null,
      enough};
  });

  const usable = byConfidence.filter(b => b.enough && b.accuracy !== null);
  // Is the score monotonic -- does each band beat the one below it? If not, the number is not a
  // confidence in any useful sense, whatever it is called.
  const monotonic = usable.length >= 2 && usable.every((b, i) => i === 0 || b.accuracy >= usable[i - 1].accuracy);
  const spread = usable.length >= 2 ? usable.at(-1).accuracy - usable[0].accuracy : null;

  return {
    predictions: total, items: replay.items ?? new Set(rows.map(r => r.itemId)).size,
    skippedGaps: replay.skippedGaps ?? 0,
    outcomes: counts, baseRates, majority,
    byLabel, byConfidence,
    directional: tally(directional),
    monotonic, spread,
    // The headline, stated as a judgement rather than left for the reader to infer wrongly.
    verdict: usable.length < 2 ? 'not enough evidence'
      : spread !== null && spread >= 0.05 && monotonic ? 'confidence tracks accuracy'
      : spread !== null && spread <= 0.01 ? 'confidence does not distinguish anything'
      : 'weak or inconsistent',
  };
}

// The eventual replacement for the 42-88 formula: the measured accuracy of the band a raw
// confidence falls into, or null when that band was never measured well enough. Deliberately
// returns null rather than falling back to the raw number, so a caller has to decide what to do
// with "we don't know" instead of being handed a figure that looks measured and isn't.
export function calibratedConfidence(summary, rawConfidence) {
  if (!summary || !Number.isFinite(rawConfidence)) return null;
  const band = (summary.byConfidence || []).find(b => {
    const [lo, hi] = b.band.split('-').map(Number);
    return rawConfidence >= lo && rawConfidence <= hi;
  });
  return band && band.enough && band.accuracy !== null ? band.accuracy : null;
}
