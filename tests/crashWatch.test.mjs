import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildBaselines, detectCrashes, createCrashWatch, crashMessage, CRASH_MEASURED} from '../bridge/crashWatch.mjs';

const HOUR = 3600;
const END = Date.UTC(2026, 8, 19, 2) / 1000;
// A week and a day of steady hourly trading for one item, with a little noise so it has a spread of
// its own: buyers ~465k, sellers ~452k, ~8 a side each hour (Brine sabre before 19 Sep).
function steadyHistory(id = 11037, {hi = 465000, lo = 452000, vol = 8} = {}) {
  const out = [];
  for (let k = 192; k >= 1; k--) {
    const wobble = 1 + 0.01 * Math.sin(k);
    out.push({ts: END - k * HOUR, d: {[id]: [Math.round(hi * wobble), vol, Math.round(lo * wobble), vol]}});
  }
  return out;
}
const five = (minutesBefore, d) => ({ts: END + 1800 - minutesBefore * 60, d});

test('crash watch: Brine sabre on 19 Sep -- both sides down a third on heavy volume -- is a crash', () => {
  const base = buildBaselines(steadyHistory(), END);
  assert.ok(base.get(11037), 'an item trading every hour has a baseline');
  const found = detectCrashes(base, [
    five(30, {11037: [null, 0, 323881, 49]}),
    five(25, {11037: [300000, 64, null, 0]}),
    five(20, {11037: [300000, 8, 46464, 1]}),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].itemId, 11037);
  assert.ok(found[0].drop > 0.3 && found[0].drop < 0.4);
});

test('crash watch: one side alone is not a crash -- a burst of instant sells on a wide spread moved nothing', () => {
  const base = buildBaselines(steadyHistory(), END);
  // Plenty of volume, sellers dumping into buy offers at the usual low; buyers still paying the usual high.
  assert.deepEqual(detectCrashes(base, [five(20, {11037: [465000, 2, 300000, 80]})]), []);
});

test('crash watch: a single misclick on thin volume is not a crash', () => {
  const base = buildBaselines(steadyHistory(), END);
  assert.deepEqual(detectCrashes(base, [five(20, {11037: [300000, 1, 46464, 1]})]), [], 'price collapsed, but on two items traded');
});

test('crash watch: an item without a week of steady trading has no baseline, so it is never flagged', () => {
  const thin = steadyHistory().filter((_, i) => i % 3 === 0);
  assert.equal(buildBaselines(thin, END).get(11037), undefined);
});

test('crash watch: a running alert is judged against the price from before the crash, and ends on recovery', () => {
  let clock = (END + 1800) * 1000;
  const events = [];
  const history = steadyHistory();
  const w = createCrashWatch({loadHourly: () => history, loadFiveMinute: () => [], record: e => events.push(e), now: () => clock});
  w.addFiveMinute(five(25, {11037: [300000, 64, 323881, 49]}));
  assert.ok(w.isCrashing(11037));
  // An hour later the crash hours would have dragged a rolling average towards 300k. Still at 300k:
  // still crashing, because the comparison is with the old price.
  clock += 3600000; history.push({ts: END, d: {11037: [300000, 169, 313753, 52]}});
  w.addFiveMinute({ts: END + 3600, d: {11037: [300000, 20, 290000, 10]}});
  assert.ok(w.isCrashing(11037), 'a price still on the floor is still a crash');
  // Buyers back near 465k: over.
  clock += 3600000;
  w.addFiveMinute({ts: END + 7200, d: {11037: [460000, 10, 450000, 10]}});
  assert.equal(w.isCrashing(11037), null);
  assert.deepEqual(events.map(e => e.event), ['crash', 'crash-ended']);
  assert.equal(events[1].because, 'recovered');
  assert.equal(w.recent()[0].endedBecause, 'recovered', 'kept for a day after it ends, so the scanner can still show it');
});

test('crash watch: the message states facts and measured history, and never predicts', () => {
  const m = crashMessage({itemId: 11037, hi: 300000, lo: 313753, baseHi: 465000, drop: 1 - 300000 / 465000, units: 119, normalPerHour: 17.2},
    {name: 'Brine sabre', mine: 'Your buy offer for 24 is still running (0 bought so far).'});
  assert.match(m, /^Brine sabre is crashing: buyers are paying about 300,000 gp, 35% under its 24-hour average of 465,000 gp/);
  assert.match(m, /Your buy offer for 24 is still running/);
  assert.match(m, /Cause unknown\. Of 98 crashes like this in items from 10k to 1m/);
  assert.match(m, /That is history, not a forecast for this one\./);
  assert.doesNotMatch(m, /will (recover|rebound|bounce)|buy now|cheap/i);
  const dear = crashMessage({itemId: 1, hi: 2e6, lo: 1.9e6, baseHi: 3e6, drop: 0.33, units: 40, normalPerHour: 3}, {name: 'X'});
  assert.match(dear, /\(a small sample\)/, `the over-1m band rests on ${CRASH_MEASURED.bands[2].n} crashes and says so`);
});
