import {bucketAt} from './fillCalibration.mjs';
import {isMarginCheck} from './store.mjs';
import {SHARE_BANDS, bandFor} from './fillModel.mjs';

// A local preview of what EVI WOULD share if a future, opt-in "pool fill data" feature existed
// (PREMIUM-CONCEPT.md §14). Nothing here sends anything anywhere, and no such feature exists: this
// only answers, in advance and on the player's own machine, "what exactly would leave my PC?" --
// so that question is settled by something the player can read before any sharing is ever built,
// not by a promise made afterwards.
//
// Each record describes how one offer went, in terms that are useful for fill modelling and useless
// for identifying anyone:
//   * the item and side, and the UTC day it was placed (never the time of day);
//   * its price relative to that hour's market, as a percentage (never the price itself);
//   * its size as a band of that hour's traded volume, the same bands the fill model uses (never
//     the quantity);
//   * whether it filled, gave up or is still open, the share filled to the nearest 10%, and how long
//     it took as a coarse band.
// No account, no offer ID, no pairing key, no exact prices, quantities or times, no profit.
//
// Offers are left out, and counted as left out with the reason, rather than described with a
// guess: margin checks (a probe says nothing about trading), offers not watched from placement
// (their start time is unknown), and offers whose hour is missing from the price archive or had no
// usable market price or volume. A missing reading is never filled in.

const TIME_BANDS = [
  {label: 'under 5 min', max: 5},
  {label: '5-60 min', max: 60},
  {label: '1-4 h', max: 240},
  {label: '4-12 h', max: 720},
  {label: '12-24 h', max: 1440},
  {label: 'over 24 h', max: Infinity},
];

export function timeBand(minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  return TIME_BANDS.find(b => minutes < b.max).label;
}

const isBuy = o => ['BUYING', 'BOUGHT', 'CANCELLED_BUY'].includes(o.state);

export function sharePreview(offers, buckets) {
  const records = [];
  const skipped = {marginCheck: 0, notWatchedFromStart: 0, hourNotArchived: 0, noMarketReading: 0};
  for (const o of offers || []) {
    if (!o || !Number.isFinite(o.itemId)) continue;
    if (isMarginCheck(o)) { skipped.marginCheck++; continue; }
    if (!o.knownStart || !Number.isFinite(o.firstSeen)) { skipped.notWatchedFromStart++; continue; }
    const hour = bucketAt(buckets, o.firstSeen);
    if (!hour) { skipped.hourNotArchived++; continue; }
    const entry = hour.d[String(o.itemId)];
    const [high, highVol, low, lowVol] = entry || [];
    const liquidity = Math.min(highVol || 0, lowVol || 0);
    const offered = o.total > 0 ? o.total : o.filled;
    // Both sides of the market are needed for a midpoint; a one-sided hour is not guessed at.
    if (!(high > 0) || !(low > 0) || !(liquidity > 0) || !(offered > 0) || !(o.price > 0)) { skipped.noMarketReading++; continue; }
    const mid = (high + low) / 2;
    const cancelled = typeof o.state === 'string' && o.state.startsWith('CANCELLED');
    const complete = o.filled >= offered && o.completedAt != null;
    const outcome = complete ? 'filled' : cancelled ? 'gave up' : 'open';
    const endedAt = complete ? o.completedAt : cancelled ? (o.updated ?? null) : null;
    records.push({
      itemId: o.itemId,
      side: isBuy(o) ? 'buy' : 'sell',
      placedDay: new Date(o.firstSeen).toISOString().slice(0, 10),
      priceVsMarketPct: Math.round((o.price / mid - 1) * 1000) / 10,
      size: SHARE_BANDS[bandFor(offered / liquidity)].label,
      outcome,
      filledShare: Math.round(Math.min(1, (o.filled || 0) / offered) * 10) / 10,
      took: endedAt != null ? timeBand((endedAt - o.firstSeen) / 60000) : null,
    });
  }
  records.sort((a, b) => a.placedDay < b.placedDay ? -1 : a.placedDay > b.placedDay ? 1 : a.itemId - b.itemId);
  return {sentAnywhere: false, records, skipped};
}
