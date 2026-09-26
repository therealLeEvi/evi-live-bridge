import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buyMarginAdvice, MIN_MARGIN_SHARE} from '../bridge/buyAdvice.mjs';

// Brine sabre on 19 Sep 2026: bought into at 305,170 while buyers had dropped to about 300,000.
const brine = {itemId: 11037, name: 'Brine sabre', price: 305170, total: 24, filled: 0, spent: 0};
const prices = (sell, buy = 300000) => ({'11037': {buyPrice: buy, sellPrice: sell}});

test('buy advice: a running buy whose margin has gone is reported, with the exit priced after tax', () => {
  const [n] = buyMarginAdvice({offers: [brine], prices: prices(300000)});
  assert.equal(n.itemId, 11037);
  assert.equal(n.netAtMarket, 294000, '300,000 less the 2% GE tax');
  assert.equal(n.marginPerUnit, 294000 - 305170);
  assert.match(n.message, /^Brine sabre: your buy at 305,170 gp no longer has a margin/);
  assert.match(n.message, /buyers are paying 300,000 gp, which is 294,000 gp after tax, 11,170 gp BELOW what you are paying/);
  assert.match(n.message, /Nothing has filled yet, so cancelling costs nothing/);
  assert.match(n.message, /EVI never cancels anything, and it has no view on where the price goes next/);
});

test('buy advice: a healthy margin says nothing, and a margin thinner than the noise floor is not a signal', () => {
  assert.deepEqual(buyMarginAdvice({offers: [brine], prices: prices(465000)}), [], 'the trade still works: silence');
  // Just inside the floor: 305,170 * 0.005 = 1,525 gp of margin required to stay quiet.
  const thin = Math.ceil((305170 + 305170 * MIN_MARGIN_SHARE) / 0.98);
  assert.deepEqual(buyMarginAdvice({offers: [brine], prices: prices(thin + 500)}), []);
  assert.equal(buyMarginAdvice({offers: [brine], prices: prices(thin - 2000)}).length, 1, 'a margin below the floor is reported');
});

test('buy advice: part-filled offers say what is already bought and what cancelling would drop', () => {
  const [n] = buyMarginAdvice({offers: [{...brine, total: 24, filled: 9, spent: 9 * 304000}], prices: prices(300000)});
  assert.match(n.message, /You have 9 already at 304,000 gp each; cancelling keeps those and only drops the 15 still to buy/);
});

test('buy advice: nothing to price an exit against is said plainly, never treated as a zero margin', () => {
  const [n] = buyMarginAdvice({offers: [brine], prices: {'11037': {buyPrice: 300000, sellPrice: 0}}});
  assert.equal(n.marginPerUnit, null);
  assert.match(n.message, /nobody is selling to buyers at the moment, so EVI cannot price an exit for the 24 you are still buying at 305,170 gp/);
  assert.match(n.message, /EVI has no view on whether that changes/);
});

test('buy advice: what it cannot read, it says nothing about', () => {
  assert.deepEqual(buyMarginAdvice({offers: [brine], prices: {}}), [], 'no price data at all');
  assert.deepEqual(buyMarginAdvice({offers: [{...brine, filled: 24}], prices: prices(300000)}), [], 'nothing left to cancel');
  assert.deepEqual(buyMarginAdvice({offers: [{...brine, price: 0}], prices: prices(300000)}), [], 'no offer price');
  assert.deepEqual(buyMarginAdvice({offers: null, prices: prices(300000)}), []);
});
