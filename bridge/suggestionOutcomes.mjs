// Joins what EVI suggested (data/suggestion-log.jsonl) to what actually happened (the offers and
// flips in its own journal). This is the feedback loop: it tells the player whether following EVI
// worked, and tells EVI whether its own estimates are any good -- the same question the backtester
// asks of history, but about real trades this time.
//
// Honest about what it cannot know. EVI never sees why an offer was placed, so "taken" is inferred:
// an offer for the same item, on the same side, placed within a window after the suggestion was
// shown. A player who was going to buy that item anyway is counted as having followed EVI, and a
// suggestion acted on hours later is not. It is a reasonable reading of the evidence, not a fact,
// and anything built on it should say so.

import {isMarginCheck} from './store.mjs';

const TAKEN_WINDOW_MS = 2 * 3600 * 1000;

const isBuy = o => ['BUYING', 'BOUGHT', 'CANCELLED_BUY'].includes(o.state);

// suggestions: parsed suggestion-log lines, oldest first. offers: the journal's own offer records.
// flips: matched flips (automatic and manual) used to attach realised profit to a suggested buy.
export function joinSuggestionOutcomes(suggestions, offers, flips, {takenWindowMs = TAKEN_WINDOW_MS, now = Date.now()} = {}) {
  const flipByBuyId = new Map();
  for (const f of flips || []) if (f && f.buyId) flipByBuyId.set(f.buyId, f);
  const used = new Set();
  const rows = [];
  for (const s of suggestions) {
    if (!s || !Number.isFinite(s.itemId) || !Number.isFinite(s.ts)) continue;
    const wantBuy = s.action === 'buy';
    // The earliest unclaimed offer for this item, on the suggested side, placed inside the window.
    const match = (offers || [])
      // A margin check placed after a suggestion is the player checking the spread, not acting on
      // it, and scoring it as "taken" would flatter EVI with trades nobody meant to make.
      .filter(o => o.itemId === s.itemId && isBuy(o) === wantBuy && !used.has(o.offerId) && !isMarginCheck(o) &&
        o.firstSeen >= s.ts && o.firstSeen <= s.ts + takenWindowMs)
      .sort((a, b) => a.firstSeen - b.firstSeen)[0];
    if (!match) { rows.push({...s, taken: false}); continue; }
    used.add(match.offerId);
    const finished = match.completedAt != null;
    const flip = flipByBuyId.get(match.offerId) || null;
    rows.push({
      ...s, taken: true, offerId: match.offerId,
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
