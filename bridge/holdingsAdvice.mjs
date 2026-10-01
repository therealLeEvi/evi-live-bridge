import {breakEvenSellPrice} from './suggestions.mjs';
import {estimateUnitTax} from './tax.mjs';

// "Here is what you are holding." -- every tracked position, always, whatever the profit setting.
//
// Asked for by novi on 30 September 2026, in the words that name the actual problem: "I do think it
// should be able to see it no matter the profit setting since it is a item we bought, is it possible
// to make those two separate?"
//
// THE SEPARATION THIS FILE IS. "What should I do next" and "what am I holding" had been sharing one
// channel -- the single suggestion slot -- and so a holding had to win a contest against a new trade
// to be mentioned at all. It lost that contest for structural reasons rather than for being a bad
// position: `holdingPreempts` judges it against the player's MINIMUM PROFIT, a bar set for choosing
// between new trades. With that bar at 1,000,000, a Gilded d'hide vambraces worth +254,063 over cost
// was invisible, and the richer the player's settings get the more of their own stock disappears.
//
// The measurement said not to fix that by lowering the bar (tools/holding-gate.mjs, 150 positions of
// novi's own): mentioning more holdings in the SUGGESTION slot would have cost GP, because selling a
// position the first hour it clears a low bar is worse than waiting. Two of the three candidate rules
// were ruled out outright -- a per-item tax multiple spends 29% of its words on stock worth under
// 10,000 gp, and no bar at all spends 37%, which is the 152 gp pie the rule exists to prevent.
//
// So the bar stays where it is and the QUESTION moves. These lines ride `relistAdvice`, the channel
// sellAdvice.mjs, buyAdvice.mjs and crashWatch.mjs already use to speak in the sidebar without
// touching the suggestion -- so no plugin change, no competition for the slot, and no pie risk: a
// trivial line here is something to scroll past, not advice displacing a real trade.
//
// Deliberately narrow, on the same principles as its siblings:
//   * Only positions with a REAL cost basis from the journal. No basis, no line -- never a guess.
//   * Nothing about a position already standing in a sell slot: it is visible in Active offers, and
//     relist.mjs and sellAdvice.mjs already speak about offers. This is for the stock nothing else
//     mentions, which is exactly the stock that was disappearing.
//   * Silent about the item EVI is suggesting right now, so the sidebar never says it twice.
//   * It states; it never advises. No "you should sell this" -- the suggestion slot is where advice
//     lives, and the whole point of this file is that these two are different things.
//   * A loss is stated as plainly as a gain. Hiding it would be the same fault in the other
//     direction.

// At most this many lines, so a player holding thirty things does not get a wall of text. The most
// valuable positions first, because that is the order in which forgetting one is expensive.
export const MAX_LINES = 5;

/**
 * positions: this account's open positions -- {itemId, item, remaining, unitCost}.
 * prices:    itemId -> {high} -- what a seller gets now. A position with no price is still LISTED,
 *            with its cost and no worth, because "I own this and cannot price it" is worth knowing.
 * listedItemIds: items already standing in a sell offer; skipped.
 * suggestedItemId: the item EVI is suggesting this poll; skipped.
 */
export function holdingsAdvice({positions = [], prices = {}, listedItemIds = new Set(),
  suggestedItemId = null, max = MAX_LINES} = {}) {
  const listed = listedItemIds instanceof Set ? listedItemIds : new Set(listedItemIds || []);
  const gp = n => Math.round(n).toLocaleString('en-US');
  const rows = [];

  for (const p of positions || []) {
    if (!p || !Number.isFinite(p.itemId)) continue;
    const qty = Number.isFinite(p.remaining) && p.remaining > 0 ? p.remaining : 0;
    if (!qty) continue;
    if (!(p.unitCost > 0)) continue;                 // no cost basis: nothing honest to say
    if (listed.has(p.itemId)) continue;              // already on the market and already visible
    if (p.itemId === suggestedItemId) continue;      // already the suggestion; do not say it twice

    const name = p.item || ('item ' + p.itemId);
    const cost = p.unitCost * qty;
    const price = prices?.[String(p.itemId)]?.high ?? prices?.[p.itemId]?.high ?? null;
    const breakEven = breakEvenSellPrice(p.itemId, p.unitCost);
    const row = {itemId: p.itemId, name, quantity: qty, unitCost: Math.round(p.unitCost),
      cost: Math.round(cost), breakEven: breakEven > 0 ? breakEven : null, holding: true};

    if (!(price > 0)) {
      // No current price. Say so rather than implying a worth, and sort it last by treating its
      // worth as its cost -- it is still real capital and still worth seeing.
      row.sortBy = cost;
      row.level = 'info';
      row.label = 'Holding';
      row.figures = `${gp(qty)} · cost ${gp(cost)}`;
      // Short on purpose: the card above already shows the item name and the quantity, so repeating
      // them is spending the reader's attention on what is already on screen. Shortened 1 Oct 2026.
      row.message = `Cost ${gp(cost)}`
        + (breakEven > 0 ? `. Break-even ${gp(breakEven)} each` : '')
        + `. No current price, so EVI can't say what it's worth today.`;
      rows.push(row);
      continue;
    }

    const net = (price - p.unitCost - estimateUnitTax(p.itemId, price)) * qty;
    row.worth = Math.round(price * qty);
    row.net = Math.round(net);
    row.sortBy = price * qty;
    row.level = net >= 0 ? 'info' : 'caution';
    row.label = net >= 0 ? 'Holding' : 'Holding, under water';
    row.figures = `${gp(qty)} · ${net >= 0 ? '+' : ''}${gp(net)} after tax`;
    // The card carries the name, the quantity and the net already, so the sentence adds only what it
    // cannot fit: what was paid, break-even, and why this is listed at all. Shortened 1 Oct 2026.
    row.message = `Bought for ${gp(cost)}`
      + (breakEven > 0 ? `. Break-even ${gp(breakEven)} each` : '')
      + `. Listed because you own it, not as advice to sell.`;
    rows.push(row);
  }

  rows.sort((a, b) => b.sortBy - a.sortBy);
  return rows.slice(0, Math.max(0, max)).map(({sortBy, ...rest}) => rest);
}
