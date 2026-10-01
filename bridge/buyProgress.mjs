// "This buy has been open a while and here is how far it has got."
//
// THE GAP THIS FILLS. Nothing in EVI watches elapsed time against actual progress on a buy. The one
// check that looks like it might -- estimateOfferFill, which produces the sidebar's "May not fill in
// time" -- asks only whether the order is too BIG for the window. It is recomputed from size on every
// poll, so it has no memory: it will still say "about four hours" at hour ten and at hour twenty, and
// it stays quiet on a 3-unit order, which is essentially always predicted fillable. So a small buy
// can sit all day with zero fills and nothing says a word.
//
// WHAT THIS DELIBERATELY DOES NOT DO, and why that changed. CLAUDE.md carried a plan for a "this buy
// is dead" warning, resting on a figure recorded 29 Sept: no observed buy gained a unit after
// six hours, which was called arithmetic rather than a forecast. Re-measured on 1 Oct with
// tools/buy-gain-timing.mjs, that figure turned out to be an ARTIFACT. Packets only arrive while
// RuneLite is open, and novi plays in sessions: only 45 of 923 buy offers were ever observed for more
// than an hour, and the longest any offer was watched at all is 4.51 hours. Nothing was watched past
// six hours, so of course nothing was seen to gain after six hours. The journal cannot answer the
// question, and a six-hour threshold would have been a prediction wearing arithmetic's clothes.
//
// So this states facts and stops. How long it has been open, how much has filled, and what the
// player's own target duration was. It never says the offer is finished, never estimates a fill time,
// and never tells anyone to cancel -- EVI does not know, and saying so would be the exact failure
// this project keeps catching elsewhere.
//
// The bar is the PLAYER'S OWN target trade duration, not a number EVI chose. "You said about two
// hours; it has been six" is their expectation measured against the clock, which needs no forecast
// to be true.

const gp = n => Math.round(n).toLocaleString('en-US');

/** Hours and minutes, short enough for the card's figures row. */
function since(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 90) return mins + 'm';
  const h = mins / 60;
  // A whole number of hours reads as "6h", not "6.0h": the decimal implies a precision this does
  // not have, and the figures row is narrow.
  if (Math.abs(h - Math.round(h)) < 0.05) return Math.round(h) + 'h';
  return (h < 10 ? h.toFixed(1) : String(Math.round(h))) + 'h';
}

/**
 * offers:   live BUY offers -- {itemId, name, price, total, filled, firstSeen}.
 * targetDurationMinutes: the player's own pace setting. Without one there is no bar and nothing is
 *           said -- EVI must not invent an expectation the player never expressed.
 * alreadyFlagged: item ids the sidebar is ALREADY warning about through slotFill ("May not fill in
 *           time"). Skipped, so one offer never produces two cards saying overlapping things.
 */
export function buyProgressAdvice({offers = [], targetDurationMinutes, alreadyFlagged = new Set(),
  now = Date.now(), max = 3} = {}) {
  if (!Number.isFinite(targetDurationMinutes) || targetDurationMinutes <= 0) return [];
  const flagged = alreadyFlagged instanceof Set ? alreadyFlagged : new Set(alreadyFlagged || []);
  const out = [];

  for (const o of offers) {
    if (!o || !Number.isFinite(o.itemId) || !Number.isFinite(o.firstSeen)) continue;
    const total = Number.isFinite(o.total) ? o.total : 0;
    const filled = Number.isFinite(o.filled) ? o.filled : 0;
    if (!(total > 0) || filled >= total) continue;          // complete: nothing to say
    if (flagged.has(o.itemId)) continue;                    // slotFill is already speaking about it
    const openMs = now - o.firstSeen;
    if (!(openMs > targetDurationMinutes * 60000)) continue;

    const name = o.name || ('item ' + o.itemId);
    const pct = Math.round(100 * filled / total);
    out.push({
      itemId: o.itemId,
      name,
      // 'caution' rather than 'warn': nothing has gone wrong, and the player may be content to wait.
      level: 'caution',
      label: filled === 0 ? 'No fills yet' : 'Part filled',
      figures: `${gp(filled)}/${gp(total)} · open ${since(openMs)}`,
      openMinutes: Math.round(openMs / 60000),
      filled, total,
      // The card shows the item, the progress and the elapsed time. The sentence carries the pace it
      // is being measured against, and the disclaimer -- which stays, because this sits next to
      // checks that DO estimate fills and must not be mistaken for one. Shortened 1 Oct 2026.
      message: `Your pace is ${since(targetDurationMinutes * 60000)}. `
        + `EVI is not predicting whether it will fill -- this is the clock and the progress, nothing more.`,
      sortBy: openMs,
    });
  }

  out.sort((a, b) => b.sortBy - a.sortBy);
  return out.slice(0, Math.max(0, max)).map(({sortBy, ...rest}) => rest);
}
