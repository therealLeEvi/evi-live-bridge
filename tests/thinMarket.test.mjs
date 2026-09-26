import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildThinMarketIndex, thinMarketNote, windowFor, MIN_HOURS, WINDOWS, thinMarketContext} from '../bridge/thinMarket.mjs';

const HOUR = 3600;
const T0 = Date.UTC(2026, 8, 10) / 1000;
// hours: array of [lowPrice, unitsSold] or null for an hour the item did not trade at all.
const archive = (id, hours) => hours.map((h, i) => ({ts: T0 + i * HOUR, d: h ? {[id]: [h[0] + 10, 1, h[0], h[1]]} : {}}));

test('thin market: an item that trades most hours at a steady price is not flagged', () => {
  const steady = archive(2, Array.from({length: 200}, () => [250, 500]));
  const stats = buildThinMarketIndex(steady).byItem.get(2);
  assert.equal(stats.hours, 200);
  assert.equal(stats.hoursTraded, 200);
  assert.equal(stats.cadence, 1);
  assert.equal(stats.recurrence[4], 1, 'the same price is always available again');
  assert.equal(thinMarketNote(stats, {name: 'Steel cannonball', windowHours: 4}), null);
});

// The Berserker icon suggestion that prompted this: traded in 43 of 1,439 hours (3%), about one a day,
// its own price matched again within 4 hours in 7% of cases and within 12 in 21%, median 0 units.
test('thin market: an item that barely trades is flagged, with its own record in the words', () => {
  // One trade every 30 hours, each at a rising price, so a price almost never comes back.
  const hours = Array.from({length: 300}, (_, i) => i % 30 === 0 ? [3_700_000 + i * 1000, 1] : null);
  const stats = buildThinMarketIndex(archive(28295, hours)).byItem.get(28295);
  assert.equal(stats.hoursTraded, 10);
  assert.ok(stats.cadence < 0.05);
  assert.equal(stats.recurrence[12], 0, 'a rising price is never matched again inside 12 hours');
  const note = thinMarketNote(stats, {name: 'Berserker icon', windowHours: 12, quantity: 2});
  assert.match(note, /^Warning: Berserker icon barely trades -- in 10 of the last 300 hours \(3%\)/);
  assert.match(note, /a price like this one was matched again within 12 hours only 0% of the time/);
  assert.match(note, /0 units available at or under it, against the 2 you would be buying/);
  assert.match(note, /may simply sit unfilled\. That is this item's own record, not a forecast\./);
  assert.doesNotMatch(note, /will|expect|likely/i, 'no forecast, in any wording');
});

test('thin market: a quiet item whose price genuinely recurs is left alone; under a tenth of hours is not', () => {
  // Trades a third of hours, always at the same price: the 10-40% band, measured at 67% within 4 hours
  // with 7 units available, which is a real trade and must not be thrown away.
  const quiet = buildThinMarketIndex(archive(555, Array.from({length: 300}, (_, i) => i % 3 === 0 ? [1000, 40] : null))).byItem.get(555);
  assert.ok(quiet.cadence > 0.3 && quiet.cadence < 0.4);
  assert.equal(quiet.recurrence[4], 1);
  assert.equal(thinMarketNote(quiet, {name: 'Quiet item', windowHours: 4}), null, 'quiet is not the same as unbuyable');
  // Under a tenth of hours is flagged even when the price itself always comes back, because that band
  // came out bad on both counts in the measurement.
  const rare = buildThinMarketIndex(archive(557, Array.from({length: 300}, (_, i) => i % 20 === 0 ? [1000, 2] : null))).byItem.get(557);
  assert.ok(rare.cadence < 0.1);
  assert.match(thinMarketNote(rare, {name: 'Rare item', windowHours: 24}), /barely trades/);
});

test('thin market: too little archive to judge means no warning at all, never a quiet pass', () => {
  const short = buildThinMarketIndex(archive(3, Array.from({length: MIN_HOURS - 1}, () => [100, 1]))).byItem.get(3);
  assert.equal(thinMarketNote(short, {name: 'New item', windowHours: 4}), null, 'EVI has not watched long enough to say');
  assert.equal(thinMarketNote(null, {windowHours: 4}), null);
  assert.equal(thinMarketNote(undefined, {}), null);
  assert.deepEqual(buildThinMarketIndex([]), {hours: 0, byItem: new Map()});
  assert.deepEqual(buildThinMarketIndex(null), {hours: 0, byItem: new Map()});
});

test('thin market: the window follows the player own trade duration, to the nearest measured one', () => {
  assert.equal(windowFor(60), 1);
  assert.equal(windowFor(4 * 60), 4);
  assert.equal(windowFor(12 * 60), 12);
  assert.equal(windowFor(24 * 60), 24);
  assert.equal(windowFor(10 * 60), 12, 'ten hours is nearer the 12-hour measurement than the 4-hour one');
  assert.equal(windowFor(undefined), 12, 'no duration set: judged over half a day');
  assert.deepEqual(WINDOWS, [1, 4, 12, 24]);
});


// Caught live: a Twisted relic hunter (t3) armour set was suggested while appearing in NONE of 335
// archived hours. "Absent from a long archive" is a measured fact about the item, not missing data, and
// it used to produce no warning at all.
test('thin market: an item absent from a long archive is the strongest warning, not silence', () => {
  const note = thinMarketNote(undefined, {name: 'Twisted relic hunter (t3) armour set', windowHours: 12, archivedHours: 335});
  assert.match(note, /^Warning: Twisted relic hunter \(t3\) armour set did not trade at all in the last 335 hours/);
  assert.match(note, /no recent price to buy or sell it at, so an offer may sit indefinitely/);
  assert.match(note, /not a forecast/);
  // With too little archive to judge, absence still says nothing.
  assert.equal(thinMarketNote(undefined, {name: 'x', windowHours: 12, archivedHours: 40}), null);
  assert.equal(thinMarketNote(undefined, {name: 'x', windowHours: 12}), null, 'no archive figure at all: silent');
});

// The thresholds are a cliff, and real items sit on it: the Twisted relic hunter (t3) armour set came
// out at 11% of hours and 54% recurrence with one unit available -- inside both limits, so no warning,
// while the player still wants the odds on the single unit they are buying.
test('thin market: the same figures are stated for any buy pick, warning or not', () => {
  const hours = Array.from({length: 335}, (_, i) => i % 9 === 0 ? [3_000_000, 1] : null);
  const stats = buildThinMarketIndex(archive(24475, hours)).byItem.get(24475);
  const context = thinMarketContext(stats, {windowHours: 12, quantity: 1});
  assert.match(context, /^Fill history: this item traded in 38 of the last 335 hours \(11%\)/);
  assert.match(context, /matched again within 12 hours in \d+% of those cases/);
  assert.match(context, /typically 1 unit at or under it \(you would be buying 1\)/);
  assert.doesNotMatch(context, /Warning|may simply sit/, 'a statement, not a verdict');
  // Same silence rules as the warning: nothing to say without enough archive.
  assert.equal(thinMarketContext(null, {windowHours: 12}), null);
  assert.equal(thinMarketContext(buildThinMarketIndex(archive(9, Array.from({length: 40}, () => [10, 5]))).byItem.get(9), {windowHours: 4}), null);
});
