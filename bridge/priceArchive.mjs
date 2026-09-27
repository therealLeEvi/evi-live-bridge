import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {userAgent} from './userAgent.mjs';

// Optional background job: keeps a local archive of the OSRS Wiki's price averages for every item,
// as the data a backtester and any future prediction model are measured against. The Wiki's own
// /timeseries only keeps 365 points per item, so without an archive the past quickly becomes
// unavailable -- and unlike /timeseries, what is kept here is every item at once.
//
// Two resolutions, each switched on separately because they cost very differently:
//
//   1h -- hourly averages, ~3,000 items per bucket, about 30 KB gzip (measured 2026-09-17), so
//         roughly 22 MB a month. Suits trades lasting hours to a day, which is what EVI ranks for.
//   5m -- five-minute averages, ~1,300 items per bucket, about 11 KB gzip (measured 2026-09-18).
//         288 buckets a day is roughly 95 MB a month, over four times the hourly cost, and a full
//         90-day backfill is ~26,000 requests. What it buys is timing: an hourly bucket cannot say
//         whether an offer filled in the first five minutes or the last fifty, which is exactly the
//         question the fill model and the relist timing turn on.
//
// Both are off by default and switched on from the scanner (data/settings.json), since this is a
// background network and disk job not every user wants. Deliberately light regardless of how many
// streams are on: ONE Wiki request at a time across all of them, at least GAP_MS apart while
// catching up. The hourly stream is always served first -- it is the cheaper one and the one the
// backtester reads -- so switching 5m on can never starve it.
//
// How far back each goes was measured rather than assumed: /5m answers with real data at least two
// years back (probed 2026-09-18 at 1h/1d/7d/30d/90d/180d/365d/2y, every one a 200 with ~1,300
// items), so this backfills history rather than only accumulating it.
//
// Files: data/price-archive/<step>-YYYY-MM.jsonl.gz -- concatenated gzip members, one per bucket,
// each a JSON line {ts, d:{itemId:[avgHighPrice, highPriceVolume, avgLowPrice, lowPriceVolume]}}
// (ts = the bucket's start, unix seconds, as the Wiki labels it). A sidecar <step>-YYYY-MM.idx
// lists stored ts values so startup doesn't decompress everything. Nulls are kept as null, never
// filled in.
const HOUR = 3600;
const GAP_MS = 2500;          // between requests while backfilling
const SETTLE_S = 5 * 60;      // wait this long after a bucket ends before asking for it
const ERROR_BACKOFF_MS = 5 * 60 * 1000;

// Ordered: whichever stream comes first here is served first when both have work to do.
export const STEPS = {
  '1h': {seconds: HOUR, url: 'https://prices.runescape.wiki/api/v1/osrs/1h?timestamp=', maxBackfillDays: 90},
  '5m': {seconds: 300, url: 'https://prices.runescape.wiki/api/v1/osrs/5m?timestamp=', maxBackfillDays: 90},
};

async function wikiFetch(url) {
  const r = await fetch(url, {headers: {'User-Agent': userAgent('price archive')},
    signal: AbortSignal.timeout(20000), redirect: 'error'});
  if (!r.ok) throw new Error('Wiki returned HTTP ' + r.status);
  const text = await r.text();
  if (text.length > 10000000) throw new Error('Wiki response too large');
  return text;
}

const monthOf = ts => new Date(ts * 1000).toISOString().slice(0, 7);

export function compactBucket(json) {
  const d = {};
  for (const [id, x] of Object.entries(json?.data || {})) {
    if (!x) continue;
    d[id] = [x.avgHighPrice ?? null, x.highPriceVolume ?? 0, x.avgLowPrice ?? null, x.lowPriceVolume ?? 0];
  }
  return {ts: json?.timestamp, d};
}

