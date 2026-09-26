// Crash alerts: an item's price collapsing right now, measured against the item's own recent
// behaviour and stated without predicting what happens next.
//
// Prompted by Brine sabre on 19 Sep 2026 (~465k for days, then 49 sold at ~324k in five minutes and a
// steady stream at a flat 300,000 after) and by the player's own buy offer for it, which nothing in
// EVI warned about. What these alerts deliberately do NOT do is the thing competing tools' dump
// alerts do: assume a crashed price rebounds. When a crash is a permanent repricing, that is the
// adamant-arrows loss with a notification attached. Each alert instead carries what
// tools/crash-recovery.mjs measured over 90 days of history for crashes of the same kind -- the share
// that came back and the share that fell further -- and says plainly that it is no forecast.
//
// A crash, per item, using exactly the rules the measurement used:
//   * both sides of the market are down -- what buyers pay AND what sellers accept -- by at least
//     MIN_DROP and by Z of the item's own typical hourly deviations from its 24-hour average. One
//     side alone is not enough: an hour dominated by instant sells looks like a 40% "crash" on any
//     item with a wide spread although nothing moved; the first version of the measurement fell for
//     exactly that;
//   * on real volume: VOL_RATIO times the item's own average for the time window, so a single
//     misclick (Brine sabre also printed one sale at 46,464) is not a crash;
//   * on an item that trades in most hours, so the baseline means something.
// Read from the five-minute archive over the last WINDOW_MINUTES, so it needs that stream switched
// on; without it there are no crash alerts at all, and the scanner says so rather than implying
// the market is calm.

export const CRASH = {z: 4, minDrop: 0.10, volRatio: 3, windowMinutes: 30};
const BASE_HOURS = 24, WEEK_HOURS = 168, HOUR = 3600;

// tools/crash-recovery.mjs, run 19 Sep 2026 over the 90 days of hourly archive (default rules above):
// 548 crashes with a day of data after them. `back` = share that had made back at least 90% of the
// drop a day later (on the price buyers pay); `lower` = share lower still than at the crash. The
// dearest band is a small sample, and says so.
export const CRASH_MEASURED = {
  measuredOn: '2026-09-19', days: 90,
  bands: [
    {label: 'items under 10k', max: 1e4, n: 432, back: 0.57, lower: 0.06},
    {label: 'items from 10k to 1m', max: 1e6, n: 98, back: 0.56, lower: 0.06},
    {label: 'items over 1m', max: Infinity, n: 18, back: 0.22, lower: 0.17},
  ],
  // Share of crashes still at least half the drop down an hour later -- the rest were over before
  // an alert could matter.
  stillDownAfterHour: 0.75,
};

// Per item and side: the 24-hour volume-weighted average up to `endTs`, and how far the item's hourly
// price normally strays from its own trailing 24-hour average over the week before (standard
// deviation of the log gap). hourly: archived 1h buckets, oldest first, covering at least
// BASE_HOURS + WEEK_HOURS before endTs. Items with too little history are left out, never guessed.
export function buildBaselines(hourly, endTs) {
  const t0 = endTs - (BASE_HOURS + WEEK_HOURS) * HOUR;
  const n = BASE_HOURS + WEEK_HOURS;
  const grid = new Map();
  for (const b of hourly || []) {
    if (!(b.ts >= t0 && b.ts < endTs)) continue;
    const i = (b.ts - t0) / HOUR;
    for (const [id, [hi, hv, lo, lv]] of Object.entries(b.d)) {
      let s = grid.get(id);
      if (!s) { s = {hi: new Float64Array(n).fill(NaN), hv: new Float64Array(n), lo: new Float64Array(n).fill(NaN), lv: new Float64Array(n)}; grid.set(id, s); }
      if (hi > 0 && hv > 0) { s.hi[i] = hi; s.hv[i] = hv; }
      if (lo > 0 && lv > 0) { s.lo[i] = lo; s.lv[i] = lv; }
    }
  }
  const out = new Map();
  for (const [id, s] of grid) {
    let traded = 0, units = 0;
    for (let i = BASE_HOURS; i < n; i++) { const u = s.hv[i] + s.lv[i]; units += u; if (u > 0) traded++; }
    if (traded < WEEK_HOURS * 0.7) continue;
    const side = key => {
      const p = s[key], v = s[key === 'hi' ? 'hv' : 'lv'];
      const avg = (from, to) => { let gp = 0, u = 0, h = 0; for (let j = from; j < to; j++) if (v[j] > 0) { gp += p[j] * v[j]; u += v[j]; h++; } return h >= BASE_HOURS / 2 ? gp / u : NaN; };
      let sum = 0, sq = 0, c = 0;
      for (let i = BASE_HOURS; i < n; i++) {
        if (!(v[i] > 0)) continue;
        const b = avg(i - BASE_HOURS, i);
        if (!(b > 0)) continue;
        const d = Math.log(p[i] / b); sum += d; sq += d * d; c++;
      }
      const base = avg(n - BASE_HOURS, n);
      return c >= 24 && base > 0 ? {base, sd: Math.sqrt(Math.max(1e-12, sq / c - (sum / c) ** 2))} : null;
    };
    const hi = side('hi'), lo = side('lo');
    if (hi && lo) out.set(Number(id), {hi, lo, hourlyUnits: units / WEEK_HOURS});
  }
  return out;
}

