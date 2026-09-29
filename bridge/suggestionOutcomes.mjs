// Joins what EVI suggested (data/suggestion-log.jsonl) to what actually happened (the offers and
// flips in its own journal). This is the feedback loop: it tells the player whether following EVI
// worked, and tells EVI whether its own estimates are any good -- the same question the backtester
// asks of history, but about real trades this time.
//
// Two ways a suggestion counts as taken, and they are NOT of equal worth:
//
//   OBSERVED   the player pressed "I took this" and the bridge recorded the id (acceptances.mjs).
//              This is a fact. It is the only basis on which EVI can honestly tell anyone what
//              following it is worth, which is why the button exists.
//   MATCHED    the offer carries EVI's exact fingerprint: same item and side, the suggested price to
//              the gp AND the suggested quantity to the unit. Strong, and still an inference.
//   INFERRED   an offer for the same item, on the same side, placed within a window after the
//              suggestion was shown. A player who was going to buy that item anyway is counted as
//              having followed EVI, and a suggestion acted on hours later is not. A reasonable
//              reading of the evidence, not a fact, and anything built on it must say so.
//
// Every row carries `attribution` so the two are never silently pooled. Inference is kept rather
// than dropped because it is all there is for the 1,659 suggestions logged before the button
// existed, and throwing that away would be its own distortion.

import {isMarginCheck} from './store.mjs';

const TAKEN_WINDOW_MS = 2 * 3600 * 1000;
// An observed acceptance gets a longer leash: the player has SAID they took it, so the only job
// left is finding the offer that goes with it, and someone can tap the button before walking to a
// Grand Exchange clerk. Widening the window for an inferred match would just invent more matches.
const ACCEPTED_WINDOW_MS = 12 * 3600 * 1000;

// The quantity below which an exact match proves nothing, measured rather than chosen. Across the
// 1,663 suggestions logged to 29 Sept 2026, a quantity of **1 alone accounts for 45%** of them, and
// two independent picks in the 1-2 band land on the same number **79.9%** of the time. Above ten
// units that collision chance falls to 13.2% (11-50), 7.6% (51-200) and under 6% beyond, and EVI's
// sizing produces figures like 15,552 and 171,083 that nobody reaches by accident.
//
// The price is deliberately NOT trusted on its own: EVI quotes the last traded price, so anyone
// buying at market hits the same number without ever having seen a suggestion. The quantity is what
// carries the evidence, and the price only corroborates it.
const MATCH_MIN_QUANTITY = 11;

const isBuy = o => ['BUYING', 'BOUGHT', 'CANCELLED_BUY'].includes(o.state);

// Does this offer carry EVI's exact fingerprint? Both the price and the quantity must match, and the
// quantity must be big enough that matching it is not ordinary (see MATCH_MIN_QUANTITY). Returns
// false rather than throwing on anything missing, so an older log entry simply stays `inferred`.
function fingerprinted(s, offer) {
  const wanted = s.action === 'buy' ? s.buyPrice : s.sellPrice;
  if (!Number.isFinite(wanted) || !Number.isFinite(s.quantity)) return false;
  if (s.quantity < MATCH_MIN_QUANTITY) return false;
  return offer.price === wanted && offer.total === s.quantity;
}

