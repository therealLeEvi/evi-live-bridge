// The volume cap sizes an order off a TYPICAL hour, not off the latest one.
//
// The case behind it: at a 12-hour pace the cap sized an order of Harmony island teleports off an
// hour in which about 969 units happened to trade. That item's typical hour was 92, its hours ranged
// from 1 to 809, and the order allowed was close to half its entire daily volume. The arithmetic
// was right and the
// basis was wrong -- exactly the fault the price ranking fixed on 29 Sept by moving to a two-week
// median. Measured in tools/volume-basis.mjs before building; the table is in the doc comment on
// sizingLiquidityFor.
//
// Every test here must still hold with NO typical reading supplied, because the archive is off by
// default and a missing median must never make sizing stricter by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import {sizingLiquidityFor, computeSuggestion, computeMarketSuggestion, computePushedSuggestion} from '../bridge/suggestions.mjs';

const hour = n => ({highPriceVolume: n, lowPriceVolume: n});
const fresh = () => ({'1': {high: 180, low: 100, highTime: Math.floor(Date.now() / 1000), lowTime: Math.floor(Date.now() / 1000)}});
const mapping = () => [{id: 1, name: 'Thing', limit: 100000}];
const flip = (q = 150) => ({itemId: 1, itemName: 'Thing', quantity: q, buyPrice: 100, sellPrice: 180, profit: 60 * q, ts: Date.now() - 86400000});

test('sizingLiquidityFor: the typical hour wins, and its absence changes nothing', () => {
  const volumes = {'1': hour(969)};
  assert.equal(sizingLiquidityFor({volumes, typicalVolumes: {'1': 92}}, 1), 92, 'the typical hour is the basis');
  assert.equal(sizingLiquidityFor({volumes}, 1), 969, 'no typical reading: the latest hour, which is the old behaviour');
  assert.equal(sizingLiquidityFor({volumes, typicalVolumes: {}}, 1), 969, 'an archive with nothing for this item falls back too');
  assert.equal(sizingLiquidityFor({volumes, typicalVolumes: {'2': 92}}, 1), 969, 'another item\'s reading is not this item\'s');

  // A ZERO falls back rather than constraining to one unit, which is deliberately NOT the
  // measured-zero rule volumeReadingFor follows -- see the doc comment. "Nobody bought this in the
  // last hour" is about now; "the median hour of the week has a zero side" is about typicality, on an
  // item the live floor has already shown is trading. Measured: 1.9% of offerable items, and
  // constraining them would be an unmeasured behaviour change. The bridge does not publish a zero
  // either, so this is belt and braces.
  assert.equal(sizingLiquidityFor({volumes, typicalVolumes: {'1': 0}}, 1), 969, 'a zero falls back, it does not constrain');

  // Anything that is not a usable number is treated as absent too, because a malformed archive row
  // must fail OPEN. Failing closed here would silently size every order at one unit.
  for (const bad of [null, undefined, NaN, Infinity, -1, '92']) {
    assert.equal(sizingLiquidityFor({volumes, typicalVolumes: {'1': bad}}, 1), 969, `${String(bad)} must fall back, not constrain`);
  }
  // And with no volume data at all the answer is still null, which constrains nothing anywhere.
  assert.equal(sizingLiquidityFor({}, 1), null);
});

test('the market tier sizes a spike hour down to the typical one', () => {
  const opts = {blocklist: new Set(), targetDurationMinutes: 12 * 60, maxSpend: 50_000_000};
  // 1.0x of the hour at a 12-hour pace, so the two bases are the quantity directly.
  const spike = computeMarketSuggestion(mapping(), fresh(), {'1': hour(969)}, opts);
  assert.equal(spike.quantity, 969, 'without a typical reading the latest hour still decides');

  const typical = computeMarketSuggestion(mapping(), fresh(), {'1': hour(969)}, {...opts, typicalVolumes: {'1': 92}});
  assert.equal(typical.quantity, 92, 'the order is sized off the hour the item usually trades');

  // The other direction matters as much: a quiet hour on an item that normally trades heavily must
  // not be sized DOWN to that hour. EVI has twice shipped a cap that was stricter than intended.
  const lull = computeMarketSuggestion(mapping(), fresh(), {'1': hour(20)}, {...opts, typicalVolumes: {'1': 500}});
  const lullNow = computeMarketSuggestion(mapping(), fresh(), {'1': hour(20)}, opts);
  assert.equal(lullNow.quantity, 20, 'on the latest hour alone, one quiet hour sizes the order at 20');
  assert.ok(lull.quantity > lullNow.quantity, `a lull must not shrink an order on a liquid item: ${lull.quantity}`);

  // It lands at 160 rather than 500 because a SECOND cap binds -- the fill-time estimate, which
  // reads the latest hour deliberately. `correctedFillMinutes` was calibrated against the archived
  // hour an offer was placed in, so feeding it a weekly median would apply a correction factor to a
  // basis it was never measured on. That is a named recurring fault in this project, so the fill
  // estimate was left alone and only the SHARE cap moved. If the fill estimate should move too, it
  // wants its own measurement first.
  assert.equal(lull.quantity, 160, 'floor(20 / 60 * 720 / 1.5) -- the fill estimate, still on the live hour');
  assert.match(lull.reasoning, /capped to fit an estimated ~720-minute trade/);
});

