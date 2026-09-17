import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Optional background job: keeps a local archive of the OSRS Wiki's hourly price averages for every
// item, as the data a backtester and any future prediction model are measured against. Hourly
// buckets suit trades lasting hours to a day; the Wiki's own /timeseries only keeps 365 points per
// item, so without an archive the past quickly becomes unavailable.
//
// Off by default and switched on from the scanner (data/settings.json), since it's a background
// network and disk job not every user wants. Deliberately light: ONE Wiki request at a time, at
// least GAP_MS apart while catching up, then one request an hour. Each hour is ~3,000 items, about
// 30 KB gzip-compressed (measured 2026-09-17), so roughly 22 MB a month.
//
// Files: data/price-archive/1h-YYYY-MM.jsonl.gz -- concatenated gzip members, one per hour, each a
// JSON line {ts, d:{itemId:[avgHighPrice, highPriceVolume, avgLowPrice, lowPriceVolume]}} (ts = the
// bucket's start, unix seconds, as the Wiki labels it). A sidecar 1h-YYYY-MM.idx lists stored ts
// values so startup doesn't decompress everything. Nulls are kept as null, never filled in.
const HOUR = 3600;
const GAP_MS = 2500;          // between requests while backfilling
const SETTLE_S = 5 * 60;      // wait this long after an hour ends before asking for it
const ERROR_BACKOFF_MS = 5 * 60 * 1000;
const URL_1H = 'https://prices.runescape.wiki/api/v1/osrs/1h?timestamp=';

async function wikiFetch(url) {
  const r = await fetch(url, {headers: {'User-Agent': 'EVI-Live/3.0 (personal local OSRS market scanner; hourly price archive)'},
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

// Reads every archived hour between fromTs and toTs (inclusive, unix seconds), oldest first, with
// duplicates (a retried write) collapsed. For the backtester and tests.
export function readArchive(dir, fromTs = 0, toTs = Infinity) {
  const archiveDir = path.join(dir, 'price-archive');
  if (!fs.existsSync(archiveDir)) return [];
  const byTs = new Map();
  for (const f of fs.readdirSync(archiveDir).filter(f => /^1h-\d{4}-\d{2}\.jsonl\.gz$/.test(f)).sort()) {
    const text = zlib.gunzipSync(fs.readFileSync(path.join(archiveDir, f))).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      const b = JSON.parse(line);
      if (b.ts >= fromTs && b.ts <= toTs) byTs.set(b.ts, b);
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function createPriceArchive({dir, fetchText = wikiFetch, now = () => Date.now(), log = () => {}, gapMs = GAP_MS} = {}) {
  const archiveDir = path.join(dir, 'price-archive');
  const settingsFile = path.join(dir, 'settings.json');
  let settings = {enabled: false, backfillDays: 60};
  try { settings = {...settings, ...(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).priceArchive || {})}; } catch {}
  const stored = new Set();
  let timer = null, running = false, lastFetchAt = null, lastError = null, busy = false;

  function loadIndex() {
    stored.clear();
    if (!fs.existsSync(archiveDir)) return;
    for (const f of fs.readdirSync(archiveDir).filter(f => f.endsWith('.idx')))
      for (const line of fs.readFileSync(path.join(archiveDir, f), 'utf8').split('\n')) if (/^\d+$/.test(line)) stored.add(Number(line));
  }
  function saveSettings() {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
    all.priceArchive = settings;
    fs.writeFileSync(settingsFile, JSON.stringify(all, null, 2));
  }
  // Newest complete hour first (most useful soonest), then back through the backfill window.
  function nextMissing() {
    const newest = Math.floor((now() / 1000 - SETTLE_S) / HOUR) * HOUR - HOUR;
    const oldest = newest - Math.max(0, Math.min(365, settings.backfillDays)) * 24 * HOUR;
    for (let ts = newest; ts >= oldest; ts -= HOUR) if (!stored.has(ts)) return ts;
    return null;
  }
  function msUntilNextHour() {
    const t = now() / 1000, next = (Math.floor((t - SETTLE_S) / HOUR) + 1) * HOUR + SETTLE_S;
    return Math.max(60000, (next - t) * 1000 + 1000);
  }
  async function step() {
    if (!settings.enabled || busy) return null;
    const ts = nextMissing();
    if (ts === null) return null;
    busy = true;
    try {
      const bucket = compactBucket(JSON.parse(await fetchText(URL_1H + ts)));
      // The Wiki can answer with a different bucket than asked for; store what it says it is, and
      // mark the asked-for hour as done so an empty/odd hour isn't re-requested forever.
      if (Number.isSafeInteger(bucket.ts) && Object.keys(bucket.d).length && !stored.has(bucket.ts)) {
        fs.mkdirSync(archiveDir, {recursive: true});
        const base = path.join(archiveDir, '1h-' + monthOf(bucket.ts));
        fs.appendFileSync(base + '.jsonl.gz', zlib.gzipSync(JSON.stringify(bucket) + '\n'));
        fs.appendFileSync(base + '.idx', bucket.ts + '\n');
        stored.add(bucket.ts);
      }
      if (!stored.has(ts)) { fs.mkdirSync(archiveDir, {recursive: true}); fs.appendFileSync(path.join(archiveDir, '1h-' + monthOf(ts) + '.idx'), ts + '\n'); stored.add(ts); }
      lastFetchAt = now(); lastError = null;
      return ts;
    } catch (e) {
      lastError = e.message; log('Price archive: ' + e.message);
      throw e;
    } finally { busy = false; }
  }
  function schedule(ms) { if (running) { timer = setTimeout(tick, ms); timer.unref?.(); } }
  async function tick() {
    timer = null;
    if (!running || !settings.enabled) return;
    try { const ts = await step(); schedule(ts === null ? msUntilNextHour() : gapMs); }
    catch { schedule(ERROR_BACKOFF_MS); }
  }
  function start() { if (running) return; running = true; loadIndex(); schedule(1000); }
  function stop() { running = false; if (timer) clearTimeout(timer); timer = null; }
  function configure({enabled, backfillDays}) {
    if (enabled !== undefined) { if (typeof enabled !== 'boolean') throw new Error('enabled must be true or false'); settings.enabled = enabled; }
    if (backfillDays !== undefined) {
      if (!Number.isSafeInteger(backfillDays) || backfillDays < 0 || backfillDays > 90) throw new Error('backfillDays must be 0-90');
      settings.backfillDays = backfillDays;
    }
    saveSettings();
    if (running && settings.enabled && !timer && !busy) schedule(1000);
    return status();
  }
  function status() {
    let bytes = 0;
    try { for (const f of fs.readdirSync(archiveDir)) bytes += fs.statSync(path.join(archiveDir, f)).size; } catch {}
    const missing = settings.enabled ? nextMissing() : null;
    const hours = [...stored];
    return {enabled: settings.enabled, backfillDays: settings.backfillDays, hoursStored: stored.size,
      oldest: hours.length ? Math.min(...hours) : null, newest: hours.length ? Math.max(...hours) : null,
      bytes, lastFetchAt, lastError, catchingUp: missing !== null};
  }
  loadIndex();
  return {start, stop, configure, status, step};
}
