import {estimateUnitTax} from './tax.mjs';

// "The trade you are still buying into no longer works." -- for a BUY offer that is still filling
// while the reason for it has gone.
//
// Asked for after the player watched Flipping Copilot suggest 24 Brine sabre at 305,170 and tell them
// to cancel two minutes later. EVI said nothing: it re-ranks its next suggestion every two seconds,
// but once an offer is placed it only ever watched SELL offers (see relist.mjs). A buy that is still
// running is the one place where cancelling is free on every unfilled unit, so it is the cheapest
// warning EVI can give.
//
// This is arithmetic on current prices and the GE tax, never a forecast:
//   * margin gone -- selling at what buyers are paying right now, after tax, no longer clears the
//     price you are buying at. The offer is still yours to keep; on the unfilled units cancelling
//     costs nothing, and the units already bought are reported with what they cost.
//   * nobody selling -- the item has no current sell-side price at all, so there is nothing to price
//     an exit against. Said plainly rather than treated as a margin of zero.
// Anything it cannot read -- no price data, no offer price, an offer already finished -- produces
// nothing at all, the same fail-open rule as every other check here. It never cancels or edits an
// offer, and it never says what the price will do next.
//
// Deliberately NOT included: "the market moved above your buy price so this may sit unfilled". The
// plugin already says that (offerDriftHint) from the same live prices, and repeating it here would
// put two sentences about the same offer in the sidebar.

// A margin this thin is not a signal: the GE tax alone is 2%, and prices wobble by less than this
// between polls. Relative to the price being paid, never a flat gp figure, so it means the same on a
// 500 gp item as on a 50m one.
export const MIN_MARGIN_SHARE = 0.005;

// offers: in-progress BUY offers -- {itemId, name, price, total, filled, spent}. prices: {itemId ->
// {buyPrice, sellPrice}}, the same live figures the rest of the response uses, where sellPrice is
// what buyers are currently paying. Returns one entry per offer worth mentioning:
// {itemId, name, message, marginPerUnit, netAtMarket}.
export function buyMarginAdvice({offers, prices, now = Date.now()}) {
  const out = [];
  for (const offer of offers || []) {
    if (!offer || !(offer.price > 0) || !(offer.total > offer.filled)) continue;
    const p = prices?.[String(offer.itemId)];
    const name = offer.name || 'item ' + offer.itemId;
    const remaining = offer.total - offer.filled;
    const gp = n => Math.round(n).toLocaleString('en-US');
    const bought = offer.filled > 0
      ? ` You have ${gp(offer.filled)} already${Number.isFinite(offer.spent) && offer.spent > 0 ? ` at ${gp(offer.spent / offer.filled)} gp each` : ''}; cancelling keeps those and only drops the ${gp(remaining)} still to buy.`
      : ` Nothing has filled yet, so cancelling costs nothing.`;
    if (!p || !(p.sellPrice > 0)) {
      if (p && p.buyPrice > 0) out.push({itemId: offer.itemId, name, marginPerUnit: null, netAtMarket: null,
        level: 'caution', label: 'Nobody selling', figures: `${gp(remaining)} still buying at ${gp(offer.price)}`,
        message: `${name}: nobody is selling to buyers at the moment, so EVI cannot price an exit for the ${gp(remaining)} you are still buying at ${gp(offer.price)} gp.${bought} EVI has no view on whether that changes.`});
      continue;
    }
    const netAtMarket = p.sellPrice - estimateUnitTax(offer.itemId, p.sellPrice);
    const marginPerUnit = netAtMarket - offer.price;
    if (marginPerUnit > offer.price * MIN_MARGIN_SHARE) continue;
    out.push({itemId: offer.itemId, name, marginPerUnit, netAtMarket,
      level: marginPerUnit < 0 ? 'warn' : 'caution',
      label: 'Margin gone',
      figures: `${gp(offer.price)} paid \u00b7 ${gp(netAtMarket)} after tax`,
      message: `${name}: your buy at ${gp(offer.price)} gp no longer has a margin -- buyers are paying ${gp(p.sellPrice)} gp, which is ${gp(netAtMarket)} gp after tax, ${marginPerUnit < 0 ? `${gp(-marginPerUnit)} gp BELOW` : `only ${gp(marginPerUnit)} gp above`} what you are paying.${bought} Whether to keep it is your call -- EVI never cancels anything, and it has no view on where the price goes next.`});
  }
  return out;
}