// Reads every archived bucket between fromTs and toTs (inclusive, unix seconds), oldest first, with
// duplicates (a retried write) collapsed. For the backtester and tests. `step` selects the
// resolution and defaults to hourly, so every existing caller reads exactly what it always did.
export function readArchive(dir, fromTs = 0, toTs = Infinity, step = '1h') {
  if (!STEPS[step]) throw new Error('Unknown archive step: ' + step);
  const archiveDir = path.join(dir, 'price-archive');
  if (!fs.existsSync(archiveDir)) return [];
  const byTs = new Map();
  const pattern = new RegExp('^' + step + '-\\d{4}-\\d{2}\\.jsonl\\.gz$');
  // Each bucket is filed under its own month, so months wholly before fromTs cannot hold anything
  // wanted -- skipping them keeps a read of the last few hours from decompressing months of history.
  const firstMonth = fromTs > 0 && Number.isFinite(fromTs) ? monthOf(fromTs) : '';
  for (const f of fs.readdirSync(archiveDir).filter(f => pattern.test(f) && f.slice(step.length + 1, step.length + 8) >= firstMonth).sort()) {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(archiveDir, f))).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const b = JSON.parse(line);
      if (b.ts >= fromTs && b.ts <= toTs) byTs.set(b.ts, b);
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

