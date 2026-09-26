import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sellAdvice, MIN_LOSS_SHARE} from '../bridge/sellAdvice.mjs';

// Built from a real week: five of six losing flips lost to the Grand Exchange tax on a flat price,
// not to the market. Two of them sold ABOVE what they cost and still lost. These cover the warning
// that was missing, and just as importantly the cases where it must stay quiet.
const offer = (o = {}) => ({itemId: 28919, name: 'Tonalztics of Ralos (uncharged)', price: 1000000, remaining: 1, ...o});

test('a sell priced below break-even is named, with what it costs each and in total', () => {
  // Paid 1,000,000; asking 1,000,000 returns 980,000 after a 20,000 tax, so each unit loses 20,000.
  const [note] = sellAdvice({offers: [offer({price: 1000000, remaining: 3})], costBasis: new Map([[28919, 1000000]])});
  assert.ok(note, 'a sale that cannot cover its own cost must be said out loud');
  assert.equal(note.lossEach, 20000);
  assert.equal(note.lossTotal, 60000);
  assert.ok(note.message.includes('BELOW your break-even'), note.message);
  assert.ok(note.message.includes('3'), 'it must say how many units are exposed: ' + note.message);
  assert.ok(/won't let it happen quietly/.test(note.message), 'it warns rather than forbids: ' + note.message);
});

test('the case that prompted it: sold above cost and still a loss', () => {
  // The Echo virtus ornament kit: bought at 969,046, asking 975,803 -- 0.7% up, and still losing.
  const [note] = sellAdvice({offers: [offer({itemId: 30443, name: 'Echo virtus ornament kit', price: 975803, remaining: 4})],
    costBasis: new Map([[30443, 969046]])});
  assert.ok(note, 'a price above what was paid can still be a loss after tax, and that is the point');
  assert.ok(note.lossEach > 0 && note.lossEach < 20000, 'the loss is the tax, not a collapse: ' + note.lossEach);
  assert.ok(note.breakEven > 975803, 'break-even must sit above the asking price');
});

test('an ask that clears break-even is left alone', () => {
  assert.deepEqual(sellAdvice({offers: [offer({price: 1100000})], costBasis: new Map([[28919, 1000000]])}), []);
});

test('with no cost basis it says nothing rather than guessing what was paid', () => {
  assert.deepEqual(sellAdvice({offers: [offer({price: 1})], costBasis: new Map()}), []);
  assert.deepEqual(sellAdvice({offers: [offer({price: 1})], costBasis: new Map([[28919, 0]])}), []);
});

test('rounding is not a warning', () => {
  // One gp under break-even on an expensive item is not worth interrupting anyone for.
  const paid = 10000000;
  const almost = sellAdvice({offers: [offer({price: 10203000})], costBasis: new Map([[28919, paid]])});
  assert.deepEqual(almost, [], 'a loss under ' + (MIN_LOSS_SHARE * 100) + '% of cost is rounding, not a decision');
});

test('unusable offers produce nothing at all, never a throw', () => {
  const costBasis = new Map([[28919, 1000000]]);
  for (const bad of [null, undefined, {}, offer({price: 0}), offer({price: -5}), offer({itemId: null})])
    assert.deepEqual(sellAdvice({offers: [bad], costBasis}), [], 'must ignore ' + JSON.stringify(bad));
  assert.deepEqual(sellAdvice({}), []);
  assert.deepEqual(sellAdvice(), []);
});

test('a cost basis given as a plain object works too, since callers differ', () => {
  const [note] = sellAdvice({offers: [offer({price: 1000000})], costBasis: {28919: 1000000}});
  assert.ok(note, 'the check should not depend on which shape the caller happens to hold');
});
