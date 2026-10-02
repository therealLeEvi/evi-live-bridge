import {estimateUnitTax} from './tax.mjs';

// What EVI thinks of its own suggestion, as something the sidebar can draw rather than prose to read.
//
// Asked for on 28 September 2026 after a player bought a batch of Contract of Glyphic Attenuation
// expecting roughly the 3m gp the quoted spread implied. It was worth about 350,000: 313 buyers over
// twelve hours had
// paid an average of 373,612, and EVI knew -- it had demoted the pick and said so, in the middle of a
// paragraph. The number was visible and the doubt was not.
//
// So the doubt gets its own shape: a level the panel paints a border with, a label of a few words, and
// a handful of short lines. The prose reasoning is unchanged and still sent; this is a summary of it,
// never a replacement, and it invents nothing -- every line below restates a figure the checks already
// produced.
//
// Lines are written for a 225px panel (RuneLite's PluginPanel.PANEL_WIDTH), so roughly 46 characters
// before Swing wraps them. Keep them short enough to read at a glance or they defeat the point.

export const CLEAR = 'clear';       // every check that ran, passed
export const CAUTION = 'caution';   // it is offered, with something worth knowing against it
export const WARN = 'warn';         // acting on this as it stands loses GP

const gp = n => Math.round(n).toLocaleString('en-US');

/**
 * suggestion: the object about to be sent to the plugin, with whatever the checks attached to it
 * (sellSupport, fillHistory, demoted, lossIfSoldNow). Returns null when there is nothing to say, so an
 * absent verdict means "no opinion" rather than "fine" -- the panel falls back to the prose.
 */
