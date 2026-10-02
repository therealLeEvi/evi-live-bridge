// Are two items really two bets, or the same bet twice?
//
// Several Grand Exchange slots filled with items that move together is one position wearing several
// hats: when it goes against you, it goes against all of them at once. EVI already refuses to
// suggest an item you have an active offer for, but that only catches the identical item -- nature
// runes and death runes are different item IDs and the same bet.
//
// Measured rather than guessed at, which rules out the obvious shortcut. Grouping by name ("both
// contain the word rune") would lump rune armour in with runecrafting runes, which are unrelated
// economically, and would miss pairs that genuinely move together with nothing in common in their
// names. The price archive already holds months of hourly prices for every item, so the correlation
// can simply be computed.
//
// Correlation is on log RETURNS, not on prices. Two items whose prices both happen to drift upward
// over 90 days show a high price correlation while their day-to-day moves are unrelated; returns
// ask the question that matters -- when one moves, does the other move with it?

// Measured on 90 days of archive, and the resolution turned out to decide whether this works at all.
// On HOURLY returns everything is uncorrelated -- 6,536 random pairs gave a median of 0.003 and a
// maximum of 0.259, with Rune platebody/Rune scimitar reaching only 0.229. Hourly moves are
// dominated by thin trading and bid-ask bounce, so no threshold would ever have fired.
//
// On SIX-HOURLY returns, which is roughly how long a flip is actually held, the signal separates
// cleanly: 2,929 random pairs gave a median of 0.013 and a 99th percentile of 0.199, only 0.24% of
// pairs reached 0.3 and 0.03% reached 0.5 -- while Rune platebody/Rune scimitar sits at 0.730.
//
// The same measurement destroyed the shortcut this exists to avoid. Grouping by name would have
// treated every "rune" as one family, and the data says otherwise: Nature rune/Death rune is 0.093,
// Nature rune/Chaos rune is -0.032, and Rune platebody/Nature rune is -0.053. Runes do not move
// together at all; rune EQUIPMENT does. A name-based family check would have blocked the wrong
// trades and missed the right ones.
export const CORRELATION_STEP_SECONDS = 6 * 3600;

// HOW THE SIX-HOUR SERIES IS BUILT, and why it is aggregated rather than sampled.
//
// FOUND 2 OCT 2026: this check had never once fired in practice, because the server built
// its six-hour series by taking every 6th HOURLY bucket. That is sampling, not aggregating, and it
// keeps the full single-hour bid-ask bounce -- the exact noise the measurement above chose six hours
// to average away. It simply uses a sixth as many observations of the same noisy quantity.
//
// Measured both ways over the same 90 days:
//
//   pair                              sampled every 6th hour   aggregated into 6h blocks
//   Rune platebody / Rune scimitar                     0.198                       0.627
//   Rune platelegs / Rune platebody                    0.136                       0.592
//   Fire rune / Air rune                               0.205                       0.327
//   Nature rune / Death rune                           0.029                      -0.035
//   Rune platebody / Nature rune                      -0.072                      -0.136
//
// So a genuine equipment family read 0.198 against a 0.5 threshold and could never clear it, while
// the only pairs that DID clear it under sampling were low-overlap noise (Turquoise robe top / Iron
// javelin at 0.702 on an overlap of 78). The calibration was right and the wiring nullified it.
//
// Aggregated, the numbers match what the comment above records (0.627 here against 0.730 then --
// a different 90-day window, not a different method), and the finding that justified rejecting a
// name-based family check SURVIVES: runes still do not move together, rune equipment does.
export function aggregateToStep(buckets, stepSeconds = CORRELATION_STEP_SECONDS) {
  const blocks = new Map();
  for (const b of buckets || []) {
    if (!b || !Number.isFinite(b.ts)) continue;
    const blk = Math.floor(b.ts / stepSeconds);
    if (!blocks.has(blk)) blocks.set(blk, new Map());
    const into = blocks.get(blk);
    for (const [id, r] of Object.entries(b.d || {})) {
      if (!r) continue;
      if (!into.has(id)) into.set(id, {hi: [], lo: []});
      const t = into.get(id);
      if (Number.isFinite(r[0]) && r[0] > 0) t.hi.push(r[0]);
      if (Number.isFinite(r[2]) && r[2] > 0) t.lo.push(r[2]);
    }
  }
  const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  // Each side is averaged over the hours in the block, then the block is emitted at its own start
  // timestamp so consecutive blocks are exactly stepSeconds apart and returnsFor's spacing check --
  // which is what silently rejected everything before -- holds by construction.
  return [...blocks.keys()].sort((a, b) => a - b).map(blk => {
    const d = {};
    for (const [id, t] of blocks.get(blk)) {
      const hi = mean(t.hi), lo = mean(t.lo);
      if (hi === null && lo === null) continue;
      d[id] = [hi ?? lo, 0, lo ?? hi, 0];
    }
    return {ts: blk * stepSeconds, d};
  });
}
// Chosen from the null distribution above: 0.03% of unrelated pairs reach it, so it effectively
// never fires by accident, while a genuine equipment family clears it comfortably.
export const CORRELATED_THRESHOLD = 0.5;
export const MIN_OVERLAP = 30;        // points of shared history before a correlation means anything

