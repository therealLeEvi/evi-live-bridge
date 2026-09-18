// Measures how wrong EVI's volume-based fill-time estimate actually is, against real trades.
//
// The estimate being tested (estimatedFillMinutes in suggestions.mjs) assumes an hour's trading
// volume is spread evenly across that hour, so `quantity / (volume per minute)` is how long an offer
// should take. It has never been checked against reality, and it gates real suggestions: the target
// trade duration drops candidates and caps quantities in every tier, market-wide included.
//
// Two very different ground truths are available, and they are kept apart on purpose:
//
//  * OBSERVED OFFERS (from EVI's own journal). One offer, one side, timed from when EVI first saw it
//    to when it finished. This is the closest thing to a true fill time, but the sample is only as
//    old as EVI's own watching.
//  * IMPORTED FLIPS (e.g. a Flipping Copilot export). A whole round trip: first buy to last sell.
//    Far more of them, but the figure includes the player being asleep, not listing the sell
//    immediately, or deliberately holding — so it OVERSTATES fill time by an unknown amount. Treat
//    its ratio as an upper bound, never as "the estimate is wrong by this much".
//
// Neither dataset is a fill model by itself. What this produces is a correction factor and, more
// importantly, an honest picture of the spread: if realised times scatter wildly around the
// estimate, no single factor will fix it and the estimate should stay a hedged hint rather than
// becoming a number anything is gated on.
const MINUTES_PER_HOUR = 60;

// The prediction under test, in minutes, for filling `quantity` units of one side of a trade given
// an hour's volume entry ({highPriceVolume, lowPriceVolume}). Mirrors estimatedFillMinutes'
// conservative min(high, low) liquidity, since a round trip needs both sides to trade. Returns null
// when there is no usable volume — never a fabricated number.
export function predictedFillMinutes(quantity, volumeEntry) {
  if (!(quantity > 0) || !volumeEntry) return null;
  const liquidity = Math.min(volumeEntry.highPriceVolume || 0, volumeEntry.lowPriceVolume || 0);
  if (!(liquidity > 0)) return null;
  return quantity / (liquidity / MINUTES_PER_HOUR);
}

// Finds the archived hour covering a timestamp. buckets must be sorted ascending by ts (seconds).
export function bucketAt(buckets, whenMs) {
  const ts = Math.floor(whenMs / 1000 / 3600) * 3600;
  let lo = 0, hi = buckets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (buckets[mid].ts === ts) return buckets[mid];
    if (buckets[mid].ts < ts) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

// trades: [{itemId, quantity, startedAt, finishedAt}] — one side for observed offers, a whole round
// trip for imported flips. sides: how many fills the realised time covers (1 or 2), so a round trip
// is compared against two fills rather than one. Returns one sample per trade the archive can price,
// and counts what had to be skipped so coverage is never silently overstated.
export function calibrationSamples(trades, buckets, {sides = 1} = {}) {
  const samples = [];
  let noArchive = 0, noVolume = 0, badTiming = 0;
  for (const t of trades) {
    const realised = (t.finishedAt - t.startedAt) / 60000;
    if (!(realised >= 0) || !(t.quantity > 0)) { badTiming++; continue; }
    const bucket = bucketAt(buckets, t.startedAt);
    if (!bucket) { noArchive++; continue; }
    const entry = bucket.d[String(t.itemId)];
    const predictedOneSide = predictedFillMinutes(t.quantity, entry && {highPriceVolume: entry[1], lowPriceVolume: entry[3]});
    if (predictedOneSide === null) { noVolume++; continue; }
    const predicted = predictedOneSide * sides;
    samples.push({itemId: t.itemId, item: t.item, quantity: t.quantity, predicted, realised,
      ratio: predicted > 0 ? realised / predicted : null, startedAt: t.startedAt});
  }
  return {samples, skipped: {noArchive, noVolume, badTiming}};
}

const quantile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : null;

// Summarises the ratio of realised to predicted time. The MEDIAN is the headline (a mean would be
// dragged around by trades left sitting for days), and the quartiles matter more than the median:
// they say whether a single correction factor could work at all.
export function summarizeCalibration(samples) {
  const ratios = samples.map(s => s.ratio).filter(r => Number.isFinite(r) && r >= 0).sort((a, b) => a - b);
  if (ratios.length < 20) return {samples: ratios.length, enough: false,
    note: 'Fewer than 20 usable samples: not enough to calibrate anything. Collect more history first.'};
  const median = quantile(ratios, 0.5);
  const faster = ratios.filter(r => r < 1).length;
  return {
    samples: ratios.length, enough: true,
    medianRatio: median, p25: quantile(ratios, 0.25), p75: quantile(ratios, 0.75), p90: quantile(ratios, 0.9),
    fasterThanPredicted: faster / ratios.length,
    // A correction is only worth applying if the middle half of the data agrees on roughly one
    // direction. spread is p75/p25: near 1 means a single factor fits; large means it does not.
    spread: quantile(ratios, 0.25) > 0 ? quantile(ratios, 0.75) / quantile(ratios, 0.25) : Infinity,
    suggestedFactor: median,
  };
}

// Splits samples by how long the estimate said they would take, because a factor that fits quick
// flips may not fit slow ones.
export function calibrationByBand(samples) {
  const bands = [['under 10 min', 0, 10], ['10-60 min', 10, 60], ['1-4 hours', 60, 240], ['over 4 hours', 240, Infinity]];
  return bands.map(([label, lo, hi]) => {
    const inBand = samples.filter(s => s.predicted >= lo && s.predicted < hi);
    return {band: label, ...summarizeCalibration(inBand)};
  });
}
