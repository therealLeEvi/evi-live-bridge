import {breakEvenSellPrice} from './suggestions.mjs';

// "This hasn't sold. Here is what it would take." -- the one change measured to cut stuck capital
// most (see the 2026-09-18 backtest entry in README.md: repricing toward the market with a floor at
// break-even took stuck capital from 45% to 26% on a 50m stack and from 29% to 13% on a 2m one, for
// about 3% less realised profit at the smaller sizes).
//
// EVI never relists anything itself -- it has never placed, edited or cancelled an offer and this
// does not change that. This produces a sentence for the sidebar; the player decides and clicks.
//
// Three rules keep it honest:
//  * It only speaks when the offer has genuinely been sitting: a share of the player's own target
//    trade duration, so a 2-hour trader hears sooner than a 24-hour one, never before MIN_WAIT.
//  * It never suggests a price below break-even. Selling under what you paid is a decision for the
//    player, made with the loss stated plainly (the holding suggestion already does that), not
//    something EVI nudges you into to tidy up a number.
//  * With no cost basis it stays quiet about break-even rather than guessing what was paid.

// How much of the target duration an offer waits before this speaks. A quarter matches what the
// backtest tested (6 hours into a 24-hour window) and scales to any window the player picks.
export const RELIST_AFTER_SHARE = 0.25;
export const MIN_WAIT_MINUTES = 30;
// Below this the market has barely moved and repricing is noise, not an improvement.
export const MIN_GAP = 0.005;

// offers: in-progress sell offers, {itemId, name, price, remaining, firstSeen}. prices: {itemId ->
// {buyPrice, sellPrice}} from the same live data the rest of the response uses. costBasis: itemId ->
// price actually paid per unit, where the journal knows it. Returns one entry per offer worth
// mentioning; an offer already at or below the market is left alone, because it should fill on its own.
export function relistAdvice({offers, prices, costBasis = new Map(), targetDurationMinutes = 1440, now = Date.now()}) {
  const waitMinutes = Math.max(MIN_WAIT_MINUTES, targetDurationMinutes * RELIST_AFTER_SHARE);
  const out = [];
  for (const offer of offers || []) {
    if (!offer || !(offer.price > 0) || !Number.isFinite(offer.firstSeen)) continue;
    const openMinutes = (now - offer.firstSeen) / 60000;
    if (openMinutes < waitMinutes) continue;
    const market = prices?.[String(offer.itemId)]?.sellPrice;
    if (!(market > 0)) continue;
    // Priced at or under the market already: nothing to advise, it is simply queueing.
    if (offer.price <= market) continue;
    const gap = (offer.price - market) / offer.price;
    if (gap < MIN_GAP) continue;
    const paid = costBasis.get(offer.itemId);
    const breakEven = paid > 0 ? breakEvenSellPrice(offer.itemId, paid) : null;
    const hours = openMinutes / 60;
    const rounded = hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, ''); // "8 hours", not "8.0 hours"
    const waited = hours >= 1 ? `${rounded} hour${rounded === '1' ? '' : 's'}` : `${Math.round(openMinutes)} minutes`;
    const head = `${offer.name || 'item ' + offer.itemId}: ${offer.remaining > 0 ? offer.remaining.toLocaleString('en-US') + ' still unsold' : 'unsold'} after ${waited}, priced at ${offer.price.toLocaleString('en-US')} gp while the market is around ${market.toLocaleString('en-US')} gp.`;
    let message, suggestedPrice;
    if (breakEven === null) {
      suggestedPrice = market;
      message = `${head} Relisting nearer ${market.toLocaleString('en-US')} gp would be likelier to sell. EVI doesn't know what you paid for this, so it can't tell you whether that is still a profit -- check before you cancel.`;
    } else if (market >= breakEven) {
      suggestedPrice = market;
      message = `${head} Relisting at ${market.toLocaleString('en-US')} gp still clears your break-even of ${breakEven.toLocaleString('en-US')} gp after tax. Your call -- EVI never relists anything itself.`;
    } else {
      // The market is under water. Say so and stop; cutting a loss is the player's decision.
      suggestedPrice = breakEven;
      message = `${head} The market is now BELOW your break-even of ${breakEven.toLocaleString('en-US')} gp after tax, so relisting at the market would lock in a loss. Holding for a recovery or cutting it is your call -- EVI won't choose for you.`;
    }
    out.push({itemId: offer.itemId, name: offer.name, message, offerPrice: offer.price, marketPrice: market,
      breakEven, suggestedPrice, openMinutes: Math.round(openMinutes), belowBreakEven: breakEven !== null && market < breakEven});
  }
  return out;
}
