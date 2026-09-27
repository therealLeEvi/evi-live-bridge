// A guard against one specific class of bug: a check that exists, is tested, is documented, and does
// nothing in the configuration everybody actually runs.
//
// It has happened twice, and both reached users:
//
//  * The supported-margin check -- judge the minimum against what buyers are really paying rather than
//    the quoted spread -- was gated on `minProfitChosen`. The plugin only appends `minProfit=` when the
//    tier's gp() is above zero, and MinProfitTier.AUTO (the shipped default) returns 0, so the parameter
//    is absent and the check was skipped for everyone on the factory settings. A user was then offered
//    25,000 blood runes on a two gp edge and lost GP immediately.
//  * The price archive was off by default and the only switch was behind the browser scanner's cookie,
//    which is in neither published repository. So no Plugin Hub user ever had an archive, and the three
//    checks that read one -- thinMarket, the crash watch, the correlation check -- silently did nothing.
//
// Neither was visible to the suite, because every other test names its own parameters and builds its own
// archive. These tests deliberately name nothing: they assert what a DEFAULT install gets.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {suggestionPolicy, AUTO_MIN_PROFIT} from '../bridge/server.mjs';
import {createPriceArchive} from '../bridge/priceArchive.mjs';

// What the plugin really sends with every config item left alone. Built from EviLivePlugin's query
// builder: `minProfit` is appended only when the tier's gp() is above zero, `cushion=1` only when the
// margin-safety setting is on, `profile=` only when the trading profile has a param. On defaults, none
// of the three appear at all -- which is the whole point.
const PLUGIN_DEFAULTS = new URLSearchParams('includeMarket=1');

test('default install: the checks that must be live, are', () => {
  const p = suggestionPolicy(PLUGIN_DEFAULTS);

  // The one that failed. If this ever goes false for a default request, EVI will offer edges thinner
  // than the item's own tax again, and quantity will dress them up as a real profit.
  assert.equal(p.requireMarginOverTax, true,
    'margin-over-tax must be live when the player has expressed no preference');

  // The Auto floor applies, and the player is recorded as not having chosen one -- which is what makes
  // the supported-margin comparison use the floor as its bar rather than skipping itself.
  assert.equal(p.minProfitChosen, false);
  assert.equal(p.minProfit, AUTO_MIN_PROFIT);
  assert.equal(p.minProfit, 500);

  // Deliberately off, and each for a measured reason rather than by omission.
  assert.equal(p.requireCushion, false, 'blocked 0 of 40 market picks when measured; opt-in on purpose');
  assert.equal(p.taxFreeOnly, false, 'the starter profile is a choice, not a default');
});

test('a plugin sending no parameters at all is treated the same way', () => {
  // A plugin older than a parameter, or a request built by hand, must not be a way around the floor.
  const p = suggestionPolicy(new URLSearchParams(''));
  assert.equal(p.requireMarginOverTax, true);
  assert.equal(p.minProfitChosen, false);
  assert.equal(p.minProfit, 500);
});

test('MinProfitTier.NONE is the escape hatch, and it opens both locks together', () => {
  // "No minimum at all" sends the smallest positive floor there is. It must switch off the Auto floor
  // AND the margin-over-tax bar, because a player asking for thin trades is asking for both.
  const p = suggestionPolicy(new URLSearchParams('minProfit=1'));
  assert.equal(p.minProfitChosen, true);
  assert.equal(p.minProfit, 1);
  assert.equal(p.requireMarginOverTax, false, 'NONE means NONE');
});

test('a minimum the player actually set is honoured, and still gets the tax bar', () => {
  for (const [gp, expected] of [['100000', 100000], ['1000000', 1000000], ['2000000', 2000000]]) {
    const p = suggestionPolicy(new URLSearchParams('minProfit=' + gp));
    assert.equal(p.minProfit, expected);
    assert.equal(p.minProfitChosen, true);
    assert.equal(p.requireMarginOverTax, true, 'setting a minimum is not asking for thin edges');
  }
});

test('nonsense in the query string falls back to the default rather than switching a check off', () => {
  // Anything unparseable must land on the Auto floor with every check live, never on "no minimum".
  for (const q of ['minProfit=', 'minProfit=abc', 'minProfit=-5', 'minProfit=0', 'minProfit=NaN']) {
    const p = suggestionPolicy(new URLSearchParams(q));
    assert.equal(p.minProfit, 500, q + ' must fall back to the Auto floor');
    assert.equal(p.minProfitChosen, false, q);
    assert.equal(p.requireMarginOverTax, true, q + ' must not disarm the tax bar');
  }
});

test('default install: the price archive runs, so the checks that read it can', t => {
  // thinMarket ("can this price even be bought again"), the crash watch and the correlation check all
  // read this archive and all fail open without it. For three days after a fresh install nobody had
  // any of them, and nothing said so.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-default-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const a = createPriceArchive({dir, fetchText: async () => '{"timestamp":0,"data":{}}'});
  const s = a.status();
  assert.equal(s.enabled, true, 'the hourly stream feeds thinMarket and the correlation check');
  assert.equal(s.steps['5m'].enabled, true, 'the five-minute stream is the only thing feeding crash alerts');
  // thinMarket needs 72 hours before it will say anything, so the default window has to clear that in
  // one pass or the check is still dark on day one.
  assert.ok(s.backfillDays * 24 >= 72,
    `the default backfill (${s.backfillDays} days) must clear thinMarket's 72-hour bar`);
});