// suggestions: parsed suggestion-log lines, oldest first. offers: the journal's own offer records.
// flips: matched flips (automatic and manual) used to attach realised profit to a suggested buy.
export function joinSuggestionOutcomes(suggestions, offers, flips, {takenWindowMs = TAKEN_WINDOW_MS, now = Date.now(), wasAccepted = null} = {}) {
  const flipByBuyId = new Map();
  for (const f of flips || []) if (f && f.buyId) flipByBuyId.set(f.buyId, f);
  const used = new Set();
  const rows = [];
  for (const s of suggestions) {
    if (!s || !Number.isFinite(s.itemId) || !Number.isFinite(s.ts)) continue;
    const wantBuy = s.action === 'buy';
    const observed = !!(wasAccepted && s.id && wasAccepted(s.id));
    const window = observed ? ACCEPTED_WINDOW_MS : takenWindowMs;
    // The earliest unclaimed offer for this item, on the suggested side, placed inside the window.
    const match = (offers || [])
      // A margin check placed after a suggestion is the player checking the spread, not acting on
      // it, and scoring it as "taken" would flatter EVI with trades nobody meant to make.
      .filter(o => o.itemId === s.itemId && isBuy(o) === wantBuy && !used.has(o.offerId) && !isMarginCheck(o) &&
        o.firstSeen >= s.ts && o.firstSeen <= s.ts + window)
      .sort((a, b) => a.firstSeen - b.firstSeen)[0];
    // An acceptance the player stated stands even when no offer can be found for it -- they may have
    // been outbid, or changed their mind after tapping. Recording it as "taken, never placed" is the
    // truth; dropping it would quietly delete the cases where following EVI led nowhere.
    if (!match) { rows.push({...s, taken: observed, attribution: observed ? 'observed' : null, noOfferFound: observed}); continue; }
    used.add(match.offerId);
    const finished = match.completedAt != null;
    const flip = flipByBuyId.get(match.offerId) || null;
    rows.push({
      ...s, taken: true, attribution: observed ? 'observed' : fingerprinted(s, match) ? 'matched' : 'inferred',
      offerId: match.offerId,
      // What the player actually did, which is not always what was suggested.
      actualPrice: match.price, actualQuantity: match.total,
      filled: match.filled, filledFully: match.total > 0 && match.filled >= match.total,
      minutesToComplete: finished ? (match.completedAt - match.firstSeen) / 60000 : null,
      stillOpen: !finished,
      profit: flip ? flip.profit : null,
      soldWithinHours: flip ? (flip.lastSell - flip.firstBuy) / 3600000 : null,
    });
  }
  return rows;
}

export function summarizeOutcomes(rows) {
  const shown = rows.length;
  const taken = rows.filter(r => r.taken);
  const completed = taken.filter(r => !r.stillOpen);
  const filled = taken.filter(r => r.filled > 0);
  const withProfit = taken.filter(r => Number.isFinite(r.profit));
  const profits = withProfit.map(r => r.profit).sort((a, b) => a - b);
  const times = completed.map(r => r.minutesToComplete).filter(Number.isFinite).sort((a, b) => a - b);
  const q = (arr, p) => arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  // Did the player follow the suggested price, or set their own? Says whether EVI's prices are
  // trusted in practice, which is worth knowing before trusting its fill estimates.
  const priced = taken.filter(r => Number.isFinite(r.actualPrice) && Number.isFinite(r.action === 'buy' ? r.buyPrice : r.sellPrice));
  const followedPrice = priced.filter(r => r.actualPrice === (r.action === 'buy' ? r.buyPrice : r.sellPrice)).length;
  return {
    shown, taken: taken.length, takenShare: shown ? taken.length / shown : null,
    // Never pooled: a figure drawn from observed acceptances can be stated as fact, one drawn from
    // inference cannot, and a reader who cannot tell them apart will treat both as the former.
    observed: taken.filter(r => r.attribution === 'observed').length,
    matched: taken.filter(r => r.attribution === 'matched').length,
    inferred: taken.filter(r => r.attribution === 'inferred').length,
    observedClosed: taken.filter(r => r.attribution === 'observed' && Number.isFinite(r.profit)).length,
    observedProfit: taken.filter(r => r.attribution === 'observed' && Number.isFinite(r.profit)).reduce((a, r) => a + r.profit, 0),
    acceptedNeverPlaced: rows.filter(r => r.noOfferFound).length,
    stillOpen: taken.filter(r => r.stillOpen).length,
    filledAtAll: filled.length, filledFully: taken.filter(r => r.filledFully).length,
    medianMinutesToComplete: q(times, 0.5),
    closedFlips: withProfit.length,
    realisedProfit: profits.reduce((a, b) => a + b, 0),
    winners: profits.filter(p => p > 0).length, losers: profits.filter(p => p < 0).length,
    medianProfit: q(profits, 0.5), worstProfit: profits[0] ?? null, bestProfit: profits.at(-1) ?? null,
    followedSuggestedPrice: priced.length ? followedPrice / priced.length : null,
  };
}
