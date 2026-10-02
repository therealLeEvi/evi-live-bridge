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
import {suggestionPolicy, AUTO_MIN_PROFIT, autoMinProfit, AUTO_STACK_SHARE, headlineProfit,
        positionsWanted, MAX_POSITIONS, BIGGER_POSITIONS} from '../bridge/server.mjs';
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

test('with no minimum set, the floor follows the cash stack', () => {
  // 500 gp is a floor against absurdity, not against irrelevance. With 89m in hand EVI was offering
  // trades worth "anywhere from 500 gp to 12k" -- each one past the floor, none worth a slot at that
  // size. Measured over 420 real buy suggestions carrying a cash stack, a 0.1% share drops 21% of them
  // and the median dropped is worth 9,557 gp: exactly that band, and nothing above it.
  assert.equal(AUTO_STACK_SHARE, 0.001);
  assert.equal(autoMinProfit(89_000_000), 89_000, 'the case that prompted it');
  assert.equal(autoMinProfit(380_000_000), 380_000);
  assert.equal(autoMinProfit(1_000_000), 1_000);

  // The small-stack half, which is why this is the LARGER of the two rather than a share alone. A share
  // on its own was rejected once for scaling with capital while the absurdity does not -- true of a
  // share by itself, and fixed by taking the maximum.
  assert.equal(autoMinProfit(50_000), AUTO_MIN_PROFIT, 'a new player is governed by the flat floor');
  assert.equal(autoMinProfit(499_999), AUTO_MIN_PROFIT, 'anything under 500k stays on the 500');
  assert.equal(autoMinProfit(500_001), 500, 'and the two meet exactly there');

  // Unknown cash never invents a constraint, the standing fail-open rule.
  for (const bad of [undefined, null, NaN, 0, -5, 'abc'])
    assert.equal(autoMinProfit(bad), AUTO_MIN_PROFIT, String(bad));

  // End to end through the policy the handler actually uses.
  assert.equal(suggestionPolicy(new URLSearchParams('cash=89000000')).minProfit, 89_000);
  assert.equal(suggestionPolicy(new URLSearchParams('cash=89000000')).minProfitChosen, false);
});

test('a minimum the player set is never quietly raised on them', () => {
  // 0.1% of 380m is 380,000, which is more than the 200,000 they asked for. Their number wins: an
  // explicit setting is a decision, not a starting point for EVI to improve on.
  const p = suggestionPolicy(new URLSearchParams('minProfit=200000&cash=380000000'));
  assert.equal(p.minProfit, 200_000);
  assert.equal(p.minProfitChosen, true);
  // And NONE still means none, however much is in hand.
  const none = suggestionPolicy(new URLSearchParams('minProfit=1&cash=380000000'));
  assert.equal(none.minProfit, 1);
  assert.equal(none.requireMarginOverTax, false);
});

test('the headline profit is never a figure EVI has already measured as false', () => {
  // The Ape atoll teleport (tablet), 28 September 2026. The Wiki's latest.high of 28,756 was a single
  // print against hourly averages of 6,000-6,300 all day, and sell-support had already read 1,115
  // buyers paying an average of 6,379. Quoted 92,356; really 4,641. The pick was correctly demoted and
  // the verdict card correctly read "Worth less than it looks" -- and the sidebar still led with the
  // 92,356, which was also what the 89,000 Auto stack floor got compared against. A fiction cleared a
  // floor the truth could never have cleared.
  assert.equal(headlineProfit(92_356, 4_641), 4_641, 'the measured figure wins when it is lower');

  // The other direction, the same day: an Ornate maul handle quoted 2,474 and supported 9,865. The
  // average buyers paid can sit ABOVE the player's own ask, and EVI must not headline a number that
  // depends on selling higher than it is telling them to list. The quoted spread caps the promise.
  assert.equal(headlineProfit(2_474, 9_865), 2_474, 'the quoted spread caps the promise');

  // No reading is not a constraint. Fail open, the standing rule for anything with GP at stake.
  for (const none of [null, undefined, NaN])
    assert.equal(headlineProfit(612_968, none), 612_968, String(none));

  // A loss stays a loss, and the worse of the two is still the cautious one.
  assert.equal(headlineProfit(-50_000, 1_000), -50_000);
  assert.equal(headlineProfit(1_000, -50_000), -50_000);

  // Nothing to headline at all, rather than a fabricated zero.
  assert.equal(headlineProfit(NaN, 4_641), null);
});

