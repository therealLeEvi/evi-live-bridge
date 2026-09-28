// The sidebar used to state a number and bury whether EVI trusted it.
//
// On 28 September 2026 novi bought 30 Contract of Glyphic Attenuation expecting the 2,977,560 gp the
// quoted spread implied. It was worth about 350,000 -- 313 buyers over twelve hours had paid an average
// of 373,612 -- and EVI knew: it had demoted the pick and said so, in the middle of a paragraph. The
// number was visible and the doubt was not. suggestionVerdict gives the doubt its own shape.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {suggestionVerdict, CLEAR, CAUTION, WARN} from '../bridge/verdict.mjs';

// The real Tonalztics pick: quoted 47,451,388 -> 49,634,754, and buyers were paying MORE than quoted.
const good = () => ({
  itemId: 28919, name: 'Tonalztics of Ralos (uncharged)', action: 'buy', quantity: 1,
  buyPrice: 47451388, sellPrice: 49634754, source: 'personal', trades: 2,
  sellSupport: {supported: true, units: 40, hours: 12, averagePaid: 49926373, netAtAverage: 1476458},
  fillHistory: {hoursTraded: 312, hours: 335},
});

// The real Contracts pick, which is the case this exists for.
const flattered = () => ({
  itemId: 30810, name: 'Contract of Glyphic Attenuation', action: 'buy', quantity: 30,
  buyPrice: 354488, sellPrice: 463000, source: 'market', demoted: true,
  sellSupport: {supported: true, units: 313, hours: 12, averagePaid: 373612, netAtAverage: 11652},
  fillHistory: {hoursTraded: 333, hours: 335},
});

test('a pick where every check passed says so, and says why', () => {
  const v = suggestionVerdict(good());
  assert.equal(v.level, CLEAR);
  assert.equal(v.label, 'Every check passed');
  const text = v.checks.map(c => c.text);
  assert.ok(text.some(t => /Buyers paying more than quoted/.test(t)));
  assert.ok(text.some(t => /Traded 312 of 335 hours/.test(t)));
  assert.ok(text.some(t => /Your 2 flips here/.test(t)));
  assert.ok(v.checks.every(c => c.ok === true), 'nothing against it');
});

test('the Contracts: the quoted spread flatters it, and the card says the real number', () => {
  const v = suggestionVerdict(flattered());
  assert.equal(v.level, CAUTION, 'offered, but not as a clean pick');
  assert.equal(v.label, 'Worth less than it looks');
  const text = v.checks.map(c => c.text).join(' | ');
  // 30 x 11,652 = 349,560 against the 2,977,560 the spread implies.
  assert.match(text, /349,560 at what buyers really pay/);
  assert.match(text, /313 paid ~373,612 in 12h/);
  assert.equal(v.checks[0].ok, false, 'the failing line comes first');
});

test('a sell that would realise a loss outranks everything and states both numbers', () => {
  const v = suggestionVerdict({
    itemId: 24420, action: 'sell', quantity: 1, buyPrice: 114000000, sellPrice: 115945954,
    lossIfSoldNow: 1049610, breakEvenPrice: 117016984,
    sellSupport: {supported: true, units: 44, hours: 12, averagePaid: 115945954, netAtAverage: -1049610},
  });
  assert.equal(v.level, WARN);
  assert.equal(v.label, 'Selling now is a loss');
  assert.match(v.checks[0].text, /Down 1,049,610 gp/);
  assert.match(v.checks[1].text, /Break-even after tax: 117,016,984/);
});

test('an item nobody trades is flagged even when the margin looks fine', () => {
  const v = suggestionVerdict({
    itemId: 1, action: 'buy', quantity: 5, buyPrice: 1000, sellPrice: 2000,
    fillHistory: {hoursTraded: 20, hours: 335},
  });
  assert.equal(v.level, CAUTION);
  assert.equal(v.label, 'Rarely traded');
  assert.match(v.checks.find(c => c.ok === false).text, /Traded only 20 of 335 hours/);
});

test('demoted for a reason nothing else named still shows as demoted', () => {
  const v = suggestionVerdict({itemId: 1, action: 'buy', quantity: 1, buyPrice: 100, sellPrice: 200,
    demoted: true, fillHistory: {hoursTraded: 300, hours: 335}});
  assert.equal(v.level, CAUTION);
  assert.equal(v.label, 'Shown because nothing passed');
});

test('no measurements means no opinion, not a clean bill of health', () => {
  // An absent verdict is how the panel knows to fall back to the prose, so silence must stay silence.
  assert.equal(suggestionVerdict({itemId: 1, action: 'buy', quantity: 1, buyPrice: 100, sellPrice: 200}), null);
  assert.equal(suggestionVerdict(null), null);
  assert.equal(suggestionVerdict({}), null);
});

test('lines stay short enough for a 225px panel', () => {
  for (const s of [good(), flattered()]) {
    const v = suggestionVerdict(s);
    assert.ok(v.label.length <= 30, `label too long: ${v.label}`);
    assert.ok(v.checks.length <= 4, 'at most four lines');
    for (const c of v.checks) assert.ok(c.text.length <= 46, `too long for the panel: ${c.text}`);
  }
});
