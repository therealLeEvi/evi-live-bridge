import {bucketAt, predictedFillMinutes} from './fillCalibration.mjs';
import {isMarginCheck} from './store.mjs';

// A fill model learned from the player's own offers, rather than assumed. The volume estimate in
// suggestions.mjs answers "how long should this take if volume were spread evenly"; this answers the
// question a player actually has: "how often did an offer like this one actually finish in time?"
//
// Grouped by how big the order is relative to what the item trades in an hour, because that is the
// dimension the calibration work found to matter and that EVI can know in advance. Price aggression
// matters more (offers crossing the spread filled almost instantly) but EVI only ever suggests
// passive prices, so every sample here is the kind of offer it actually suggests.
//
// Deliberately coarse and deliberately honest: a bucket with fewer than MIN_SAMPLES observations
// reports nothing at all rather than a confident-looking number from four trades, and the caller
// falls back to the volume estimate. With a few hundred offers this is a genuinely useful local
// model; with a dozen it correctly refuses to say anything.

export const SHARE_BANDS = [
  {label: 'tiny (under 1% of an hour\'s volume)', max: 0.01},
  {label: 'small (1-10%)', max: 0.10},
  {label: 'moderate (10-50%)', max: 0.50},
  {label: 'large (50-200%)', max: 2},
  {label: 'huge (over 200%)', max: Infinity},
];
export const MIN_SAMPLES = 15;

export function bandFor(share) {
  return SHARE_BANDS.findIndex(b => share < b.max);
}

// offers: the journal's own finished offers, each observed from placement. buckets: archived hours.
// Returns one entry per band with the completion times seen in it, oldest data included -- the
// caller decides what to do with a thin band.
// The offers that did NOT fill are the whole point, so they are counted, not dropped -- an early
// version of this only kept completed offers and duly reported "100% filled" in every band, which is
// exactly the survivorship bias this model exists to avoid. Each offer becomes one of:
//   * filled   -- it completed, with the minutes it took;
//   * gave up  -- cancelled without filling its quantity, which is a failure to fill within the time
//                 it was actually up for;
//   * open     -- still running, so it only tells us it had not finished by the time last seen
//                 (censored: it counts against a window shorter than that, and is unknown beyond).
// Sizing uses the quantity that was OFFERED, not the amount that happened to fill, because that is
// what a suggestion has to predict before anything trades.
export function buildFillModel(offers, buckets, {now = Date.now()} = {}) {
  const bands = SHARE_BANDS.map(b => ({band: b.label, samples: []}));
  let skipped = 0;
  for (const o of offers || []) {
    const offered = o.total > 0 ? o.total : o.filled;
    // A one-item probe that fills instantly would otherwise teach the model that tiny orders always
    // fill in seconds -- true of probes, false of trades.
    if (!(offered > 0) || !Number.isFinite(o.firstSeen) || isMarginCheck(o)) { skipped++; continue; }
    const hour = bucketAt(buckets, o.firstSeen);
    const entry = hour && hour.d[String(o.itemId)];
    if (!entry) { skipped++; continue; }
    const liquidity = Math.min(entry[1] || 0, entry[3] || 0);
    if (!(liquidity > 0)) { skipped++; continue; }
    const index = bandFor(offered / liquidity);
    if (index < 0) { skipped++; continue; }
    const cancelled = typeof o.state === 'string' && o.state.startsWith('CANCELLED');
    const completedFully = o.filled >= offered && o.completedAt;
    const endedAt = o.completedAt ?? o.updated ?? now;
    const minutes = Math.max(0, (endedAt - o.firstSeen) / 60000);
    if (completedFully) bands[index].samples.push({minutes, filled: true});
    else if (cancelled) bands[index].samples.push({minutes, filled: false, gaveUp: true});
    else bands[index].samples.push({minutes, filled: false, open: true});
  }
  return {bands: bands.map(b => {
    const filledTimes = b.samples.filter(s => s.filled).map(s => s.minutes).sort((x, y) => x - y);
    return {
      band: b.band, samples: b.samples, count: b.samples.length,
      filledCount: filledTimes.length,
      median: filledTimes.length ? filledTimes[Math.floor(filledTimes.length / 2)] : null,
      enough: b.samples.length >= MIN_SAMPLES,
    };
  }), skipped};
}

// How often an offer of this size actually finished within `withinMinutes`, from the player's own
// history. Returns null -- never a guess -- when the band is too thin or the inputs are unusable, so
// the caller keeps using the volume estimate and says so.
export function fillChance(model, quantity, volumeEntry, withinMinutes) {
  if (!model || !(quantity > 0) || !(withinMinutes > 0) || !volumeEntry) return null;
  const liquidity = Math.min(volumeEntry.highPriceVolume || 0, volumeEntry.lowPriceVolume || 0);
  if (!(liquidity > 0)) return null;
  const band = model.bands[bandFor(quantity / liquidity)];
  if (!band || !band.enough) return null;
  // An offer still running when last seen says nothing about a window longer than it was up for, so
  // it is left out of that window's denominator rather than counted as either outcome.
  const usable = band.samples.filter(s => s.filled || s.gaveUp || s.minutes >= withinMinutes);
  if (usable.length < MIN_SAMPLES) return null;
  const succeeded = usable.filter(s => s.filled && s.minutes <= withinMinutes).length;
  return {
    probability: succeeded / usable.length,
    samples: usable.length,
    medianMinutes: band.median,
    band: band.band,
  };
}

// One plain sentence for a suggestion's reasoning. Says how many of the player's own offers it is
// based on, so a thin-but-usable band reads as the weak evidence it is. Returns null when there is
// nothing trustworthy to say.
export function fillChanceSentence(chance, withinMinutes) {
  if (!chance) return null;
  const hours = withinMinutes / 60;
  const window = hours >= 1 ? `${hours % 1 === 0 ? hours : hours.toFixed(1)} hour${hours === 1 ? '' : 's'}` : `${Math.round(withinMinutes)} minutes`;
  return `Of your own past offers this size relative to the item's trading, ${Math.round(chance.probability * 100)}% finished within ${window} (${chance.samples} offers, typically ${chance.medianMinutes < 90 ? `${Math.round(chance.medianMinutes)} minutes` : `${(chance.medianMinutes / 60).toFixed(1)} hours`}). That is your own record, not a forecast.`;
}

// The same idea applied to predicted time: how far the volume estimate sat from reality in this
// band, for tools that want to show both.
export function bandComparison(model, buckets, offers) {
  return model.bands.map(b => ({band: b.band, samples: b.samples, medianRealised: b.median}));
}
