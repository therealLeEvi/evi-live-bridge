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
import {computeHoldingSuggestion, holdingPreempts, hasLiveSellOffer, comparableAsHistoryPick} from '../bridge/suggestions.mjs';

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

test('what counts as "on the market" is the live slot snapshot, not the journal', () => {
  // The journal keeps an offer's state until the bridge SEES it end, so anything cancelled or
  // collected while the bridge was down stays SELLING for ever. On one player's journal, 28 Sept: 64 offers
  // still marked open while the plugin was reporting 8 -- the Grand Exchange's entire capacity -- with
  // 33 SELLING records over 29 distinct items whose last refresh was more than a day earlier, the
  // oldest 343 hours. Reading those as "already listed" silences the holding reminder for 29 items the
  // player is not selling, which is the opposite of the fault the check exists for.
  //
  // Store.state().active is the plugin's snapshot of the eight slots with finished offers dropped --
  // the same source the wealth view already uses. An offer is in a slot or it is not; no staleness
  // heuristic and no time window to defend.
  const me = 'acct-1';
  const listed = {itemId: 22789, state: 'SELLING', account: me};

  assert.equal(hasLiveSellOffer([listed], 22789, me), true);
  assert.equal(hasLiveSellOffer([], 22789, me), false, 'nothing in a slot: nothing is listed');

  // Everything that must not count as this item being on the market.
  assert.equal(hasLiveSellOffer([{...listed, state: 'BUYING'}], 22789, me), false, 'a buy is not a listing');
  assert.equal(hasLiveSellOffer([{...listed, state: 'SOLD'}], 22789, me), false);
  assert.equal(hasLiveSellOffer([{...listed, account: 'someone-else'}], 22789, me), false, 'another account');
  assert.equal(hasLiveSellOffer([{...listed, itemId: 999}], 22789, me), false);
  assert.equal(hasLiveSellOffer(null, 22789, me), false);
  assert.equal(hasLiveSellOffer([listed], 22789, undefined), false, 'no account: cannot tell whose it is');
  assert.equal(hasLiveSellOffer([listed], NaN, me), false);

  // One of several slots, and junk in the list, are both handled.
  assert.equal(hasLiveSellOffer([null, {itemId: 1, state: 'BUYING', account: me}, listed], 22789, me), true);
});

// -- "Best of both" compares two BUYS, never a buy against stock you already own. --
// 30 Sept 2026: a player held one Gilded d'hide vambraces with free slots and could not get EVI to
// mention it even at "No minimum at all" -- which bypasses holdingPreempts and lands on this gate
// instead. The bridge's own logged reason: "Your own Gilded d'hide vambraces is worth about 209,700
// gp ... against 1,114,253 gp for this market-wide pick, so EVI set your history aside this time."
test('a holding is never set aside as if it were a competing buy', () => {
  const holding = {itemId: 23261, action: 'sell', source: 'holding', name: "Gilded d'hide vambraces"};
  assert.equal(comparableAsHistoryPick(holding, 'both'), false,
    'selling stock you own and buying something new are not alternatives: you can do both');
  assert.equal(comparableAsHistoryPick({itemId: 1, action: 'sell', source: 'inventory'}, 'both'), false,
    'idle stock is not a competing buy either');
});

test('two buys are still compared, which is what the setting is for', () => {
  const buy = {itemId: 20104, action: 'buy', source: 'personal'};
  assert.equal(comparableAsHistoryPick(buy, 'both'), true);
  // ...and only under "Best of both": the other two settings decide by tier order, not by value.
  assert.equal(comparableAsHistoryPick(buy, 'history'), false);
  assert.equal(comparableAsHistoryPick(buy, 'market'), false);
  assert.equal(comparableAsHistoryPick(null, 'both'), false);
});
