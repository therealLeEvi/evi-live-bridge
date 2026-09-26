import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../bridge/store.mjs';

// A purchase that filled while the bridge was stopped leaves EVI holding stock with no cost behind
// it: it cannot warn that a later sale loses GP, and that sale lands as an unmatched sale instead of
// a completed trade. These cover telling EVI about it afterwards, and the line between what EVI
// watched happen and what it was told.
const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-record-'));
  t.after(() => { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
  return {dir, store: new Store(dir)};
};
const BOUGHT_AT = Date.UTC(2026, 8, 26, 1, 19); // 26 Sep 2026, the real case this came from
const purchase = {itemId: 28919, name: 'Tonalztics of Ralos (uncharged)', quantity: 1,
  unitPrice: 45144802, at: BOUGHT_AT, account: 'novi'};

test('a recorded purchase becomes stock EVI knows the cost of', t => {
  const {store} = setup(t);
  const res = store.recordPurchase(purchase);
  assert.equal(res.recorded, 1);
  assert.equal(res.cost, 45144802);
  const held = store.state().autoOpenPositions.filter(p => p.itemId === 28919);
  assert.equal(held.length, 1, 'it must show as stock being held');
  assert.equal(held[0].remaining, 1);
  assert.equal(Math.round(held[0].unitCost), 45144802, 'at exactly the price given, with nothing added');
});

test('it survives a restart, because it is written to the journal like everything else', t => {
  const {dir, store} = setup(t);
  store.recordPurchase(purchase);
  const reloaded = new Store(dir);
  assert.equal(reloaded.state().autoOpenPositions.filter(p => p.itemId === 28919).length, 1);
});

test('a later sale matches against it and becomes a completed trade, not an unmatched sale', t => {
  const {store} = setup(t);
  store.recordPurchase(purchase);
  // The sale EVI does observe, at the price this item was actually listed for.
  store.apply({type: 'packet', received: BOUGHT_AT + 9 * 3600000, packet: {
    version: 1, session: 's1', account: 'novi', seq: 1, ts: BOUGHT_AT + 9 * 3600000, loggedIn: true,
    offers: [{slot: 0, state: 'SOLD', offerId: 'sell-1', itemId: 28919,
      name: 'Tonalztics of Ralos (uncharged)', price: 47897417, total: 1, filled: 1,
      spent: 47897417, knownStart: true}],
  }});
  const st = store.state();
  const flips = st.autoFlips.filter(f => f.itemId === 28919);
  assert.equal(flips.length, 1, 'the sale must match the recorded purchase');
  assert.equal(flips[0].capital, 45144802);
  // EVI applies its own tax model to the sale, exactly as it would to one it watched from the start.
  assert.ok(flips[0].profit > 1700000 && flips[0].profit < 1850000,
    'profit should land near 1.79m, got ' + flips[0].profit);
  assert.equal(st.dataHealth.unmatchedSales, 0, 'and it must no longer count as a sale with no purchase');
});

test('what EVI was told is distinguishable from what EVI watched', t => {
  const {store} = setup(t);
  const {offerId} = store.recordPurchase(purchase);
  assert.ok(offerId.startsWith('recorded:'), 'the identifier itself says so: ' + offerId);
  assert.equal(store.offers.get(offerId).recorded, true);
});

test('recording the same purchase twice does not create two lots', t => {
  const {store} = setup(t);
  const first = store.recordPurchase(purchase);
  const again = store.recordPurchase(purchase);
  assert.equal(again.duplicate, true);
  assert.equal(again.recorded, 0);
  assert.equal(again.offerId, first.offerId);
  assert.equal(store.state().autoOpenPositions.filter(p => p.itemId === 28919).length, 1);
});

test('it can be taken back out again, since a mistake here misstates profit', t => {
  const {store} = setup(t);
  const {offerId} = store.recordPurchase(purchase);
  assert.equal(store.recordPurchase({offerId, remove: true}).removed, 1);
  assert.equal(store.state().autoOpenPositions.filter(p => p.itemId === 28919).length, 0);
  assert.equal(store.recordPurchase({offerId, remove: true}).removed, 0, 'removing it twice is not an error');
});

test('nonsense is refused rather than stored', t => {
  const {store} = setup(t);
  const bad = [
    [{...purchase, itemId: 0}, 'no item'],
    [{...purchase, name: ''}, 'no name'],
    [{...purchase, quantity: 0}, 'no quantity'],
    [{...purchase, quantity: 1.5}, 'a fractional quantity'],
    [{...purchase, unitPrice: 0}, 'no price'],
    [{...purchase, unitPrice: -5}, 'a negative price'],
    [{...purchase, at: Date.now() + 86400000}, 'a purchase in the future'],
    [{...purchase, at: Date.UTC(2024, 0, 1)}, 'a purchase from before the tax EVI models'],
  ];
  for (const [input, why] of bad) assert.throws(() => store.recordPurchase(input), undefined, 'must refuse ' + why);
  assert.equal(store.state().autoOpenPositions.length, 0, 'and nothing must have been stored');
});