export function suggestionVerdict(suggestion) {
  if (!suggestion || !suggestion.itemId) return null;
  const checks = [];
  let level = CLEAR;
  let label = null;

  const qty = Number.isFinite(suggestion.quantity) && suggestion.quantity > 0 ? suggestion.quantity : 1;
  const sell = suggestion.sellPrice, buy = suggestion.buyPrice;
  const quotedNet = (Number.isFinite(sell) && Number.isFinite(buy))
    ? (sell - buy - estimateUnitTax(suggestion.itemId, sell)) * qty : null;

  // A sell that would realise a loss outranks everything else here. Warn, never block: the player
  // decides whether to cap it, and the figure is what makes that a decision rather than a guess.
  if (Number.isFinite(suggestion.lossIfSoldNow) && suggestion.lossIfSoldNow > 0) {
    return {
      level: WARN,
      label: 'Selling now is a loss',
      checks: [{ok: false, text: `Down ${gp(suggestion.lossIfSoldNow)} gp at today's price`}].concat(
        Number.isFinite(suggestion.breakEvenPrice)
          ? [{ok: null, text: `Break-even after tax: ${gp(suggestion.breakEvenPrice)}`}] : []),
    };
  }

  // A holding that is NOT a loss. Without this, the only holding that ever got a card was one being
  // sold at a loss (the branch above), so your own stock drew a card exactly when the news was bad
  // and fell back to a paragraph when it was good -- which is the wrong way round, and is what a player
  // saw on 30 Sept: a Gilded d'hide vambraces worth +254,063 rendered as prose beside buy picks
  // rendered as cards. Every figure here is one the holding tier already computed.
  if (suggestion.source === 'holding' && Number.isFinite(suggestion.netIfSoldNow) && suggestion.netIfSoldNow >= 0) {
    checks.push({ok: true, text: `+${gp(suggestion.netIfSoldNow)} gp over what you paid`});
    if (Number.isFinite(suggestion.breakEvenPrice))
      checks.push({ok: null, text: `Break-even after tax: ${gp(suggestion.breakEvenPrice)}`});
    label = label || 'Above break-even';
  }

  // Stock EVI never watched being bought: a drop, a quest reward, or from before the bridge existed.
  // CAUTION rather than CLEAR because the thing a card is best at -- putting one number in front of
  // you -- is exactly what cannot be done honestly here. There is no cost basis, so there is no
  // profit to state, only what the stack is worth today. Saying so is the check.
  if (suggestion.source === 'inventory') {
    const worth = (Number.isFinite(suggestion.sellPrice) ? suggestion.sellPrice : 0) * qty;
    if (worth > 0) checks.push({ok: null, text: `Worth ~${gp(worth)} at today's price`});
    checks.push({ok: null, text: 'No buy on record, so no profit is claimed'});
    level = level === CLEAR ? CAUTION : level;
    label = label || 'Not bought through EVI';
  }

  // The supported margin: what the trade is worth at the price buyers have actually been paying, as
  // against the spread being quoted. This is the one that would have caught the Contracts.
  const support = suggestion.sellSupport;
  if (support && Number.isFinite(support.netAtAverage)) {
    const supportedTotal = Math.round(support.netAtAverage * qty);
    if (quotedNet !== null && supportedTotal < quotedNet * 0.7) {
      level = CAUTION;
      label = 'Worth less than it looks';
      checks.push({ok: false, text: `${gp(supportedTotal)} at what buyers really pay`});
      if (Number.isFinite(support.averagePaid) && Number.isFinite(support.units))
        checks.push({ok: null, text: `${gp(support.units)} paid ~${gp(support.averagePaid)} in ${support.hours}h`});
    } else if (supportedTotal >= (quotedNet ?? 0)) {
      checks.push({ok: true, text: 'Buyers paying more than quoted'});
    } else {
      checks.push({ok: true, text: `Holds up at ~${gp(support.averagePaid)}`});
    }
  }

  // The support is mostly HISTORY. Said plainly, because the headline profit has already been capped
  // on the strength of it and a number that drops without explanation is worse than no number.
  // Measured over 584,245 item-hours: past 1.5x the latest print the median price available over the
  // next 12 hours is 80% of the supported figure, past 2x only 60%. See supportIsStale.
  if (support && Number.isFinite(support.staleness) && Number.isFinite(support.latestPaid)) {
    if (support.staleness >= 1.5) {
      level = level === CLEAR ? CAUTION : level;
      label = label || 'Buyers have moved on';
      checks.push({ok: false, text: `Now paying ~${gp(support.latestPaid)}, not ${gp(support.averagePaid)}`});
    } else if (support.staleness >= 1.25) {
      checks.push({ok: null, text: `Buyers now paying ~${gp(support.latestPaid)}`});
    }
  }

  // Can this price be bought again at all -- the fill-history reading (see thinMarket.mjs).
  const fill = suggestion.fillHistory;
  if (fill && Number.isFinite(fill.hoursTraded) && Number.isFinite(fill.hours) && fill.hours > 0) {
    const share = fill.hoursTraded / fill.hours;
    if (share < 0.25) {
      level = level === CLEAR ? CAUTION : level;
      label = label || 'Rarely traded';
      checks.push({ok: false, text: `Traded only ${fill.hoursTraded} of ${fill.hours} hours`});
    } else {
      checks.push({ok: true, text: `Traded ${fill.hoursTraded} of ${fill.hours} hours`});
    }
  }

  // The player's own record on this item, when that is why it was picked.
  if (suggestion.source === 'personal' && Number.isFinite(suggestion.trades) && suggestion.trades > 0) {
    checks.push({ok: true, text: `Your ${suggestion.trades} flip${suggestion.trades === 1 ? '' : 's'} here`});
  }

  // Demoted for a reason none of the above named: say so plainly rather than showing a clean card.
  if (suggestion.demoted && level === CLEAR) {
    level = CAUTION;
    label = 'Shown because nothing passed';
  }

  if (!checks.length && level === CLEAR) return null;   // nothing measured: no opinion to draw
  return {level, label: label || 'Every check passed', checks: checks.slice(0, 4)};
}