test('the market tier\'s liquidity FLOOR still reads the latest hour', () => {
  // "Does this item trade at all" is a question about now, so the floor was deliberately left on the
  // live reading when the SIZE moved. An item that has stopped trading must be dropped however good
  // its week looked -- otherwise the typical hour would resurrect dead markets.
  const opts = {blocklist: new Set(), targetDurationMinutes: 12 * 60, maxSpend: 50_000_000};
  assert.equal(computeMarketSuggestion(mapping(), fresh(), {'1': hour(0)}, {...opts, typicalVolumes: {'1': 500}}), null,
    'nothing traded this hour: excluded, whatever the week says');
  // And the floor is never tightened by a zero typical reading: the item is still offered, sized off
  // the live hour exactly as it is today.
  const zeroTypical = computeMarketSuggestion(mapping(), fresh(), {'1': hour(500)}, {...opts, typicalVolumes: {'1': 0}});
  const noTypical = computeMarketSuggestion(mapping(), fresh(), {'1': hour(500)}, opts);
  assert.ok(zeroTypical, 'trading now: still offered');
  assert.equal(zeroTypical.quantity, noTypical.quantity, 'a zero typical reading changes nothing at all');
  assert.equal(zeroTypical.quantity, 500);
});

test('the window-relative cap sizes off the typical hour too', () => {
  // volumeWindowShare is the opt-in "Bigger positions" rule and multiplies the hour by the whole
  // window, so a spike hour is amplified twelvefold there rather than once. It needed the same basis.
  const opts = {blocklist: new Set(), targetDurationMinutes: 12 * 60, maxSpend: 500_000_000, volumeWindowShare: 0.25};
  const spike = computeMarketSuggestion(mapping(), fresh(), {'1': hour(969)}, opts);
  const typical = computeMarketSuggestion(mapping(), fresh(), {'1': hour(969)}, {...opts, typicalVolumes: {'1': 92}});
  assert.equal(spike.quantity, Math.floor(969 * 12 * 0.25));
  assert.equal(typical.quantity, Math.floor(92 * 12 * 0.25));
});

test('the personal and pushed tiers use the same basis', () => {
  const flips = [flip(), flip(2000)]; // usual size well above either cap
  const volumes = {'1': hour(969)};
  const common = {volumes, targetDurationMinutes: 12 * 60, maxSpend: 50_000_000};

  assert.equal(computeSuggestion(flips, fresh(), Date.now(), common).quantity, 969);
  assert.equal(computeSuggestion(flips, fresh(), Date.now(), {...common, typicalVolumes: {'1': 92}}).quantity, 92,
    'a proven item is sized off its typical hour as well -- a track record is not evidence about liquidity');

  const shortlist = [{itemId: 1, name: 'Thing', buy: 100, sell: 180, net: 60, qty: 5000, score: 50}];
  assert.equal(computePushedSuggestion(shortlist, common).quantity, 969);
  assert.equal(computePushedSuggestion(shortlist, {...common, typicalVolumes: {'1': 92}}).quantity, 92,
    'the scanner-pushed tier is the one most players see with the dashboard open');
});

