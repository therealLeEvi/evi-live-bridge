// The holding reminder used to pre-empt everything, unconditionally.
//
// That is right for what it was built for -- closing out a position you already opened beats being
// pointed at a brand-new one -- but it had no sense of scale and no idea whether the position was
// already on the market. On 28 September 2026, with 205m idle and a 1,000,000 gp minimum set, EVI's
// answer was: sell one Uncooked dragonfruit pie "near 1,689 gp" for about 152 gp. That pie had been
// listed at 1,856 since 05:14 -- so the advice was to sell something already for sale, below the
// player's own ask, for 152 gp, while the whole catalogue went unexamined.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeHoldingSuggestion, holdingPreempts, hasLiveSellOffer} from '../bridge/suggestions.mjs';

const PIE = {'22789': {low: 1504, high: 1689}};
const pie = (qty = 1, cost = 1504) => computeHoldingSuggestion(PIE, 22789, qty, 'Uncooked dragonfruit pie', 'buy-1', cost);

test('a holding reports what closing it out is actually worth', () => {
  const s = pie();
  assert.equal(s.netIfSoldNow, 152, 'after tax, against the real cost basis');
  assert.equal(s.lossIfSoldNow, null);
  assert.equal(s.action, 'sell');
  // Unknown cost basis stays unknown rather than being estimated, the standing rule here.
  assert.equal(computeHoldingSuggestion(PIE, 22789, 1, 'pie', 'b', undefined).netIfSoldNow, null);
});

test('a trivial gain does not outrank the entire catalogue', () => {
  assert.equal(holdingPreempts(pie(), 1000000), false, 'the real case: 152 gp against a 1m minimum');
  assert.equal(holdingPreempts(pie(), 500), false, 'and still not against the 500 gp Auto floor');
  // Worth the minimum, so it speaks: this is a position, not a rounding error.
  assert.equal(holdingPreempts(pie(20000), 1000000), true);
});

test('a loss always speaks, whatever it is worth', () => {
  // Warn-don't-block is the standing rule. A position under water must be said out loud even when it
  // is small, because the player needs the number to decide whether to cap the loss.
  const losing = computeHoldingSuggestion({'22789': {low: 1300, high: 1400}}, 22789, 1, 'pie', 'b', 1504);
  assert.ok(losing.netIfSoldNow < 0);
  assert.equal(losing.lossIfSoldNow, 132);
  assert.equal(holdingPreempts(losing, 1000000), true, 'a loss is never filtered out by a minimum');
  assert.match(losing.reasoning, /WARNING/);
});

test('an unknown worth speaks rather than staying quiet', () => {
  // Silence about a position because its cost basis is missing would be exactly the wrong way round.
  const unknown = computeHoldingSuggestion(PIE, 22789, 1, 'pie', 'b', undefined);
  assert.equal(holdingPreempts(unknown, 1000000), true);
  assert.equal(holdingPreempts(null, 1000000), false, 'nothing held is nothing to say');
});

test('no minimum set leaves the old behaviour exactly as it was', () => {
  for (const none of [0, undefined, null, NaN, -5])
    assert.equal(holdingPreempts(pie(), none), true, 'with no minimum, every holding still pre-empts');
});

test('"still SELLING" in the journal is not the same as "on the market"', () => {
  // The journal keeps an offer's state until the bridge sees it end, so one cancelled or collected
  // while the bridge was down stays SELLING forever. On novi's journal, 28 Sept: 33 SELLING records,
  // 2 genuinely live and 30 last refreshed over 24 hours earlier, across 29 distinct items -- against
  // a Grand Exchange that allows eight offers in total. Treating all of those as "listed" would
  // silence the holding reminder for 29 items they are not selling, the opposite of the intended fix.
  const now = Date.UTC(2026, 8, 28, 12);
  const me = 'acct-1';
  const offer = (o = {}) => ({itemId: 22789, state: 'SELLING', account: me, updated: now - 1000, ...o});

  assert.equal(hasLiveSellOffer([offer()], 22789, me, {now}), true, 'refreshed a second ago: live');
  assert.equal(hasLiveSellOffer([offer({updated: now - 4 * 60000})], 22789, me, {now}), true, '4 minutes: still live');
  assert.equal(hasLiveSellOffer([offer({updated: now - 343 * 3600000})], 22789, me, {now}), false,
    'the real ghost: last seen 343 hours ago');
  assert.equal(hasLiveSellOffer([offer({updated: now - 25 * 3600000})], 22789, me, {now}), false);

  // Everything else that must not count as this item being on the market.
  assert.equal(hasLiveSellOffer([offer({state: 'BUYING'})], 22789, me, {now}), false, 'a buy is not a listing');
  assert.equal(hasLiveSellOffer([offer({state: 'SOLD'})], 22789, me, {now}), false);
  assert.equal(hasLiveSellOffer([offer({account: 'someone-else'})], 22789, me, {now}), false, 'another account');
  assert.equal(hasLiveSellOffer([offer({itemId: 999})], 22789, me, {now}), false);
  assert.equal(hasLiveSellOffer([offer({updated: undefined})], 22789, me, {now}), false, 'no timestamp, no claim');
  assert.equal(hasLiveSellOffer([], 22789, me, {now}), false);
  assert.equal(hasLiveSellOffer(null, 22789, me, {now}), false);
  assert.equal(hasLiveSellOffer([offer()], 22789, undefined, {now}), false, 'no account: cannot tell');

  // A ghost and a live offer for the same item: the live one wins.
  assert.equal(hasLiveSellOffer([offer({updated: now - 300 * 3600000}), offer()], 22789, me, {now}), true);
});
