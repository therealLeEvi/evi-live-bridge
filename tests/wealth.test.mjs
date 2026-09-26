import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {wealthSnapshot, createWealthLog} from '../bridge/wealth.mjs';

const priceOf = id => ({4151: {buyPrice: 990000, sellPrice: 1000000}, 11037: {buyPrice: 300000, sellPrice: 305000}, 999: null}[id] || null);

test('wealth: cash, coins the GE is holding, and stock at what it would fetch today after tax', () => {
  const w = wealthSnapshot({
    cash: 50_000_000,
    buyOffers: [{itemId: 11037, price: 300000, total: 24, filled: 4}],          // 20 x 300,000 still held by the GE
    sellOffers: [{itemId: 4151, total: 3, filled: 1, unitCost: 950000}],        // 2 whips listed
    positions: [{itemId: 4151, remaining: 5, unitCost: 900000}],
    priceOf, now: 1000,
  });
  assert.equal(w.cash, 50_000_000);
  assert.equal(w.inBuyOffers, 6_000_000, 'the GE took 20 x 300,000 when the offer was placed');
  assert.equal(w.inSellOffers, 2 * 980000, 'a whip at 1,000,000 nets 980,000 after the 2% tax');
  // The journal holds 5 whips open and 2 of them are the ones listed above, so only 3 are held
  // outside the GE -- counting all 5 would count those 2 twice.
  assert.equal(w.held, 3 * 980000);
  assert.equal(w.stockCost, 2 * 950000 + 3 * 900000, 'each unit costed once');
  assert.equal(w.unrealised, w.inSellOffers + w.held - w.stockCost, 'every unit here has a known cost');
  assert.equal(w.uncostedUnits, 0);
  assert.equal(w.total, 50_000_000 + 6_000_000 + 5 * 980000);
  assert.equal(w.outsideCash, 6_000_000 + 5 * 980000);
  assert.equal(w.unpricedUnits, 0);
});

test('wealth: an unknown cash stack leaves the total unknown rather than reading as a loss', () => {
  const w = wealthSnapshot({positions: [{itemId: 4151, remaining: 1, unitCost: 900000}], priceOf});
  assert.equal(w.cash, null);
  assert.equal(w.total, null, 'never a number that quietly leaves the stack out');
  assert.equal(w.outsideCash, 980000, 'what EVI can see is still reported');
});

test('wealth: stock with no current price is carried at what was paid and counted as unpriced', () => {
  const w = wealthSnapshot({cash: 0, positions: [{itemId: 999, remaining: 4, unitCost: 1000}], priceOf});
  assert.equal(w.held, 4000, 'what was paid, so a missing price cannot look like a loss');
  assert.equal(w.unpricedUnits, 4);
  assert.equal(w.uncostedUnits, 0);
  assert.equal(w.unrealised, 0);
  // Nothing held at all: no cost, so no unrealised figure is invented.
  assert.equal(wealthSnapshot({cash: 5, priceOf}).unrealised, null);
});

test('wealth log: throttled per account, and change over a window compares against a real earlier record', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-wealth-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const log = createWealthLog(dir, {everyMs: 60000});
  const snap = total => ({at: 0, cash: total, inBuyOffers: 0, inSellOffers: 0, held: 0, stockCost: 0, unrealised: null, unpricedUnits: 0, total, outsideCash: 0});
  const T = Date.UTC(2026, 8, 20, 12);
  assert.equal(log.record({account: 'a', snapshot: snap(100), now: T}), true);
  assert.equal(log.record({account: 'a', snapshot: snap(110), now: T + 30000}), false, 'a two-second poll must not fill the log');
  assert.equal(log.record({account: 'b', snapshot: snap(1), now: T + 30000}), true, 'per account');
  assert.equal(log.record({account: 'a', snapshot: snap(120), now: T + 26 * 3600000}), true);
  assert.equal(log.record({account: 'a', snapshot: {...snap(0), total: null}, now: T + 27 * 3600000}), false, 'no stack, nothing to chart');
  const day = log.changeOver(24, {now: T + 26 * 3600000, account: 'a'});
  assert.deepEqual([day.fromTotal, day.toTotal, day.gp], [100, 120, 20]);
  assert.equal(log.changeOver(24 * 7, {now: T + 26 * 3600000, account: 'a'}), null, 'nothing a week old to compare against yet');
  assert.equal(log.recent().length, 3);
});

// Live on 20 Sep: 316m of stock against 76m of recorded cost, because a 246m listed item had no
// recorded purchase at all. Counting its whole value as unrealised profit read as +240m.
test('wealth: stock with no recorded cost is left out of unrealised profit and counted separately', () => {
  const w = wealthSnapshot({
    cash: 0,
    sellOffers: [{itemId: 4151, total: 1, filled: 0}, {itemId: 11037, total: 2, filled: 0, unitCost: 290000}],
    priceOf,
  });
  assert.equal(w.inSellOffers, 980000 + 2 * (305000 - Math.round(305000 * 0.02)), 'both are still worth what they would fetch');
  assert.equal(w.uncostedUnits, 1, 'the whip EVI never saw bought');
  assert.equal(w.costedStock, 2 * (305000 - Math.round(305000 * 0.02)));
  assert.equal(w.unrealised, w.costedStock - 2 * 290000, 'unrealised covers only the stock whose cost is known');
});

// Found against the real journal on 20 Sep: three of four open positions were sitting in sell offers
// at that moment, and their value was counted twice -- once as listed, once as held.
test('wealth: stock listed in a sell offer is not counted again as held', () => {
  const net = 305000 - Math.round(305000 * 0.02);
  const w = wealthSnapshot({
    cash: 0,
    // 3 held by the journal, 2 of them listed right now.
    sellOffers: [{itemId: 11037, total: 2, filled: 0, unitCost: 290000}],
    positions: [{itemId: 11037, remaining: 3, unitCost: 290000}],
    priceOf,
  });
  assert.equal(w.inSellOffers, 2 * net);
  assert.equal(w.held, 1 * net, 'only the unlisted unit');
  assert.equal(w.stockCost, 3 * 290000, 'all three still cost what they cost, once each');
  assert.equal(w.total, 3 * net);
  // A partly filled sell offer only covers what is still listed.
  const partial = wealthSnapshot({cash: 0, sellOffers: [{itemId: 11037, total: 3, filled: 2, unitCost: 290000}],
    positions: [{itemId: 11037, remaining: 3, unitCost: 290000}], priceOf});
  assert.equal(partial.inSellOffers, 1 * net);
  assert.equal(partial.held, 2 * net);
  // More listed than the journal knows about (stock from the bank): the extra is not subtracted twice.
  const extra = wealthSnapshot({cash: 0, sellOffers: [{itemId: 11037, total: 5, filled: 0}],
    positions: [{itemId: 11037, remaining: 1, unitCost: 290000}], priceOf});
  assert.equal(extra.inSellOffers, 5 * net);
  assert.equal(extra.held, 0);
});