// Which items are crashing in the given five-minute buckets (the last WINDOW_MINUTES of them).
function windowSums(fiveMinute) {
  const sums = new Map();
  for (const b of fiveMinute || []) for (const [id, [hi, hv, lo, lv]] of Object.entries(b.d)) {
    let s = sums.get(id);
    if (!s) { s = {hiGp: 0, hv: 0, loGp: 0, lv: 0}; sums.set(id, s); }
    if (hi > 0 && hv > 0) { s.hiGp += hi * hv; s.hv += hv; }
    if (lo > 0 && lv > 0) { s.loGp += lo * lv; s.lv += lv; }
  }
  return sums;
}

export function detectCrashes(baselines, fiveMinute, rules = CRASH) {
  const sums = windowSums(fiveMinute);
  const found = [];
  const floor = Math.log(1 - rules.minDrop);
  for (const [key, s] of sums) {
    const itemId = Number(key), base = baselines.get(itemId);
    if (!base || !(s.hv > 0) || !(s.lv > 0)) continue;
    const hi = s.hiGp / s.hv, lo = s.loGp / s.lv;
    const dHi = Math.log(hi / base.hi.base), dLo = Math.log(lo / base.lo.base);
    if (!(dHi < floor && dLo < floor)) continue;
    if (dHi > -rules.z * base.hi.sd || dLo > -rules.z * base.lo.sd) continue;
    const units = s.hv + s.lv, normal = base.hourlyUnits * rules.windowMinutes / 60;
    if (units < rules.volRatio * normal) continue;
    found.push({itemId, hi: Math.round(hi), lo: Math.round(lo), baseHi: Math.round(base.hi.base), baseLo: Math.round(base.lo.base),
      drop: 1 - hi / base.hi.base, units, normalPerHour: base.hourlyUnits});
  }
  return found;
}

export const measuredBandFor = price => CRASH_MEASURED.bands.find(b => price < b.max);

const gp = x => Math.round(x).toLocaleString('en-US');
// One plain sentence per alert. `mine` says why the player is being told: an offer, stock held, or
// EVI's own current pick. Numbers are the ones measured; the history is quoted, never extrapolated.
export function crashMessage(c, {name, mine} = {}) {
  const band = measuredBandFor(c.baseHi);
  const perHour = c.normalPerHour >= 10 ? gp(c.normalPerHour) : c.normalPerHour.toFixed(1).replace(/\.0$/, '');
  const head = `${name || 'Item ' + c.itemId} is crashing: buyers are paying about ${gp(c.hi)} gp, ${Math.round(c.drop * 100)}% under its 24-hour average of ${gp(c.baseHi)} gp, with ${gp(c.units)} traded in the last ${CRASH.windowMinutes} minutes (normally about ${perHour} an hour).`;
  const why = mine ? ` ${mine}` : '';
  const history = band ? ` Cause unknown. Of ${band.n} crashes like this in ${band.label} over the last ${CRASH_MEASURED.days} days, ${Math.round(band.back * 100)}% had made back most of the drop a day later and ${Math.round(band.lower * 100)}% were lower still${band.n < 30 ? ' (a small sample)' : ''}. That is history, not a forecast for this one.` : ' Cause unknown.';
  return head + why + history;
}

