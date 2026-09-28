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

// How far above the market an ask has to sit before this speaks WITHOUT waiting out the clock above.
//
// The wait exists so EVI does not nag about an offer that is simply queueing, and it is right for
// that. But it is a share of the player's own trade pace, and on Slow (~2 days) a quarter of it is
// **twelve hours of silence** however far the market runs away. On 28 Sept 2026 novi was holding an
// Inquisitor's hauberk listed 1.26% above the day's average buy price, with the item five days into a
// slide, and EVI had nothing to say about it until half a day had passed -- while Flipping Copilot
// pops an abort prompt as soon as the price drops. That is the gap this closes.
//
// Measured on novi's own 316 sell offers watched from placement (tools/sell-patience-observed.mjs).
// Up to 1% over the going rate their sells clear in MINUTES -- median 0.1 to 0.4 hours, 83-92% within
// twelve. Past 1% the median becomes six to seven hours and a third to a half never fill at all. So
// the cliff is at 1%, and the only question is how far above it to sit to avoid becoming wallpaper:
//
//   threshold   flags   false alarms (sold anyway within 12h)
//     1.0%       82%          18%
//     1.5%       75%          16%
//     2.0%       65%          12%
//     5.0%       39%           6%    <- the plugin's own threshold, which misses 68 stuck offers
//
// This was set to 2% first, for tidiness. Checked against the case that prompted it -- the Inquisitor's
// hauberk listed 1.59% above the day's average buy price, on an item five days into a slide -- and 2%
// stayed silent on it. Picking a threshold that misses the motivating example to keep the sidebar quiet
// is the wrong trade, so it sits at 1.5%: above the noise floor, catches that case, and costs four
// percentage points of false alarm against 2%. A false alarm here is a sentence that can be ignored;
// a miss is capital stuck for hours on a falling item.
export const DRIFT_SPEAKS_NOW = 0.015;

// Above this the plugin says it already (EviLivePlugin.offerDriftHint, OFFER_DRIFT_THRESHOLD = 0.05),
// so the early path stays quiet rather than putting two sentences about one offer in the sidebar --
// the same reason buyAdvice.mjs leaves the drift case alone. Once the ordinary wait has elapsed the
// message below speaks regardless, exactly as it did before; that overlap is pre-existing.
export const PLUGIN_SPEAKS_ABOVE = 0.05;

// A floor under the early path, so placing an offer is not instantly second-guessed. Anchored on the
// same measurement: an ask within 1% of the market typically fills in 6 to 24 minutes, so an offer
// still standing after fifteen has already outlived a healthy one.
export const DRIFT_MIN_WAIT_MINUTES = 15;

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
    const market = prices?.[String(offer.itemId)]?.sellPrice;
    if (!(market > 0)) continue;
    // Priced at or under the market already: nothing to advise, it is simply queueing.
    if (offer.price <= market) continue;
    const gap = (offer.price - market) / offer.price;
    if (gap < MIN_GAP) continue;
    // Either the offer has waited out the clock, or the market has moved far enough that waiting is
    // the wrong advice (see DRIFT_SPEAKS_NOW). The second path is deliberately capped below the
    // plugin's own threshold so only one sentence appears.
    const pastTheClock = openMinutes >= waitMinutes;
    const drifted = openMinutes >= DRIFT_MIN_WAIT_MINUTES
      && gap >= DRIFT_SPEAKS_NOW && gap < PLUGIN_SPEAKS_ABOVE;
    if (!pastTheClock && !drifted) continue;
    const paid = costBasis.get(offer.itemId);
    const breakEven = paid > 0 ? breakEvenSellPrice(offer.itemId, paid) : null;
    const hours = openMinutes / 60;
    const rounded = hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, ''); // "8 hours", not "8.0 hours"
    const waited = hours >= 1 ? `${rounded} hour${rounded === '1' ? '' : 's'}` : `${Math.round(openMinutes)} minutes`;
    // Two openings for two reasons. The ordinary one leads with how long it has sat, because that is
    // what prompted it. The early one leads with the market having moved, because the offer may be only
    // minutes old and "unsold after 20 minutes" would read as EVI being impatient rather than as news.
    const what = `${offer.remaining > 0 ? offer.remaining.toLocaleString('en-US') + ' still unsold' : 'unsold'}`;
    const head = pastTheClock
      ? `${offer.name || 'item ' + offer.itemId}: ${what} after ${waited}, priced at ${offer.price.toLocaleString('en-US')} gp while the market is around ${market.toLocaleString('en-US')} gp.`
      : `${offer.name || 'item ' + offer.itemId}: the market has moved away from your ask -- ${what} at ${offer.price.toLocaleString('en-US')} gp while buyers are around ${market.toLocaleString('en-US')} gp, ${(gap * 100).toFixed(1)}% below it. Asks more than 1% over the going rate took six to seven hours to sell in your own history, and a third to a half never sold at all.`;
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
