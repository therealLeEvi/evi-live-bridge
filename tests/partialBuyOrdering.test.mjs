import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../bridge/store.mjs';

// Sell the part of a buy that has filled, while the rest is still running, then cancel the
// remainder. That is ordinary flipping, and it used to produce an unmatched sale instead of a flip.
//
// Taken from a real case on 27 September 2026: 48 Dragon med helms offered at 25,000, eight of them
// filled 79 minutes later, those eight sold at 49,869, and the rest was cancelled 37 minutes after
// the sale. EVI orders a purchase by when it FIRST FILLED, which it reads from the plugin's
// ticksToFill -- and the final cancel packet reports ticksToFill as -1. The store took the newest
// packet's value wholesale, so the good count was overwritten by the -1, the code fell back to when
// the offer finished (after the sale), and FIFO decided the sale had no purchase behind it.
const ID = 1149, NAME = 'Dragon med helm';
const setup = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-partial-'));
  t.after(() => { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
  return new Store(dir);
};
const AT = (h, m) => Date.UTC(2026, 8, 27, h, m);
// One packet carrying whatever offers are in the slots at that moment.
const send = (store, seq, ts, offers) => store.apply({type: 'packet', received: ts, packet: {
  version: 1, session: 's1', account: 'novi', seq, ts, loggedIn: true, offers,
}});
const buy = (filled, state, ticksToFill) => ({slot: 0, state, offerId: 'buy-1', itemId: ID, name: NAME,
  price: 25000, total: 48, filled, spent: filled * 25000, knownStart: true, ticksToFill});
const sell = (filled, state, ticksToFill) => ({slot: 1, state, offerId: 'sell-1', itemId: ID, name: NAME,
  price: 49869, total: 8, filled, spent: filled * 49869, knownStart: true, ticksToFill});

function realTimeline(store) {
  send(store, 1, AT(22, 24), [buy(0, 'BUYING', -1)]);              // placed, nothing filled yet
  send(store, 2, AT(23, 43), [buy(1, 'BUYING', 7953)]);            // first fill, 79 minutes later
  send(store, 3, AT(0, 36) + 86400000, [buy(8, 'BUYING', 7953)]);  // eight of them, next day
  send(store, 4, AT(0, 48) + 86400000, [buy(8, 'BUYING', 7953), sell(0, 'SELLING', -1)]);
  send(store, 5, AT(0, 49) + 86400000, [buy(8, 'BUYING', 7953), sell(8, 'SOLD', 73)]);
  // The cancel, 37 minutes after the sale, reporting no tick count at all.
  send(store, 6, AT(1, 26) + 86400000, [buy(8, 'CANCELLED_BUY', -1)]);
}

test('selling the filled part of a buy before cancelling the rest is a flip, not an unmatched sale', t => {
  const store = setup(t);
  realTimeline(store);
  const st = store.state();
  const flips = st.autoFlips.filter(f => f.itemId === ID);
  assert.equal(flips.length, 1, 'the sale must match the purchase it actually came from');
  assert.equal(flips[0].quantity, 8);
  assert.equal(flips[0].capital, 200000);
  // 8 sold at 49,869 is 398,952 gross; the tax is 997 each, so 390,976 net against 200,000 paid.
  assert.equal(flips[0].profit, 190976);
  assert.equal(st.autoUnmatchedSells.filter(o => o.itemId === ID).length, 0,
    'and it must not also be reported as a sale with no purchase behind it');
  assert.equal(st.dataHealth.unmatchedSales, 0);
});

test('the tick count that says when a buy first filled survives a packet that omits it', t => {
  const store = setup(t);
  realTimeline(store);
  const buyOffer = [...store.offers.values()].find(o => o.offerId === 'buy-1');
  assert.equal(buyOffer.ticksToFill, 7953,
    'the cancel packet reports -1; the count from when it actually filled must not be lost');
  assert.equal(buyOffer.state, 'CANCELLED_BUY', 'everything else still comes from the newest packet');
  assert.equal(buyOffer.filled, 8);
});

test('an offer that never reported a tick count still has none invented for it', t => {
  const store = setup(t);
  send(store, 1, AT(22, 0), [buy(0, 'BUYING', -1)]);
  send(store, 2, AT(23, 0), [buy(4, 'BUYING', -1)]);
  send(store, 3, AT(23, 30), [buy(4, 'CANCELLED_BUY', -1)]);
  const buyOffer = [...store.offers.values()].find(o => o.offerId === 'buy-1');
  assert.ok(!(buyOffer.ticksToFill >= 0), 'no count was ever reported, so none should exist: ' + buyOffer.ticksToFill);
});

test('a later, better tick count replaces an earlier one rather than being ignored', t => {
  const store = setup(t);
  send(store, 1, AT(22, 0), [buy(0, 'BUYING', -1)]);
  send(store, 2, AT(22, 30), [buy(1, 'BUYING', 3000)]);
  send(store, 3, AT(23, 0), [buy(8, 'BUYING', 2500)]);
  const buyOffer = [...store.offers.values()].find(o => o.offerId === 'buy-1');
  assert.equal(buyOffer.ticksToFill, 2500, 'the newest real reading wins; only a missing one falls back');
});

// The dangerous half of the fix. The store journals a packet only when something changed, by
// comparing each field the packet carries against what it holds. Keeping a better fill time than
// the packet reports means the two legitimately differ -- and if that counted as a change, every
// heartbeat after a cancel would append to the journal, on a two-second poll, forever. This uses
// ingest() rather than apply(), because only ingest writes.
test('heartbeats after a cancel do not grow the journal, even though we kept a better fill time', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-partial-'));
  t.after(() => { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
  const store = new Store(dir);
  const lines = () => { try { return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
  // A full eight-slot snapshot, the shape the plugin really sends.
  const snapshot = (seq, ts, offers) => {
    const slots = Array.from({length: 8}, (_, slot) => ({slot, state: 'EMPTY', offerId: 'empty-' + slot,
      itemId: 0, name: '', price: 0, total: 0, filled: 0, spent: 0, knownStart: false}));
    for (const o of offers) slots[o.slot] = o;
    store.ingest({version: 1, session: 's1', account: 'novi', seq, ts, loggedIn: true, offers: slots}, ts + 1000);
  };
  snapshot(1, AT(22, 24), [buy(0, 'BUYING', -1)]);
  snapshot(2, AT(23, 43), [buy(1, 'BUYING', 7953)]);
  snapshot(3, AT(0, 36) + 86400000, [buy(8, 'BUYING', 7953)]);
  snapshot(4, AT(0, 49) + 86400000, [buy(8, 'BUYING', 7953), sell(8, 'SOLD', 73)]);
  snapshot(5, AT(1, 26) + 86400000, [buy(8, 'CANCELLED_BUY', -1)]);
  const settled = lines();
  assert.ok(settled > 0, 'the run so far must have been journalled at all');
  // The same cancelled offer, polled repeatedly, exactly as the plugin would.
  for (let i = 0; i < 5; i++) snapshot(6 + i, AT(1, 30 + i) + 86400000, [buy(8, 'CANCELLED_BUY', -1)]);
  assert.equal(lines(), settled, 'nothing changed, so nothing should have been written');
  assert.equal([...store.offers.values()].find(o => o.offerId === 'buy-1').ticksToFill, 7953,
    'and the fill time survived all of those heartbeats');
  assert.equal(store.state().autoFlips.filter(f => f.itemId === ID).length, 1, 'so the flip still matches');
});
