import {breakEvenSellPrice} from './suggestions.mjs';
import {estimateUnitTax} from './tax.mjs';

// "The price you are asking does not cover what you paid." -- for a SELL offer already standing.
//
// Asked for after a week of the player's own Copilot log was measured. Six flips lost money that
// week, and **five of them lost to the Grand Exchange tax rather than to the market**: a Light
// ballista sold 0.1% ABOVE what it cost and still lost 100,160 gp; an Echo virtus ornament kit sold
// 0.7% above and lost 51,036. Across the week the tax came to 17,425,864 gp against 7,810,490 gp of
// net profit. None of EVI's existing checks had anything to say, and they were right not to: the
// sell-support and fill-history checks exist to catch a margin that was never real at purchase, and
// these margins were real -- they were simply smaller than the 2% that leaves on the way out.
//
// EVI already knew everything needed to catch it. It has the cost basis from its own journal and it
// has the tax model; the scanner even shows "least you can sell for and still break even" on the
// item. What was missing was anyone saying so about an offer already standing in a slot. That gap is
// this file.
//
// Deliberately narrow, so it says nothing that is already being said elsewhere:
//   * relist.mjs speaks when an ask sits ABOVE the market and is not filling. This speaks when an
//     ask is below the seller's own break-even, which is a different fault and can be true of an
//     offer filling perfectly well -- that is exactly what makes it worth saying.
//   * It is about the player's own cost, not a market view, so it never predicts anything.
//   * With no cost basis it says nothing at all rather than guessing what was paid, the same
//     fail-open rule as every other check here.
//   * It warns; it never cancels, edits or re-prices an offer. Selling at a loss is sometimes the
//     right call, and that call is the player's.

// Below this the "loss" is rounding rather than a decision worth interrupting anyone for: one gp of
// tax rounding on a cheap item should not produce a warning. Relative to what the stock cost, so it
// means the same on a 500 gp item as on a 50m one.
export const MIN_LOSS_SHARE = 0.001;

/**
 * offers: the player's live SELL offers -- {itemId, name, price, remaining}.
 * costBasis: itemId -> what was actually paid per unit, from the journal, where it is known.
 * Returns one entry per offer worth mentioning, newest caller decides how to show them.
 */
export function sellAdvice({offers, costBasis = new Map()} = {}) {
  const out = [];
  for (const offer of offers || []) {
    if (!offer || !(offer.price > 0)) continue;
    const remaining = Number.isFinite(offer.remaining) && offer.remaining > 0 ? offer.remaining : null;
    const paid = costBasis instanceof Map ? costBasis.get(offer.itemId) : costBasis?.[offer.itemId];
    if (!(paid > 0)) continue;                       // no cost basis: nothing honest to say
    const breakEven = breakEvenSellPrice(offer.itemId, paid);
    if (!(breakEven > 0) || offer.price >= breakEven) continue;
    // What the ask actually returns per unit after tax, against what the unit cost.
    const netEach = offer.price - estimateUnitTax(offer.itemId, offer.price);
    const lossEach = paid - netEach;
    if (!(lossEach > 0) || lossEach / paid < MIN_LOSS_SHARE) continue;
    const units = remaining ?? 1;
    const gp = n => Math.round(n).toLocaleString('en-US');
    const name = offer.name || ('item ' + offer.itemId);
    const scope = remaining === null ? '' : ` on the ${gp(remaining)} still unsold`;
    out.push({
      itemId: offer.itemId,
      breakEven,
      lossEach: Math.round(lossEach),
      lossTotal: Math.round(lossEach * units),
      message: `${name}: your sell at ${gp(offer.price)} gp is BELOW your break-even of ${gp(breakEven)} gp. `
        + `After tax it returns ${gp(netEach)} gp against the ${gp(paid)} gp it cost, so it loses about `
        + `${gp(lossEach)} gp each${scope} (${gp(lossEach * units)} gp in total). `
        + `Selling at a loss is sometimes right -- EVI just won't let it happen quietly.`,
    });
  }
  return out;
}