// onStored(step, bucket) is called after each newly stored bucket -- the crash watch reads the
// five-minute stream this way instead of fetching anything itself. A failure in it never affects
// the archive.
export function createPriceArchive({dir, fetchText = wikiFetch, now = () => Date.now(), log = () => {}, gapMs = GAP_MS, onStored = () => {}} = {}) {
  const archiveDir = path.join(dir, 'price-archive');
  const settingsFile = path.join(dir, 'settings.json');
  // fiveMinute is a nested block of its own rather than more top-level keys, so an existing
  // settings.json written before it existed loads unchanged.
  //
  // ON BY DEFAULT since 27 Sept 2026. It was off, and the only thing that could switch it on was a
  // route behind the browser scanner's cookie -- and the scanner is in neither published repository.
  // The consequence was that no Plugin Hub user had ever had an archive, so three of EVI's buy-side
  // checks read an empty one and correctly, silently did nothing: thinMarket ("can this price even be
  // bought again", which needs MIN_HOURS = 72 hours of it), the crash watch, and the correlation check.
  // They were tested, documented, and disconnected in the only configuration anyone actually ran.
  //
  // Flipping the default is safe for anyone who deliberately switched it off, because `saved` is
  // spread over these defaults below: a stored `enabled: false` still wins. And settings.json only ever
  // gains a priceArchive block through configure(), so the new default reaches exactly the installs
  // that never made a choice.
  //
  // The windows are sized for the checks and for the Wiki, not for research. Per-client politeness was
  // already settled on 20 Sept: the rule of thumb other plugin authors use is about one request a
  // second, this backfills one at a time GAP_MS apart (0.4 a second, deliberately under it), and the
  // steady state is around 0.06 a second. None of that changes here. What does change is how many
  // installs backfill at all, so the default windows are the smallest ones that do the job:
  //
  //   * 4 days of hourly -- 96 requests, about four minutes -- clears thinMarket's 72-hour bar in a
  //     single pass with margin to spare. It reads a 14-day window and simply uses what is there.
  //   * the five-minute stream tracks forward only, with no backfill. It exists for the crash watch,
  //     which looks at the last 45 minutes, so history buys nothing: it goes live within minutes of
  //     the bridge starting and costs one request every five minutes thereafter.
  //
  // That is ~96 requests once, against the ~624 a 14-day-plus-one-day default would have cost, then
  // about 13 an hour forever. The private backtester wants far more and says so in its own stored
  // settings, which override these.
  let settings = {enabled: true, backfillDays: 4, fiveMinute: {enabled: true, backfillDays: 0}};
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).priceArchive || {};
    settings = {...settings, ...saved, fiveMinute: {...settings.fiveMinute, ...(saved.fiveMinute || {})}};
  } catch {}
  // One stored-ts set per resolution; a 5m bucket and an hour that happen to share a timestamp are
  // completely different rows, so they must never share a set.
  const stored = {'1h': new Set(), '5m': new Set()};
  let timer = null, running = false, lastFetchAt = null, lastError = null, busy = false;
  // The last RECENT_HOURS hourly buckets, kept in memory for the live sell-support check, which runs on
  // every suggestion and must not read files to do it. Filled from disk once, on first use, then kept
  // current as each new hour is stored.
  let recent = null;
  const RECENT_HOURS = 26;
  function keepRecent(bucket) {
    recent.set(bucket.ts, bucket);
    const cutoff = Math.floor(now() / 1000) - RECENT_HOURS * HOUR;
    for (const ts of recent.keys()) if (ts < cutoff) recent.delete(ts);
  }
  // Hourly buckets from fromTs on, oldest first. Empty (never an error) when the archive is off or
  // has nothing for those hours; the caller then relies on its own data exactly as before.
  function recentHourly(fromTs) {
    if (!recent) {
      recent = new Map();
      try { for (const b of readArchive(dir, Math.floor(now() / 1000) - RECENT_HOURS * HOUR)) keepRecent(b); } catch {}
    }
    return [...recent.values()].filter(b => b.ts >= fromTs).sort((a, b) => a.ts - b.ts);
  }

  // Which settings block drives a given stream.
  const streamSettings = step => step === '1h'
    ? {enabled: settings.enabled, backfillDays: settings.backfillDays}
    : {enabled: settings.fiveMinute.enabled, backfillDays: settings.fiveMinute.backfillDays};
  const anyEnabled = () => Object.keys(STEPS).some(s => streamSettings(s).enabled);

  function loadIndex() {
    for (const s of Object.values(stored)) s.clear();
    if (!fs.existsSync(archiveDir)) return;
    for (const f of fs.readdirSync(archiveDir).filter(f => f.endsWith('.idx'))) {
      const step = f.slice(0, 2);
      if (!stored[step]) continue;
      for (const line of fs.readFileSync(path.join(archiveDir, f), 'utf8').split('\n')) if (/^\d+$/.test(line)) stored[step].add(Number(line));
    }
  }
  function saveSettings() {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    all.priceArchive = settings;
    fs.writeFileSync(settingsFile, JSON.stringify(all, null, 2));
  }
  // Newest complete bucket first (most useful soonest), then back through the backfill window.
  function nextMissingFor(stepName) {
    const {enabled, backfillDays} = streamSettings(stepName);
    if (!enabled) return null;
    const {seconds, maxBackfillDays} = STEPS[stepName];
    const newest = Math.floor((now() / 1000 - SETTLE_S) / seconds) * seconds - seconds;
    const oldest = newest - Math.max(0, Math.min(maxBackfillDays, backfillDays)) * 24 * HOUR;
    for (let ts = newest; ts >= oldest; ts -= seconds) if (!stored[stepName].has(ts)) return ts;
    return null;
  }
  // The stream to serve on this tick: hourly before five-minute, so the cheap stream the backtester
  // reads can never be starved by a 26,000-request 5m backfill running behind it.
  function nextMissing() {
    for (const stepName of Object.keys(STEPS)) {
      const ts = nextMissingFor(stepName);
      if (ts !== null) return {step: stepName, ts};
    }
    return null;
  }
  // How long until any enabled stream could have something new -- the finest resolution that is on.
  function msUntilNextBucket() {
    const t = now() / 1000;
    let soonest = Infinity;
    for (const stepName of Object.keys(STEPS)) {
      if (!streamSettings(stepName).enabled) continue;
      const {seconds} = STEPS[stepName];
      soonest = Math.min(soonest, (Math.floor((t - SETTLE_S) / seconds) + 1) * seconds + SETTLE_S);
    }
    if (soonest === Infinity) return 60000;
    return Math.max(60000, (soonest - t) * 1000 + 1000);
  }
  async function step() {
    if (busy) return null;
    const next = nextMissing();
    if (next === null) return null;
    const {step: stepName, ts} = next;
    const {url} = STEPS[stepName];
    busy = true;
    try {
      const bucket = compactBucket(JSON.parse(await fetchText(url + ts)));
      // The Wiki can answer with a different bucket than asked for; store what it says it is, and
      // mark the asked-for bucket as done so an empty/odd one isn't re-requested forever.
      if (Number.isSafeInteger(bucket.ts) && Object.keys(bucket.d).length && !stored[stepName].has(bucket.ts)) {
        fs.mkdirSync(archiveDir, {recursive: true});
        const base = path.join(archiveDir, stepName + '-' + monthOf(bucket.ts));
        fs.appendFileSync(base + '.jsonl.gz', zlib.gzipSync(JSON.stringify(bucket) + '\n'));
        fs.appendFileSync(base + '.idx', bucket.ts + '\n');
        stored[stepName].add(bucket.ts);
        if (stepName === '1h' && recent) keepRecent(bucket);
        try { onStored(stepName, bucket); } catch (e) { log('Price archive listener: ' + e.message); }
      }
      if (!stored[stepName].has(ts)) { fs.mkdirSync(archiveDir, {recursive: true}); fs.appendFileSync(path.join(archiveDir, stepName + '-' + monthOf(ts) + '.idx'), ts + '\n'); stored[stepName].add(ts); }
      lastFetchAt = now(); lastError = null;
      return ts;
    } catch (e) {
      lastError = e.message; log('Price archive (' + stepName + '): ' + e.message);
      throw e;
    } finally { busy = false; }
  }
  function schedule(ms) { if (running) { timer = setTimeout(tick, ms); timer.unref?.(); } }
  async function tick() {
    timer = null;
    if (!running || !anyEnabled()) return;
    try { const ts = await step(); schedule(ts === null ? msUntilNextBucket() : gapMs); }
    catch { schedule(ERROR_BACKOFF_MS); }
  }
  function start() { if (running) return; running = true; loadIndex(); schedule(Math.min(1000, gapMs)); }
  function stop() { running = false; if (timer) clearTimeout(timer); timer = null; }
  function configure({enabled, backfillDays, fiveMinute} = {}) {
    const days = (value, max) => {
      if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`backfillDays must be 0-${max}`);
      return value;
    };
    if (enabled !== undefined) { if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false'); settings.enabled = enabled; }
    if (backfillDays !== undefined) settings.backfillDays = days(backfillDays, STEPS['1h'].maxBackfillDays);
    if (fiveMinute !== undefined) {
      if (fiveMinute === null || typeof fiveMinute !== 'object') throw new Error('fiveMinute must be an object');
      if (fiveMinute.enabled !== undefined) {
        if (typeof fiveMinute.enabled !== 'boolean') throw new Error('enabled must be true or false');
        settings.fiveMinute.enabled = fiveMinute.enabled;
      }
      if (fiveMinute.backfillDays !== undefined) settings.fiveMinute.backfillDays = days(fiveMinute.backfillDays, STEPS['5m'].maxBackfillDays);
    }
    saveSettings();
    // Any pending wait is now stale: it was calculated for the streams that were on a moment ago.
    // With the hourly archive caught up, that wait can be nearly an hour, so switching the 5m stream
    // on without cancelling it left the new work sitting untouched until the next hour boundary --
    // observed live the first time it was enabled. Cancel and re-plan from the new settings.
    if (running && anyEnabled() && !busy) { if (timer) clearTimeout(timer); timer = null; schedule(Math.min(1000, gapMs)); }
    return status();
  }
  // Per-stream counts, plus the estimated remaining requests for whatever is still catching up --
  // a 5m backfill is thousands of requests and a user switching it on deserves to see that rather
  // than a bare "catching up".
  function streamStatus(stepName) {
    const {enabled, backfillDays} = streamSettings(stepName);
    const kept = [...stored[stepName]];
    const missing = nextMissingFor(stepName);
    let remaining = 0;
    if (enabled) {
      const {seconds, maxBackfillDays} = STEPS[stepName];
      const newest = Math.floor((now() / 1000 - SETTLE_S) / seconds) * seconds - seconds;
      const oldest = newest - Math.max(0, Math.min(maxBackfillDays, backfillDays)) * 24 * HOUR;
      for (let ts = newest; ts >= oldest; ts -= seconds) if (!stored[stepName].has(ts)) remaining++;
    }
    return {enabled, backfillDays, stored: kept.length,
      oldest: kept.length ? Math.min(...kept) : null, newest: kept.length ? Math.max(...kept) : null,
      catchingUp: missing !== null, remaining};
  }
  function status() {
    let bytes = 0;
    try { for (const f of fs.readdirSync(archiveDir)) bytes += fs.statSync(path.join(archiveDir, f)).size; } catch {}
    const hourly = streamStatus('1h'), fiveMinute = streamStatus('5m');
    // The original hourly fields stay exactly where they were, so the scanner and every existing
    // caller keep working; the per-stream detail is additive.
    return {enabled: hourly.enabled, backfillDays: hourly.backfillDays, hoursStored: hourly.stored,
      oldest: hourly.oldest, newest: hourly.newest,
      bytes, lastFetchAt, lastError, catchingUp: hourly.catchingUp || fiveMinute.catchingUp,
      steps: {'1h': hourly, '5m': fiveMinute}};
  }
  loadIndex();
  return {start, stop, configure, status, step, recentHourly};
}