test('one suggestion is the default, and the ceiling is the server\'s not the dropdown\'s', () => {
  // The standing objection to EVI fanning out across the Grand Exchange: allocating a stack across
  // eight trades divides the cash by eight, and an eighth-sized trade cannot make the profit they
  // trade for. The only form accepted was "up to N, where the player chooses N, defaulting to 1".
  // A default install sends no parameter at all and must land on exactly one.
  assert.equal(positionsWanted(new URLSearchParams('includeMarket=1')), 1, 'the shipped default');
  assert.equal(positionsWanted(new URLSearchParams('')), 1, 'an older plugin sends nothing');

  // What the dropdown can ask for.
  assert.equal(positionsWanted(new URLSearchParams('maxSuggestions=2')), 2);
  assert.equal(positionsWanted(new URLSearchParams('maxSuggestions=3')), 3);

  // The ceiling is enforced HERE, not by the dropdown only offering three: this endpoint is reachable
  // by anything holding the plugin key, and eight slots of EVI's choosing is the thing that was ruled out.
  assert.equal(MAX_POSITIONS, 3);
  for (const greedy of ['8', '99', '1000000'])
    assert.equal(positionsWanted(new URLSearchParams('maxSuggestions=' + greedy)), 3, greedy);

  // Nonsense falls back to one rather than to "as many as possible".
  for (const junk of ['', 'abc', '0', '-4', 'NaN', 'Infinity'])
    assert.equal(positionsWanted(new URLSearchParams('maxSuggestions=' + junk)), 1, junk);
  assert.equal(positionsWanted(new URLSearchParams('maxSuggestions=2.9')), 2, 'fractions round down');
  assert.equal(positionsWanted(undefined), 1, 'no params at all');
});

test('the Auto target is a preference, not a gate: an explicit tier is the opposite', () => {
  // Reported by a player on 28 Sept 2026: EVI suggested nothing at Auto and nothing at every explicit
  // tier, and "No minimum at all" was the only setting that produced anything. That is the shape of
  // the fault, and it is a trap as well as an annoyance: MinProfitTier.NONE switches the
  // margin-over-tax check off too, so silence above it pushes a player into giving up a real safety
  // net to get any answer at all.
  //
  // The policy still reports the stack-scaled figure -- the handler needs it to know what to aim for
  // and what to say when it comes up short -- but `minProfitChosen` is what separates a target from
  // a decision, and it is false here. That flag is what licenses the handler to step down.
  const auto = suggestionPolicy(new URLSearchParams('cash=100000000'));
  assert.equal(auto.minProfit, 100_000, 'Auto still aims at 0.1% of the stack');
  assert.equal(auto.minProfitChosen, false, 'and this is what marks it as a target rather than a gate');

  // A tier the player picked is a decision and stays a hard floor, however little the market offers.
  const chosen = suggestionPolicy(new URLSearchParams('minProfit=500000&cash=100000000'));
  assert.equal(chosen.minProfit, 500_000);
  assert.equal(chosen.minProfitChosen, true, 'an explicit tier must never be stepped down from');

  // The floor EVI steps down TO is the absurdity floor, not zero: 81 gold necklaces for 81 gp of net
  // profit is not "the best available", it is noise. Everything protective is untouched either way.
  assert.equal(AUTO_MIN_PROFIT, 500);
  assert.equal(auto.requireMarginOverTax, true, 'stepping down must never relax the tax bar');
  assert.equal(suggestionPolicy(new URLSearchParams('minProfit=1')).requireMarginOverTax, false,
    'only NONE does that, and only because it was asked for explicitly');
});

test('"Bigger positions" is one switch because its three parts gate the same trade in series', () => {
  // The default install must not get it: it raises the loss rate, modestly but really, and at a
  // two-day pace measurably more (8% -> 13%). Opt-in is the standing rule for anything like this.
  const off = suggestionPolicy(PLUGIN_DEFAULTS);
  assert.equal(off.biggerPositions, false, 'never on by default');
  assert.deepEqual(off.sizing, {}, 'and it must add no sizing option at all when off');
  assert.equal(off.marketRankBy, undefined, 'the ranking is untouched when off');

  // All three move together. Each one alone measured neutral or worse, because they gate the same
  // class of trade in series: the per-hour floor keeps a thin item out; admitted, log(liquidity)
  // means it never wins the ranking; and if it won, the per-hour cap sizes it to a handful of units.
  const on = suggestionPolicy(new URLSearchParams('sizing=bigger'));
  assert.equal(on.biggerPositions, true);
  assert.equal(on.sizing.minVolumeInWindow, BIGGER_POSITIONS.minVolumeInWindow, 'the floor half');
  assert.equal(on.sizing.volumeWindowShare, BIGGER_POSITIONS.volumeWindowShare, 'the sizing half');
  assert.equal(on.marketRankBy, BIGGER_POSITIONS.rankBy, 'the ranking half');

  // The ranking half is market-tier only, because that is where it was measured. The sizing half is
  // about how much of a market an order can be, which is the same whichever tier picked the item, so
  // it is carried in `sizing` and spread across all of them.
  assert.ok(!('rankBy' in on.sizing), 'the ranking must not leak into the personal tier via sizing');

  // Nothing else about the request changes: this is a sizing and ranking switch, not a safety one.
  assert.equal(on.requireMarginOverTax, off.requireMarginOverTax, 'the tax bar is untouched');
  assert.equal(on.minProfit, off.minProfit, 'and so is the profit floor');

  // Anything other than the exact word leaves it off, rather than guessing at intent.
  for (const junk of ['', 'yes', 'true', '1', 'BIGGER', 'careful'])
    assert.equal(suggestionPolicy(new URLSearchParams('sizing=' + junk)).biggerPositions, false, junk);
});