// Live state: baselines rebuilt at most hourly, the last WINDOW_MINUTES of five-minute buckets kept
// in memory, alerts kept for a day after they end, and every alert start and end recorded so these
// calls can be scored later like everything else EVI claims.
//
// Once an alert is running it is judged against the price from BEFORE the crash, not the rolling
// average: crash hours carry so much volume that a few of them drag the 24-hour average down to meet
// the new price, and the alert would "end" with the price still on the floor. It ends when buyers are
// paying within half the minimum drop of that old price again, or after MAX_ALERT_HOURS, when it is
// marked as still down rather than recovered. A window with no buying at all changes nothing.
const MAX_ALERT_HOURS = 24;
export function createCrashWatch({loadHourly, loadFiveMinute, log = () => {}, record = () => {}, now = () => Date.now()} = {}) {
  let baselines = null, baselinesFor = null, window = null;
  const alerts = new Map(); // itemId -> {crash, since, updated, ended, endedBecause}
  function ensureBaselines() {
    const hourStart = Math.floor(now() / 3600000) * 3600;
    if (baselines && baselinesFor === hourStart) return baselines;
    try { baselines = buildBaselines(loadHourly(hourStart - (BASE_HOURS + WEEK_HOURS + 1) * HOUR), hourStart); baselinesFor = hourStart; }
    catch (e) { log('Crash watch: ' + e.message); baselines = baselines || new Map(); }
    return baselines;
  }
  function end(id, a, t, because) {
    a.ended = t; a.endedBecause = because;
    record({event: 'crash-ended', at: t, itemId: id, because, hi: a.crash.hi, baseHi: a.crash.baseHi});
  }
  function addFiveMinute(bucket) {
    if (!window) { window = []; try { window.push(...(loadFiveMinute(Math.floor(now() / 1000) - CRASH.windowMinutes * 60) || [])); } catch {} }
    if (bucket && !window.some(b => b.ts === bucket.ts)) window.push(bucket);
    if (!window.length) return [];
    const newest = Math.max(...window.map(b => b.ts));
    window = window.filter(b => b.ts > newest - CRASH.windowMinutes * 60).sort((a, b) => a.ts - b.ts);
    const found = detectCrashes(ensureBaselines(), window);
    const t = now(), sums = windowSums(window);
    for (const c of found) {
      const a = alerts.get(c.itemId);
      if (a && !a.ended) continue;
      alerts.set(c.itemId, {crash: c, since: t, updated: t, ended: null, endedBecause: null});
      record({event: 'crash', at: t, ...c});
    }
    for (const [id, a] of alerts) {
      if (a.ended) { if (t - a.ended > 24 * 3600000) alerts.delete(id); continue; }
      const s = sums.get(String(id));
      if (s && s.hv > 0) {
        const hi = s.hiGp / s.hv;
        a.crash = {...a.crash, hi: Math.round(hi), lo: s.lv > 0 ? Math.round(s.loGp / s.lv) : a.crash.lo,
          drop: 1 - hi / a.crash.baseHi, units: s.hv + s.lv};
        a.updated = t;
        if (hi >= a.crash.baseHi * (1 - CRASH.minDrop / 2)) { end(id, a, t, 'recovered'); continue; }
      }
      if (t - a.since > MAX_ALERT_HOURS * 3600000) end(id, a, t, 'still down after a day');
    }
    return found;
  }
  const active = () => [...alerts.entries()].filter(([, a]) => !a.ended).map(([itemId, a]) => ({itemId, ...a}));
  const recent = () => [...alerts.entries()].map(([itemId, a]) => ({itemId, ...a})).sort((a, b) => b.since - a.since);
  const isCrashing = itemId => { const a = alerts.get(itemId); return a && !a.ended ? a.crash : null; };
  const status = () => ({watching: !!window && window.length > 0, windowBuckets: window ? window.length : 0,
    itemsWithBaseline: baselines ? baselines.size : 0});
  return {addFiveMinute, active, recent, isCrashing, status};
}
