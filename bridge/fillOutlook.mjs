// The price forecast, repurposed as what it is actually good at.
//
// forecastFromSeries was built to predict direction and does that worse than chance: calibration
// over 90 days found "likely rising" followed by a fall 43.6% of the time (see
// forecastCalibration.mjs, and the 2026-09-18 README entry). Inverting it does not make GP either --
// the backtester settled that.
//
// But the same labels turn out to separate something else cleanly: WHICH SIDE OF A FLIP COMPLETES.
// Measured over 65,006 offer pairs across 250 items, six-hour horizon, passive bid at the low and
// passive ask at the high:
//
//   label             buy fills   sell fills      against a baseline of 85.0% / 83.3%
//   Likely rising       91.2%       74.4%         you get the stock, then struggle to exit
//   Likely falling      77.5%       87.8%         you may miss the entry, but you do get out
//   Stable              88.7%       83.7%
//   Possible rebound    76.8%       94.9%
//
// That is a ~14-point spread on the buy side and ~13 on the sell side, and it is not a restatement
// of liquidity: it holds INSIDE every order-size-relative-to-volume band (the dimension EVI already
// sizes against), in both halves of the period, and on disjoint item sets. It also strengthens
// slightly with signal strength. The reading makes sense once the inversion is known -- an item the
// model calls "rising" tends to drift down, so a bid at the low is hit easily and an ask at the high
// is not.
//
// Why this matters more than the direction ever did: being left holding stock is EVI's measured
// failure mode. The backtests traced stuck capital to the sell side, and a signal that flags
// exit risk before the buy is placed is aimed straight at it.
//
// Honest about what it is NOT: these are rates from one archive over one 90-day window, not a
// promise about any single offer, and a fill rate is not profit. It is shown to inform a decision,
// never to block one.

// Re-measure with tools/forecast-fill-signal.mjs rather than editing by hand. Kept as data, with
// the sample it came from, so it can be checked and replaced instead of becoming folklore.
export const FILL_OUTLOOK_MEASURED = {
  measuredOn: '2026-09-18',
  horizonHours: 6,
  // The forecast setting these rates were measured with. The label a forecast carries depends on
  // which horizon produced it (each reads a different series length), so these figures describe the
  // ~6 hours setting only -- quoting them for ~1 hour or Overnight would present unmeasured numbers
  // as measured ones. See fillOutlook.
  forecastHorizon: '6h',
  samples: 65006,
  items: 250,
  baseline: {buy: 0.850, sell: 0.833},
  byLabel: {
    'Likely rising': {buy: 0.912, sell: 0.744, samples: 15137},
    'Likely falling': {buy: 0.775, sell: 0.878, samples: 22977},
    Stable: {buy: 0.887, sell: 0.837, samples: 24948},
    'Possible rebound': {buy: 0.768, sell: 0.949, samples: 1944},
  },
};

// A gap smaller than this is not worth saying anything about -- it is inside the noise of a table
// built from one window, and a sentence about a 2-point difference reads as precision that isn't there.
export const MIN_INTERESTING_GAP = 0.05;
export const MIN_LABEL_SAMPLES = 1000;

// What the forecast says about completing each side of this flip, or null when there is nothing
// trustworthy to say. Never returns a direction, because the direction is wrong.
export function fillOutlook(forecast, table = FILL_OUTLOOK_MEASURED, horizon = table?.forecastHorizon) {
  if (!forecast || !table) return null;
  // Only for the forecast setting the table was measured with. Anything else gets no outlook at all
  // rather than numbers that were never measured for it.
  if (table.forecastHorizon && horizon !== table.forecastHorizon) return null;
  const entry = table.byLabel?.[forecast.label];
  if (!entry || !(entry.samples >= MIN_LABEL_SAMPLES)) return null;
  const buyGap = entry.buy - table.baseline.buy, sellGap = entry.sell - table.baseline.sell;
  // The side worth warning about is whichever departs furthest from the ordinary rate.
  const worst = Math.abs(sellGap) >= Math.abs(buyGap) ? 'sell' : 'buy';
  return {
    buy: entry.buy, sell: entry.sell, buyGap, sellGap, worst,
    baseline: table.baseline,
    samples: entry.samples, horizonHours: table.horizonHours,
    notable: Math.max(Math.abs(buyGap), Math.abs(sellGap)) >= MIN_INTERESTING_GAP,
  };
}

// One plain sentence for a suggestion's reasoning, or null when there is nothing worth saying.
// Deliberately never names the forecast's direction label: repeating "Likely rising" to a player
// about to buy would be handing them a prediction measured to be wrong more often than chance.
export function fillOutlookSentence(outlook) {
  if (!outlook || !outlook.notable) return null;
  const pct = v => Math.round(v * 100);
  const hours = outlook.horizonHours;
  if (outlook.worst === 'sell' && outlook.sellGap < 0)
    return `Exit risk: items whose recent price pattern looks like this sold within ${hours} hours only ${pct(outlook.sell)}% of the time (against ${pct(outlook.buy)}% for the buy side), across ${outlook.samples.toLocaleString('en-US')} past offers in your price archive. The risk here is being left holding it rather than missing the buy -- consider a smaller quantity or a keener sell price.`;
  if (outlook.worst === 'sell' && outlook.sellGap > 0)
    return `Exit outlook: items with this recent price pattern sold within ${hours} hours ${pct(outlook.sell)}% of the time, above the ${pct(outlook.baseline.sell)}% norm, though the buy side filled less often (${pct(outlook.buy)}%). Getting in is the harder half here. Based on ${outlook.samples.toLocaleString('en-US')} past offers, not a guarantee.`;
  if (outlook.buyGap < 0)
    return `Entry risk: items with this recent price pattern had their buy offer fill within ${hours} hours only ${pct(outlook.buy)}% of the time, across ${outlook.samples.toLocaleString('en-US')} past offers in your price archive. You may simply not get the stock at this price.`;
  return `Fill outlook: items with this recent price pattern filled the buy ${pct(outlook.buy)}% and the sell ${pct(outlook.sell)}% of the time within ${hours} hours, across ${outlook.samples.toLocaleString('en-US')} past offers. Rates from your own archive, not a forecast of price.`;
}
