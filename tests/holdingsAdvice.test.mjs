// "What am I holding" is a different question from "what should I do next", and this is the channel
// that answers it. See bridge/holdingsAdvice.mjs for why the profit bar was NOT lowered instead.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {holdingsAdvice, MAX_LINES} from '../bridge/holdingsAdvice.mjs';

const VAMBRACES = {itemId: 23261, item: "Gilded d'hide vambraces", remaining: 1, unitCost: 4100000};
const PRICES = {23261: {high: 4442921}, 34428: {high: 1550000}, 6697: {high: 60}};

test('a holding is stated whatever the profit setting is -- there is no profit bar here', () => {
  // The whole point. At a 1,000,000 minimum a position netting 254,063 is below the bar, so the suggestion
  // slot is silent about it by design. This channel takes no minimum profit at all: it cannot be
  // passed one, which is the strongest way to guarantee the two stay separate.
  const [line] = holdingsAdvice({positions: [VAMBRACES], prices: PRICES});
  assert.equal(line.itemId, 23261);
  assert.equal(line.quantity, 1);
  assert.equal(line.cost, 4100000);
  assert.ok(line.net > 0 && line.net < 300000, 'net after tax, not the gross sale price: ' + line.net);
  // The card carries the name, quantity and net; the sentence carries only what it cannot fit.
  // Shortened 1 Oct 2026, after a report that the sidebar messages were too long.
  assert.match(line.figures, /1 · \+254,063 after tax/, 'the card shows the quantity and the net');
  assert.match(line.message, /Bought for 4,100,000/);
  assert.match(line.message, /Break-even/);
  assert.match(line.message, /not as advice to sell/,
    'it states what you own; advice belongs in the suggestion slot');
  assert.ok(line.message.length < 120, 'short enough to read at a glance: ' + line.message.length);
});

test('nothing is said about stock with no cost basis -- never a guess', () => {
  assert.deepEqual(holdingsAdvice({positions: [{...VAMBRACES, unitCost: 0}], prices: PRICES}), []);
  assert.deepEqual(holdingsAdvice({positions: [{...VAMBRACES, unitCost: undefined}], prices: PRICES}), []);
});

test('a position already on the market is left to the channels that already speak about offers', () => {
  // It is visible in Active offers, and relist.mjs and sellAdvice.mjs both have things to say about
  // a standing offer. This channel exists for the stock that nothing else mentions.
  assert.deepEqual(
    holdingsAdvice({positions: [VAMBRACES], prices: PRICES, listedItemIds: new Set([23261])}), []);
});

test('the item EVI is suggesting right now is not repeated', () => {
  assert.deepEqual(
    holdingsAdvice({positions: [VAMBRACES], prices: PRICES, suggestedItemId: 23261}), []);
});

test('a loss is stated as plainly as a gain', () => {
  const [line] = holdingsAdvice({positions: [{...VAMBRACES, unitCost: 5000000}], prices: PRICES});
  assert.ok(line.net < 0, 'under water');
  assert.equal(line.label, 'Holding, under water');
  assert.equal(line.level, 'caution');
  // The loss is on the CARD now -- a negative figure under an explicit label -- rather than spelled
  // out again in the sentence. It must still be impossible to miss.
  assert.match(line.figures, /-/, 'the figures row shows it is negative: ' + line.figures);
});

test('no current price means the cost is still shown, and no worth is implied', () => {
  const [line] = holdingsAdvice({positions: [VAMBRACES], prices: {}});
  assert.equal(line.cost, 4100000);
  assert.equal(line.worth, undefined, 'no price, so no worth may be stated');
  assert.equal(line.net, undefined);
  assert.match(line.message, /can't say what it's worth today/);
});

test('the most valuable positions come first, and the list is capped', () => {
  const many = Array.from({length: MAX_LINES + 3}, (_, i) => (
    {itemId: 1000 + i, item: 'Item ' + i, remaining: 1, unitCost: 100}));
  const prices = Object.fromEntries(many.map((p, i) => [p.itemId, {high: 1000 * (i + 1)}]));
  const out = holdingsAdvice({positions: many, prices});
  assert.equal(out.length, MAX_LINES, 'capped so a big bank is not a wall of text');
  assert.ok(out[0].worth > out[out.length - 1].worth, 'most valuable first');
});

test('a trivial holding is allowed here, because it is not competing with a trade', () => {
  // The 152 gp pie must never DISPLACE a real suggestion -- that is what the bar in the suggestion
  // slot is for, and tools/holding-gate.mjs measured that removing it costs GP. On this channel the
  // pie is a line to scroll past, so it is listed rather than filtered.
  const [line] = holdingsAdvice({positions: [{itemId: 6697, item: 'Pat of butter', remaining: 1, unitCost: 49}],
    prices: PRICES});
  assert.equal(line.itemId, 6697);
});
