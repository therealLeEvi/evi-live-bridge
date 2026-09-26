// "How far am I from the Twisted bow?" -- a target, the gap to it, and how long that gap takes at a
// rate the player actually achieved.
//
// The point of the feature is motivation, which makes it exactly the place where a flattering number
// would do the most damage: a goal that says "about three days" when it is really three weeks is
// worse than no goal at all. So every figure here is measured or absent:
//
//   * the target's cost is today's price for that item times the quantity, with the moment it was
//     read -- never a forecast of what it will cost when the player gets there, and the caller says
//     out loud that the price moves too;
//   * "what you have" is the wealth snapshot (see wealth.mjs), which is null when the coin count is
//     unknown -- so the gap is unknown too, rather than quietly counting the cash stack as zero;
//   * the rate comes in two flavours, both from real records and both labelled: everything the
//     player's wealth actually did (which includes Slayer drops, alching, anything), and the profit
//     EVI's own tracked flips realised. Neither is annualised, smoothed or projected;
//   * an estimate needs a positive rate and enough history to mean anything. Below that it is null
//     with a plain reason, never a big number with a shrug.

// Least history before a rate is worth quoting. Under a few hours, one lucky flip or one expensive
// purchase swamps everything and the estimate swings wildly between refreshes.
export const MIN_SPAN_HOURS = 6;

// Wealth growth per hour, from the snapshots the bridge records (see createWealthLog). Uses the
// oldest and newest snapshot inside the window: the plain difference over the time between them.
export function wealthRate(history, {hours = 7 * 24, now = Date.now()} = {}) {
  const rows = (history || []).filter(r => Number.isFinite(r.total) && Number.isFinite(r.at) && r.at >= now - hours * 3600000)
    .sort((a, b) => a.at - b.at);
  if (rows.length < 2) return null;
  const first = rows[0], last = rows[rows.length - 1];
  const spanHours = (last.at - first.at) / 3600000;
  if (spanHours < MIN_SPAN_HOURS) return null;
  return {gpPerHour: (last.total - first.total) / spanHours, spanHours, from: first.at, to: last.at, samples: rows.length};
}

// Realised profit per hour from EVI's own matched flips -- what the flipping itself contributed,
// separately from everything else the player did. Measured over the time actually covered by those
// flips, not over the whole window, so a quiet week does not read as a collapse in flipping.
export function flipRate(flips, {hours = 7 * 24, now = Date.now()} = {}) {
  const rows = (flips || []).filter(f => f && Number.isFinite(f.profit) && Number.isFinite(f.lastSell) && f.lastSell >= now - hours * 3600000)
    .sort((a, b) => a.lastSell - b.lastSell);
  if (rows.length < 2) return null;
  const spanHours = (rows[rows.length - 1].lastSell - rows[0].lastSell) / 3600000;
  if (spanHours < MIN_SPAN_HOURS) return null;
  return {gpPerHour: rows.reduce((s, f) => s + f.profit, 0) / spanHours, spanHours, flips: rows.length,
    from: rows[0].lastSell, to: rows[rows.length - 1].lastSell};
}

// An unknown gap has no estimate. Guarded explicitly because `null / number` is 0 in JavaScript, and
// "about 0 hours to go" is the most misleading answer this feature could give.
const hoursFor = (gap, rate) => Number.isFinite(gap) && rate && rate.gpPerHour > 0 ? gap / rate.gpPerHour : null;

// goal: {itemId, quantity} for an item, or {gp} for a plain GP target. priceOf(itemId) returns the
// same {buyPrice, sellPrice} shape the rest of the bridge uses; buyPrice is what it would cost to
// buy one now. Returns null when there is no goal set.
export function goalStatus({goal, wealth, priceOf, itemName, history, flips, now = Date.now(), windowHours = 7 * 24} = {}) {
  if (!goal) return null;
  const quantity = Number.isFinite(goal.quantity) && goal.quantity > 0 ? Math.round(goal.quantity) : 1;
  let targetGp = null, unitPrice = null, name = null;
  if (Number.isFinite(goal.itemId) && goal.itemId > 0) {
    const p = priceOf ? priceOf(goal.itemId) : null;
    unitPrice = p && p.buyPrice > 0 ? p.buyPrice : null;
    targetGp = unitPrice === null ? null : unitPrice * quantity;
    name = (itemName ? itemName(goal.itemId) : null) || ('Item ' + goal.itemId);
  } else if (Number.isFinite(goal.gp) && goal.gp > 0) {
    targetGp = Math.round(goal.gp);
    name = null;
  } else {
    return null;
  }
  const have = wealth && Number.isFinite(wealth.total) ? wealth.total : null;
  const gap = have === null || targetGp === null ? null : Math.max(0, targetGp - have);
  const byWealth = wealthRate(history, {hours: windowHours, now});
  const byFlips = flipRate(flips, {hours: windowHours, now});
  // Why there is no estimate, in the words the scanner shows. Absence is explained, never implied.
  const why = have === null ? 'EVI does not know your coin count yet -- start the plugin and log in.'
    : targetGp === null ? 'No current price for that item, so EVI cannot price the goal.'
    : gap === 0 ? null
    : !byWealth && !byFlips ? `Not enough history yet: EVI needs at least ${MIN_SPAN_HOURS} hours of records to quote a rate.`
    : (byWealth && byWealth.gpPerHour > 0) || (byFlips && byFlips.gpPerHour > 0) ? null
    : 'Your recorded rate is not positive over this window, so there is no honest estimate of when.';
  return {
    itemId: Number.isFinite(goal.itemId) ? goal.itemId : null, name, quantity,
    unitPrice, targetGp, pricedAt: targetGp === null ? null : now,
    have, gap,
    share: have === null || !targetGp ? null : Math.min(1, have / targetGp),
    rates: {
      wealth: byWealth && {...byWealth, hoursToGo: hoursFor(gap, byWealth)},
      flips: byFlips && {...byFlips, hoursToGo: hoursFor(gap, byFlips)},
    },
    why,
  };
}