// Log returns from an item's midpoints, keyed by the timestamp of the LATER point in each pair, so
// two items' returns can be aligned on the hour they describe. A gap in the archive breaks the pair
// rather than spanning it -- a "return" across a missing day is not a return.
export function returnsFor(buckets, itemId, stepSeconds = 3600) {
  const key = String(itemId), out = new Map();
  let prev = null;
  for (const b of buckets) {
    const e = b.d?.[key];
    const hi = e && Number.isFinite(e[0]) && e[0] > 0 ? e[0] : null;
    const lo = e && Number.isFinite(e[2]) && e[2] > 0 ? e[2] : null;
    const mid = hi && lo ? (hi + lo) / 2 : (hi ?? lo);
    if (!(mid > 0)) { prev = null; continue; }
    if (prev && b.ts - prev.ts === stepSeconds) out.set(b.ts, Math.log(mid / prev.mid));
    prev = {ts: b.ts, mid};
  }
  return out;
}

// Pearson correlation over the hours both items actually traded. Returns null -- never a number --
// when they share too little history, since a correlation from a handful of hours is noise with a
// decimal point on it.
export function correlationOf(returnsA, returnsB, {minOverlap = MIN_OVERLAP} = {}) {
  const xs = [], ys = [];
  for (const [ts, a] of returnsA) {
    const b = returnsB.get(ts);
    if (b !== undefined) { xs.push(a); ys.push(b); }
  }
  if (xs.length < minOverlap) return null;
  const n = xs.length;
  const mx = xs.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (!(dx > 0) || !(dy > 0)) return null;   // one of them never moved: nothing to correlate
  return {correlation: num / Math.sqrt(dx * dy), overlap: n};
}

// A cache of per-item return series, since a suggestion compares one candidate against everything
// currently held and would otherwise rebuild the same series repeatedly.
// One sentence for a candidate that was held back, naming the item it duplicates. Says what was
// measured and over what, so it reads as evidence rather than a verdict.
export function correlationNote(hit, nameOf) {
  if (!hit) return null;
  const name = nameOf ? nameOf(hit.itemId) : null;
  return `Skipped: it has been moving with ${name || 'an item you already hold'} (correlation ${hit.correlation.toFixed(2)} over ${hit.overlap} six-hour periods of your price archive). Holding both is closer to one larger position than two separate trades.`;
}

export function createCorrelationIndex(buckets, {stepSeconds = CORRELATION_STEP_SECONDS} = {}) {
  const cache = new Map();
  const series = itemId => {
    const key = String(itemId);
    if (!cache.has(key)) cache.set(key, returnsFor(buckets, itemId, stepSeconds));
    return cache.get(key);
  };
  return {
    series,
    // The strongest correlation between the candidate and anything already held, with the item that
    // produced it, or null when nothing can be compared. Null means "no view", never "uncorrelated".
    strongestAgainst(itemId, heldIds, {minOverlap = MIN_OVERLAP} = {}) {
      const mine = series(itemId);
      let best = null;
      for (const other of heldIds || []) {
        if (String(other) === String(itemId)) continue;
        const r = correlationOf(mine, series(other), {minOverlap});
        if (!r) continue;
        if (!best || r.correlation > best.correlation) best = {...r, itemId: other};
      }
      return best;
    },
  };
}