// THE TEST THAT MATTERS MOST, and the one every previous version of this kind of change lacked.
//
// Everything above proves sizingLiquidityFor WORKS. None of it proves the bridge ever CALLS it with a
// real reading. That gap is this project's signature failure: the pushedShare crash, the
// minProfitChosen gate that switched the supported-margin check off for everyone on factory settings,
// the volume ladder that stopped at twelve hours, and the archive call site still reading 26 hours all
// passed a green suite. A check that is silently inert looks exactly like one that works.
//
// So this boots a real bridge over a real (synthetic) archive, drives the engine from fixed prices
// through createMarketCache's fetchText seam, and reads the quantity back out of /api/suggestion. It
// fails if typicalVolumes is dropped from the options, if the archive read breaks, if the median is
// built wrongly, or if the warm-up never runs -- and nothing else in this file would notice any of it.
test('end to end: a real bridge sizes a spike hour off the archive, not off the spike', async t => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const zlib = await import('node:zlib');
  const {createBridge} = await import('../bridge/server.mjs');

  const nowS = Math.floor(Date.now() / 1000);
  const ID = 19625, K = String(ID);              // the item the live case was about

  // 200 hourly buckets: a typical hour of 40 units on both sides, and ONE 2,000-unit spike, which is
  // the most recent hour and therefore the reading the old basis would have used. Prices are flat
  // throughout, so nothing but the volume basis can move the quantity.
  const lines = [];
  for (let i = 200; i >= 1; i--) {
    const ts = (Math.floor(nowS / 3600) - i) * 3600;
    const v = i === 1 ? 2000 : 40;
    lines.push(JSON.stringify({ts, d: {[K]: [180, v, 100, v]}}));
  }

  // The 1h endpoint reports the spike, as it would have on the day. 10% of 2,000 is 200 units; 10% of
  // the archive's typical 40 is 4. One number distinguishes the two bases completely.
  const fetchText = url => {
    if (url.includes('/mapping')) return JSON.stringify([{id: ID, name: 'Harmony island teleport (tablet)', limit: 10000, members: false, value: 1}]);
    if (url.includes('/latest')) return JSON.stringify({data: {[K]: {high: 180, highTime: nowS - 30, low: 100, lowTime: nowS - 30}}});
    if (url.includes('/1h')) return JSON.stringify({data: {[K]: {avgHighPrice: 180, highPriceVolume: 2000, avgLowPrice: 100, lowPriceVolume: 2000}}});
    if (url.includes('/timeseries')) return JSON.stringify({data: Array.from({length: 30}, (_, i) => ({timestamp: nowS - (30 - i) * 3600, avgHighPrice: 180, highPriceVolume: 40, avgLowPrice: 100, lowPriceVolume: 40}))});
    return '{}';
  };

  const ask = async (withArchive, port) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-volbasis-'));
    if (withArchive) {
      const archiveDir = path.join(dir, 'price-archive');
      fs.mkdirSync(archiveDir, {recursive: true});
      const month = new Date(nowS * 1000).toISOString().slice(0, 7);
      // Each line is its own gzip member, which is how the archive appends them.
      fs.writeFileSync(path.join(archiveDir, '1h-' + month + '.jsonl.gz'),
        Buffer.concat(lines.map(l => zlib.gzipSync(l + String.fromCharCode(10)))));
    }
    const app = createBridge({dir, port, fetchText});
    await new Promise(r => app.server.listen(port, '127.0.0.1', r));
    try {
      // The median is built off the request path shortly after startup, so let the warm-up land.
      await new Promise(r => setTimeout(r, 2500));
      // includeMarket=1 and duration are both parameters the PLUGIN sends and a hand-made query does
      // not. Without includeMarket the market tier never runs at all and this test passes vacuously;
      // without duration the cap silently falls back to its 10% no-pace default. Both have cost a
      // debugging session before.
      const r = await fetch(app.origin + '/api/suggestion?account=test&includeMarket=1&minProfit=1&cash=50000000&duration=720',
        {headers: {Authorization: 'Bearer ' + app.secrets.plugin}});
      assert.equal(r.status, 200, 'a non-200 here means the archive read threw rather than failing open');
      return (await r.json()).suggestion;
    } finally {
      await new Promise(r => app.server.close(r));
      fs.rmSync(dir, {recursive: true, force: true});
    }
  };

  // No archive at all: the old behaviour, sized off the 2,000-unit spike. This is the control, and it
  // also proves the fail-open path -- a fresh install has no archive and must still get a suggestion.
  const bare = await ask(false, 51757);
  assert.ok(bare, 'with no archive the bridge must still answer, sized off the live hour');
  assert.equal(bare.itemId, ID);
  assert.equal(bare.quantity, 2000, 'the control: one spike hour, taken at face value, is the old basis');

  const archived = await ask(true, 51758);
  assert.ok(archived, 'the archive must not stop the bridge suggesting anything');
  assert.equal(archived.itemId, ID);
  assert.equal(archived.quantity, 40, 'sized off the typical hour the archive records, not the spike');
  assert.ok(archived.quantity < bare.quantity / 10, 'the whole point: the spike no longer sets the order size');
});
