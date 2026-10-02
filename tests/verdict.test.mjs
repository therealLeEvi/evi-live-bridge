// The sidebar used to state a number and bury whether EVI trusted it.
//
// On 28 September 2026 a player bought a batch of Contract of Glyphic Attenuation expecting roughly
// the 3m gp the quoted spread implied. It was worth about 350,000 -- 313 buyers over twelve hours had paid an average
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

// -- Holdings and idle stock. Before 30 Sept 2026 neither drew a card at all: the only sell that
// produced a verdict was one at a LOSS, so your own stock got a card exactly when the news was bad
// and a plain paragraph when it was good. Reported against a Gilded d'hide vambraces whose gain sat
// in prose beside buy picks drawn as cards. --

const holding = (over = {}) => ({itemId: 23261, name: "Gilded d'hide vambraces", action: 'sell',
  source: 'holding', quantity: 1, buyPrice: 4100000, sellPrice: 4442921,
  netIfSoldNow: 254063, breakEvenPrice: 4183673, ...over});

test('a holding in profit gets a card, not a paragraph', () => {
  const v = suggestionVerdict(holding());
  assert.ok(v, 'a profitable holding must produce a verdict at all -- null falls back to prose');
  assert.equal(v.level, CLEAR);
  assert.equal(v.label, 'Above break-even');
  assert.ok(v.checks.some(c => c.ok === true && /254,063/.test(c.text)), 'states what it is worth over cost');
  assert.ok(v.checks.some(c => c.ok === null && /4,183,673/.test(c.text)), 'states break-even after tax');
});

test('a holding at a loss still leads with the loss, unchanged', () => {
  // The pre-existing branch outranks the new one: a loss is the thing to say first.
  const v = suggestionVerdict(holding({netIfSoldNow: -90000, lossIfSoldNow: 90000}));
  assert.equal(v.level, WARN);
  assert.equal(v.label, 'Selling now is a loss');
});

test('idle stock claims no profit, because there is no cost basis to claim one from', () => {
  // The honest failure: EVI cannot say what you would MAKE on something it never saw you buy, only
  // what it is worth today. Saying so is the check; inventing a figure would be the bug.
  const v = suggestionVerdict({itemId: 23261, name: "Gilded d'hide vambraces", action: 'sell',
    source: 'inventory', quantity: 1, buyPrice: 4271186, sellPrice: 4442921});
  assert.ok(v, 'idle stock must produce a verdict');
  assert.equal(v.level, CAUTION, 'not a clean bill of health: the one number a card is for is missing');
  assert.equal(v.label, 'Not bought through EVI');
  assert.ok(v.checks.every(c => c.ok !== true), 'nothing here passed a check; these are facts, not passes');
  assert.ok(v.checks.some(c => /4,442,921/.test(c.text)), 'states what the stack is worth today');
  assert.ok(v.checks.some(c => /no profit is claimed/i.test(c.text)), 'says plainly that no profit is claimed');
});

test('holding and idle lines fit the 225px panel too', () => {
  for (const s of [holding(), {itemId: 1, action: 'sell', source: 'inventory', quantity: 3, sellPrice: 1234567}]) {
    const v = suggestionVerdict(s);
    assert.ok(v.label.length <= 30, `label too long: ${v.label}`);
    for (const c of v.checks) assert.ok(c.text.length <= 46, `too long for the panel: ${c.text}`);
  }
});
