// A buy that has been open longer than the player's own pace, stated as fact and nothing more.
// See bridge/buyProgress.mjs for why this does NOT claim the offer is dead: the six-hour figure
// CLAUDE.md recorded for that turned out to be an artifact of the bridge only watching while
// RuneLite is open (tools/buy-gain-timing.mjs, 1 Oct 2026).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buyProgressAdvice} from '../bridge/buyProgress.mjs';

const NOW = 1_800_000_000_000;
const offer = (over = {}) => ({itemId: 20104, name: "Ankou's leggings", total: 3, filled: 0,
  firstSeen: NOW - 6 * 3600_000, ...over});

test('speaks once the offer is older than the pace the player set', () => {
  const [card] = buyProgressAdvice({offers: [offer()], targetDurationMinutes: 120, now: NOW});
  assert.equal(card.itemId, 20104);
  assert.equal(card.label, 'No fills yet');
  assert.match(card.figures, /0\/3/);
  assert.match(card.figures, /open 6h/);
});

test('says nothing before the pace has elapsed', () => {
  // Two hours set, one hour open: there is nothing surprising yet, and a card would be noise.
  assert.deepEqual(
    buyProgressAdvice({offers: [offer({firstSeen: NOW - 3600_000})], targetDurationMinutes: 120, now: NOW}), []);
});

test('says nothing at all when no pace is set', () => {
  // Without the player's own expectation there is no bar, and EVI must not invent one -- the whole
  // point of this check is that the threshold belongs to them, not to us.
  assert.deepEqual(buyProgressAdvice({offers: [offer()], now: NOW}), []);
  assert.deepEqual(buyProgressAdvice({offers: [offer()], targetDurationMinutes: 0, now: NOW}), []);
});

test('a completed buy is not mentioned', () => {
  assert.deepEqual(
    buyProgressAdvice({offers: [offer({filled: 3})], targetDurationMinutes: 120, now: NOW}), []);
});

test('never doubles up with the warning slotFill is already showing', () => {
  // "May not fill in time" already says something overlapping about that offer; two cards about one
  // offer is how a sidebar becomes wallpaper.
  assert.deepEqual(buyProgressAdvice({offers: [offer()], targetDurationMinutes: 120, now: NOW,
    alreadyFlagged: new Set([20104])}), []);
});

test('it predicts nothing, and says so', () => {
  // The standard every check here is held to. The six-hour "this buy is dead" rule was dropped
  // precisely because the data could not support it, so nothing in this wording may imply one.
  const [card] = buyProgressAdvice({offers: [offer({filled: 1})], targetDurationMinutes: 120, now: NOW});
  assert.equal(card.label, 'Part filled');
  assert.match(card.message, /not predicting whether it will fill/);
  assert.doesNotMatch(card.message, /dead|finished|will not fill|won't fill|cancel/i,
    'no claim about the offer being finished, and no instruction to cancel');
});

test('the longest-waiting offer comes first, and the list is capped', () => {
  const many = [1, 2, 3, 4, 5].map(i => offer({itemId: i, firstSeen: NOW - i * 3600_000}));
  const out = buyProgressAdvice({offers: many, targetDurationMinutes: 60, now: NOW});
  assert.equal(out.length, 3, 'capped');
  assert.equal(out[0].itemId, 5, 'oldest first');
});
