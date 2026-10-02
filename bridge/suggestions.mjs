import {estimateUnitTax} from './tax.mjs';
import {fillOutlook, fillOutlookSentence} from './fillOutlook.mjs';

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Aggregates the user's own reviewed flips, grouped by item. This is the whole point:
// every input here came from this account's own confirmed trades, never a shared pool,
// so there is no crowd of other users chasing the same suggestion at once.
export function personalHistory(flips) {
  const byItem = new Map();
  for (const f of flips || []) {
    if (!f || f.removed || !Number.isFinite(f.itemId) || !Number.isFinite(f.profit) || !Number.isFinite(f.quantity)) continue;
    let h = byItem.get(f.itemId);
    if (!h) {
      h = {itemId: f.itemId, name: f.item, trades: 0, wins: 0, totalProfit: 0, quantities: [], holds: [], lastTradeAt: 0};
      byItem.set(f.itemId, h);
    }
    h.trades++;
    if (f.profit > 0) h.wins++;
    h.totalProfit += f.profit;
    h.quantities.push(f.quantity);
    if (Number.isFinite(f.hold)) h.holds.push(f.hold);
    const at = f.lastSell ?? f.confirmedAt ?? 0;
    if (at > h.lastTradeAt) h.lastTradeAt = at;
    if (f.item) h.name = f.item; // most recent name wins (handles renamed/variant display)
  }
  return [...byItem.values()].map(h => ({
    itemId: h.itemId,
    name: h.name,
    trades: h.trades,
    winRate: h.wins / h.trades,
    avgProfit: h.totalProfit / h.trades,
    medianQty: median(h.quantities),
    medianHoldH: median(h.holds),
    lastTradeAt: h.lastTradeAt,
  }));
}

function recencyWeight(lastTradeAt, now) {
  const days = (now - lastTradeAt) / 86400000;
  if (days <= 1) return 1;
  if (days <= 7) return 0.85;
  if (days <= 30) return 0.6;
  return 0.35;
}

// Risk tiers approximate risk using the only signal this free/personal tier actually has --
// this account's own win rate and trade count -- not real price/profit variance, which would
// need a separate volatility feed this tier doesn't fetch. "Low" demands a longer, more
// consistent winning history and keeps winRate weighted twice in scoring (extra caution);
// "medium" is the original, unchanged balance (the default, so leaving risk unset changes
// nothing); "high" accepts a thinner/less certain track record and drops winRate from scoring
// entirely, so raw average profit drives ranking even for a less-proven item.
const RISK_TIERS = {
  low: {minTrades: 3, minWinRate: 0.75, score: (h, rw) => h.avgProfit * h.winRate * h.winRate * rw},
  medium: {minTrades: 1, minWinRate: 0.5, score: (h, rw) => h.avgProfit * h.winRate * rw},
  high: {minTrades: 1, minWinRate: 0.4, score: (h, rw) => h.avgProfit * rw},
};

// The Wiki /1h endpoint's own window length, in minutes -- the only per-item recent-volume signal
// this project fetches. Used to turn a raw hourly volume figure into an estimated trading *rate*
// (units per minute) for the trade-duration feasibility check below.
const VOLUME_WINDOW_MINUTES = 60;
// A deliberately coarse feasibility estimate, not a real order-book simulation: assumes the
// window's volume is spread evenly across it, so quantity / (volume / windowMinutes) approximates
// how many minutes it would take to trade that quantity at the current pace. Real fills can be far
// lumpier than "evenly spread" -- treat this as a rough sanity check ("is this even in the right
// ballpark for my time budget"), not a guarantee. Returns Infinity when there's no usable volume
// signal at all, so a candidate is never penalized for missing data, only for a bad estimate.
// How much traded in an item over the last hour, for SIZING, or null when it should constrain nothing.
// An item LISTED in the Wiki's /1h snapshot with 0 on one side is a measured zero -- that side
// genuinely did not trade -- and must constrain. Treating it as unknown is what let the chestplate,
// listed with 0 bought and 1 sold, be suggested at full size.
//
// An item ABSENT from the snapshot also traded nothing, strictly speaking, but it deliberately stays
// "no reading" here: this caps how much gets suggested, and counting every rare item that merely had
// a quiet hour as zero would shrink far more suggestions than the bug that prompted this. The looser
// reading belongs in a warning, which restricts nothing -- see sellSideSupport.
export function volumeReadingFor(volumes, itemId) {
  const v = volumes?.[String(itemId)];
  if (!v) return null;
  return Math.min(v.highPriceVolume || 0, v.lowPriceVolume || 0);
}

/**
 * The hourly volume an ORDER SIZE should be built on: a typical hour, not the latest one.
 *
 * WHY THIS EXISTS. `volumeShareForDuration` multiplies ONE hour's volume, and that hour was whatever
 * the Wiki's /1h endpoint last reported. On 2 Oct 2026 it sized a buy of Harmony island teleports
 * (item 19625) off an hour in which about 969 units traded, on an item whose typical hour over the
 * following day was 92 and whose hours ranged from 1 to 809. The order it allowed was close to half
 * the item's entire daily volume, which no order can clear.
 *
 * MEASURED before building (tools/volume-basis.mjs, 388,669 item-hours over 14 days). Sizing off the
 * latest hour against sizing off a trailing median, counting orders that needed more than a quarter
 * of EVERY unit the market traded in the window:
 *
 *   latest hour      8.4% needed >25% of all volume   median order 475
 *   median of 24h    2.3%                             median order 411
 *   median of 168h   1.1%                             median order 403
 *   median of 336h   1.1%                             median order 409
 *
 * So a week's median cuts oversized orders about SEVENFOLD for roughly 20% off the typical order,
 * and it plateaus between one and two weeks -- the same shape the price window showed on 29 Sept.
 * It holds at the Slow pace too (2.2% -> 0.2%). The counts are a FLOOR on how often the basis
 * oversizes, not a fill rate: forward volume is a ceiling, since nobody captures every unit traded.
 *
 * IT DOES NOT ONLY SHRINK ORDERS, and that needed checking separately before shipping. Against the
 * live catalogue it GROWS the order on 692 of 1,169 offerable items, because an item having a quiet
 * hour was being under-sized just as a spiking one was being over-sized. Split by direction, grown
 * orders are 1.5% against shrunk orders' 0.8% on the >25% measure (0.3% against 0.1% impossible),
 * both far under the latest hour's 8.3% -- so growth is not buying the improvement with new risk.
 * Verified against live prices at 1m, 5m, 50m, 205m and 380m: nothing goes quiet, and deployed
 * capital is flat or slightly higher at every stack. The basis is more ACCURATE, not more timid.
 *
 * EVI already learned this for PRICES -- ROBUST_PRICE_HOURS is 336 because one recent print is not
 * the market -- and had never applied it to volume.
 *
 * WHAT IT DOES TO THE CASE ITEM. Harmony island teleport (tablet), item 19625, over 165 archived
 * hours: its typical hour is 10 units on the thinner side, its latest hour was 17, and the spike hour
 * the cap had been reading was 969 (per-hour minimum p10 0, p50 6, p90 98, max 809). So an order the
 * old basis allowed in the hundreds is sized at 10. That is a large cut and it is the right one: an
 * item trading ten units an hour cannot absorb a large position, and pretending otherwise is what
 * leaves stock unsold. Capital belongs in items whose typical hour can take it.
 *
 * A ZERO TYPICAL READING FALLS BACK rather than constraining to one unit, which is the one place this
 * departs from the measured-zero rule volumeReadingFor and orderSizeCap follow. The rules are about
 * different measurements. "Nobody bought this in the last hour" is a statement about NOW and a real
 * warning sign. "The median hour of the last week has a zero on one side" is a statement about
 * typicality, on an item that is trading both ways right now.
 * Measured against the price archive: of 1,238 items offerable on the latest hour, 1.9% have a zero
 * typical reading, and constraining those to a single unit would be a behaviour change with no
 * measurement behind it.
 *
 * BUT A ZERO LATEST HOUR STILL WINS, and the first version of this got it wrong -- found in review,
 * 2 Oct 2026. Returning the typical hour whenever one existed meant a measured zero in the LATEST
 * hour was ignored, which silently undid the Eclipse Moon chestplate fix in the two tiers that have
 * no liquidity floor of their own: an item nobody had bought at the high side for hours would be
 * sized off its weekly median instead of held to a single unit. The MARKET tier was unaffected,
 * because liquidityFloorMet drops a zero-volume item before sizing is reached -- but the HISTORY and
 * PUSHED tiers have no such floor, and both carried comments promising exactly the behaviour this
 * had removed. The code contradicted its own documentation in two places.
 *
 * So the order is: a MEASURED zero now beats any median, because a median cannot tell you that you
 * could not have exited this hour. The typical hour only replaces a latest hour that is trading.
 *
 *   latest hour is a measured 0          -> 0        (one unit; the measured-zero rule, restored)
 *   latest hour absent, typical present  -> typical  (stricter than the old "constrain nothing")
 *   latest hour trading, typical present -> typical  (the whole point of this helper)
 *   latest hour trading, no typical      -> latest   (exactly the old behaviour)
 *   both absent                          -> null     (no signal; constrains nothing, as before)
 */
export function sizingLiquidityFor(options, itemId) {
  const latest = volumeReadingFor(options?.volumes, itemId);
  if (latest === 0) return 0;              // nothing traded this hour: no median overrides that
  const typical = options?.typicalVolumes?.[String(itemId)];
  if (Number.isFinite(typical) && typical > 0) return typical;
  return latest;
}

// Does a buy suggestion's margin survive at the price buyers have ACTUALLY been paying?
//
// The sell price EVI quotes is /latest's "high": a single print, the most recent instant-buy. On a
// thin item one trade can sit far above the market. That is exactly what cost GP on an Eclipse Moon
// chestplate (broken): EVI said buy at 595,350 and sell at 618,004, but over the previous 12 hours 48
// buyers had paid an average of 587,104 -- LESS than the suggested buy price. The margin existed only
// at one outlier trade, and the player lost the tax.
//
// Measured before choosing, against the player's real top 25 suggestions, because a warning that
// fires on everything gets ignored:
//   * "nobody bought in the last hour"         caught it, but fired on 32% -- quiet rares, not risk
//   * demand collapse against the item's norm  caught it, fired on 20%
//   * margin at the 12-hour buyer average      caught it (on 48 buyers), fired on 4%
// The last is also the one that names the actual mechanism, so it is the one shipped.
//
// series: the Wiki's /timeseries?timestep=1h points for the item ({timestamp, avgHighPrice,
// highPriceVolume}). Uses the `hours` full hours before `nowMs`. Returns null -- never a guess -- when
// there is no series to judge by.
export const SELL_SUPPORT_HOURS = 12;
export function sellPriceSupport(series, itemId, buyPrice, {hours = SELL_SUPPORT_HOURS, nowMs = Date.now()} = {}) {
  if (!Array.isArray(series) || !series.length || !(buyPrice > 0)) return null;
  const end = Math.floor(nowMs / 3600000) * 3600, start = end - hours * 3600;
  let units = 0, gp = 0, latestTs = -Infinity, latestPaid = null;
  for (const p of series) {
    if (!(p.timestamp >= start && p.timestamp < end)) continue;
    const price = Number(p.avgHighPrice), vol = Number(p.highPriceVolume);
    if (price > 0 && vol > 0) {
      units += vol; gp += price * vol;
      // The most recent hour anyone actually bought in. The average above has no sense of WHEN
      // within the window, so this is what tells it apart from the present.
      if (p.timestamp > latestTs) { latestTs = p.timestamp; latestPaid = price; }
    }
  }
  if (!units) return {units: 0, hours, averagePaid: null, netAtAverage: null, supported: false, latestPaid: null, staleness: null};
  const averagePaid = gp / units;
  const netAtAverage = averagePaid - estimateUnitTax(itemId, averagePaid) - buyPrice;
  // How much of this support is already history. 1 means the window agrees with the present.
  const staleness = latestPaid > 0 ? averagePaid / latestPaid : null;
  return {units, hours, averagePaid, netAtAverage, supported: netAtAverage > 0, latestPaid, staleness};
}

// Above this, the 12-hour support average is mostly HISTORY rather than a description of the market
// you are about to sell into, and the price it names is not reliably reachable.
//
// MEASURED, not chosen (tools/support-staleness.mjs, 1 Oct 2026, 584,245 item-hours over 14 days).
// Banding by this exact ratio and asking what the MEDIAN price over the next 12 hours actually was,
// as a share of the supported price:
//
//   under 1.1x   522,771 cases   100.2% realised   13.2% never reached again
//   1.1 - 1.25x   31,236          94.7%            28.0%
//   1.25 - 1.5x   14,953          90.6%            27.1%
//   1.5 - 2x       8,519          80.4%            31.2%
//   over 2x        6,766          59.8%            35.6%
//
// Monotone on both measures, and STABLE at 24h and 48h horizons -- at two days the worst band still
// realises only 65%, so the shortfall is structural and waiting does not rescue it. 1.5 is where the
// median shortfall reaches 20%.
//
// The obvious alternative -- how far the item is above its own two-week norm -- was measured too and
// is WEAKER (79.5% at the extreme against 59.8%). The useful question is "has this support already
// passed", not "is this item expensive right now".
//
// What prompted it: a player was offered Ape atoll teleports with a quoted sell of 20,000.
// The support said 7,392 buyers at an average of 22,231 -- but 86% of them were inside a two-hour
// spike that had ended six hours earlier, nothing had gone at or above 20,000 since, and buyers were
// paying 13,486. About 2.6% of archived readings sit above the threshold, so this is narrow.
export const STALE_SUPPORT_RATIO = 1.5;
// Below this it is worth STATING but not acting on: a 5-9% median shortfall.
export const SOFT_STALE_SUPPORT_RATIO = 1.25;

/**
 * Is this support reading mostly history? Null-safe: an absent or unmeasurable reading is NOT stale,
 * because "we could not tell" must never read as "we found a problem" -- the same fail-open rule
 * every other check here follows.
 */
export function supportIsStale(detail, ratio = STALE_SUPPORT_RATIO) {
  return !!detail && Number.isFinite(detail.staleness) && detail.staleness >= ratio;
}

/**
 * The supported price, capped at what buyers are paying NOW when the support is stale.
 *
 * This is the whole intervention: the pick is not blocked, because buying at the current price may
 * still be a perfectly good trade -- what was wrong on the Ape atoll teleport was EVI PROMISING
 * 20,000 when nothing had gone at that price in six hours. Capping makes the number honest and
 * leaves the decision where it belongs.
 */
export function supportedPriceForHeadline(detail) {
  if (!detail || !Number.isFinite(detail.averagePaid)) return null;
  if (!supportIsStale(detail)) return detail.averagePaid;
  return Number.isFinite(detail.latestPaid) ? Math.min(detail.averagePaid, detail.latestPaid) : detail.averagePaid;
}

// Fills a Wiki /timeseries 1h series in from the local price archive. Measured 19 Sep 2026 across 8
// items and 15 days: all 2,865 item-hours present in both were identical, but /timeseries was still
// missing the newest complete hour at ten past the next one, while the archive had stored it five
// minutes after it closed. So the live sell-support check often saw 11 hours out of its 12. The
// archive's hour is used wherever it has one; an hour it lacks keeps the series' own point; an
// archived hour in which the item did not trade adds nothing, exactly as a zero-volume hour would.
export function mergeArchiveHours(series, buckets, itemId) {
  const byTs = new Map((Array.isArray(series) ? series : []).map(p => [p.timestamp, p]));
  for (const b of buckets || []) {
    const x = b && b.d && b.d[String(itemId)];
    if (!x) continue;
    byTs.set(b.ts, {timestamp: b.ts, avgHighPrice: x[0], highPriceVolume: x[1], avgLowPrice: x[2], lowPriceVolume: x[3]});
  }
  return [...byTs.values()].sort((a, b) => a.timestamp - b.timestamp);
}

// One warning sentence, or null when the margin holds at what buyers really pay. A warning, never a
// block: the player may know something the average doesn't, and the price is still offered.
export function sellSupportNote(support, sellPrice) {
  if (!support || support.supported) return null;
  const quoted = Number.isFinite(sellPrice) ? `${Math.round(sellPrice).toLocaleString('en-US')} gp` : 'the sell price';
  if (!support.units)
    return `Warning: nobody bought this item at all in the last ${support.hours} hours, so the sell price of ${quoted} rests on almost no trading. Your sale may not fill.`;
  const perItem = Math.round(Math.abs(support.netAtAverage)).toLocaleString('en-US');
  return `Warning: the sell price of ${quoted} rests on very few trades. Over the last ${support.hours} hours, ${support.units.toLocaleString('en-US')} buyers paid an average of ${Math.round(support.averagePaid).toLocaleString('en-US')} gp -- at that price this flip loses about ${perItem} gp per item after tax.`;
}

function estimatedFillMinutes(quantity, liquidity, windowMinutes) {
  if (!(liquidity > 0)) return Infinity;
  return quantity / (liquidity / windowMinutes);
}

// ---- Corrections measured against real offers, not chosen by feel.
// `tools/calibrate-fills.mjs` compared 104 of this account's own offers -- each one watched from
// placement to completion -- against what the raw estimate above would have predicted for the hour
// it was placed in (archived Wiki volumes). Two findings, both reproducible by re-running that tool:
//
//  1. The raw estimate says "instant" for a small order in a liquid item, and nothing is instant
//     unless you cross the spread. Offers taking under 1% of an hour's volume were predicted at
//     0.45 min and actually took a median of 5.3 min, so there is a floor.
//  2. EVI always suggests buying at the low and selling at the high -- passive on both sides, by
//     construction. Passive offers (60 of the 104) took a median of 1.5x longer than predicted.
//     Aggressive offers that crossed the spread filled essentially instantly, which is why the
//     factor is specific to the kind of offer EVI actually suggests.
//
// These make the estimate less wrong; they do not make it precise. The same measurement found the
// 90th percentile still 16.7x off, which is why DURATION_TOLERANCE exists below and why every piece
// of wording built on this stays a hedged observation rather than a promise.
export const FILL_FLOOR_MINUTES = 5;
export const PASSIVE_FILL_FACTOR = 1.5;
// How far past the player's target a corrected estimate may run before a candidate is dropped
// outright. At 1 (the old behaviour) the imprecision above would throw away perfectly good trades on
// a number that is routinely off by more than that; at 2 the filter still removes the genuinely
// slow-moving items it exists for. Sizing is NOT given this tolerance -- quantities are cut to the
// real target, since being sized too big is what leaves stock unsold.
export const DURATION_TOLERANCE = 2;

// Applies both corrections to a raw estimate. Infinity (no usable volume) stays Infinity.
export function correctedFillMinutes(rawMinutes) {
  if (!Number.isFinite(rawMinutes)) return rawMinutes;
  return Math.max(FILL_FLOOR_MINUTES, rawMinutes) * PASSIVE_FILL_FACTOR;
}

// Applies the exact same coarse, volume-based feasibility estimate above -- not a new or different
// heuristic -- to an offer the player has ALREADY placed, rather than one being sized before it's
// placed (see computeSuggestion/computeMarketSuggestion's own use of estimatedFillMinutes). Purely
// so GET /api/suggestion can tell the plugin "this is running noticeably longer than your target
// duration, going by recent volume" -- never a fill guarantee, and the caller (EviLivePlugin's
// offerFillHint) must keep its own wording to that same honesty: a volume observation, not a
// prediction. liquidity uses the same conservative min(high,low) volume as every other duration
// check in this file, for the same reason (a round trip needs both a buy and a sell to clear).
// Returns null -- never a fabricated estimate -- when there's no volume entry for this item at all,
// or when there's no real remaining quantity or target duration to judge against; absence of data
// is never treated as evidence either way, same rule every other duration/volume check here follows.
export function estimateOfferFill(remainingQty, volumeEntry, targetDurationMinutes) {
  if (!(remainingQty > 0) || !Number.isFinite(targetDurationMinutes) || targetDurationMinutes <= 0) return null;
  if (!volumeEntry) return null;
  const liquidity = Math.min(volumeEntry.highPriceVolume || 0, volumeEntry.lowPriceVolume || 0);
  // Corrected the same way as every other use (see correctedFillMinutes): this hint is about an
  // offer already sitting in the GE, which is a passive offer by definition.
  const minutes = correctedFillMinutes(estimatedFillMinutes(remainingQty, liquidity, VOLUME_WINDOW_MINUTES));
  return {
    // -1 is a deliberate sentinel for "no meaningful recent trading at all" (minutes === Infinity)
    // -- never JSON's null (which the plugin's Gson mapping would refuse for a primitive int field)
    // and never a fabricated large number standing in for "who knows".
    estimatedFillMinutes: Number.isFinite(minutes) ? Math.round(minutes) : -1,
    likelyToFillInTime: minutes <= targetDurationMinutes,
  };
}

// ---- Three gates every "buy" tier shares, all built by the caller (GET /api/suggestion) and all
// fail-open: an unknown answer never blocks a candidate, exactly like every other check here.
//
// 1. Stale prices. The Wiki's /latest high and low are LAST-TRADED prices with their own timestamps,
// not a live order book. On a thinly traded item the pair can be hours old and describe a spread
// nobody is actually offering -- the "buy at 6,400, sell at 30,000" shape that looks like free GP
// and is really just two unrelated old trades. That matters more now that a market-wide pick is
// sized to the item's whole buy limit rather than 100 units. Returns the age in minutes of the
// STALER of the two sides, or null when the response carries no usable timestamps (fail open).
export function priceAgeMinutes(p, now = Date.now()) {
  const times = [p?.highTime, p?.lowTime].filter(t => Number.isFinite(t) && t > 0);
  if (times.length < 2) return null;
  return (now / 1000 - Math.min(...times)) / 60;
}
// How stale is too stale for a market-wide pick -- an item nobody has traded on either side within
// this window has no trustworthy spread to rank on. Personal-history picks are never dropped for
// this (see computeSuggestion): there the player's own track record is the evidence, so it only adds
// a note.
export const MAX_PRICE_AGE_MINUTES = 60;

// 2. Members items on a free-to-play world, which simply cannot be traded there.
// 3. The GE's own 4-hour buy limit, via the caller's limitFor(itemId) -> {limit, remaining} | null.
// Both are passed in as options (membersBlocked / limitFor) rather than looked up here, since only
// the caller has the item mapping and the trade journal. See GET /api/suggestion in server.mjs.
// How much of an item the GE will let the player buy within their own trade duration. The buy limit
// resets fully four hours after the first purchase of a window (the Wiki's own wording), so a trade
// the player is willing to leave for 12 hours can span three windows, not one -- and capping every
// order at a single limit left two thirds of a long trade's allowance unused, which matters most on
// exactly the bulk items where the limit, not the market, is what binds.
//
// Counted, not assumed: what is left in the current window (limit minus what EVI has seen bought),
// plus one full limit for every further window that STARTS before the duration runs out. A window
// that would only open after the player's own deadline adds nothing. No duration set means one
// window, exactly as before. EVI only counts purchases it saw, so this is an upper bound on what the
// GE allows and is only ever used to cap a quantity downwards, never to justify buying more.
export const LIMIT_WINDOW_MS = 4 * 3600 * 1000;
export function limitAllowance({limit, used = 0, windowEndsAt = null, targetDurationMinutes, now = Date.now()}) {
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const inWindow = Math.max(0, limit - (used || 0));
  const duration = Number.isFinite(targetDurationMinutes) && targetDurationMinutes > 0 ? targetDurationMinutes * 60000 : 0;
  if (!duration) return inWindow;
  // With no purchase in the current window, buying now starts one: windows open at 0, 4h, 8h, ...
  // With one running, the next opens when it ends.
  const firstReset = Number.isFinite(windowEndsAt) && windowEndsAt > now ? windowEndsAt - now : (used > 0 ? 0 : LIMIT_WINDOW_MS);
  const further = firstReset < duration ? Math.ceil((duration - firstReset) / LIMIT_WINDOW_MS) : 0;
  return inWindow + further * limit;
}

// An opt-in trading focus: "bulk" keeps buy suggestions to items the GE lets you buy by the thousand
// -- consumables and ammunition, which carry buy limits of 2,000 to 18,000, where gear sits between 4
// and 125. Drawn from the item's own buy limit, which is game data, rather than from a price or
// profit threshold; off unless the player chooses it, since plenty of good flips are gear. An item
// whose limit is unknown cannot be shown to be bulk and is left out under this focus.
export const BULK_MIN_LIMIT = 1000;
// The player's trading focus, by the item's own buy limit: "bulk" (bought by the thousand), "gear"
// (everything with a known, smaller limit -- equipment, where limits run 4-125), or "any". Asked for so
// the player can switch between gear flips like Spiked manacles and bulk consumables. An item whose
// limit is unknown cannot be placed in either group, so only "any" includes it.
export const FOCUSES = ['any', 'bulk', 'gear'];
// Which focus applies to one request: the plugin's own setting when it names one, otherwise the
// scanner's stored switch. An unknown value never becomes a focus of its own.
export function resolveFocus(requested, stored) {
  if (FOCUSES.includes(requested)) return requested;
  return FOCUSES.includes(stored) ? stored : 'any';
}
export function focusAllows(focus, limit) {
  if (focus === 'bulk') return Number.isFinite(limit) && limit >= BULK_MIN_LIMIT;
  if (focus === 'gear') return Number.isFinite(limit) && limit > 0 && limit < BULK_MIN_LIMIT;
  return true;
}

/**
 * Items whose Grand Exchange spread is real but cannot actually be collected, because of a game
 * mechanic that sits outside the price data. Never bought by any tier.
 *
 * 13190, Old school bond. A bond bought on the Grand Exchange arrives UNTRADEABLE, and the fee to
 * make it tradeable again all but always exceeds the spread -- novi, 28 Sept 2026. So the margin is
 * not one a player can realise, however wide it looks and however much archived history supports it.
 *
 * This is not a fringe case for the market tier, it is one of its favourite picks. A bond is
 * expensive, has a wide quoted spread, and is one of very few items that can absorb tens of millions
 * at once, so it is exactly what the ranking reaches for on a large stack: at 89m on 28 Sept it was
 * the single best pick in the catalogue, committing 81.8m, and in a fourteen-day replay of the
 * last-print ranking it was chosen 121 times out of 334. It is also TAX-FREE (see the exempt list in
 * tax.mjs), so marginClearsTax -- the check that catches thin edges -- exempts it by construction and
 * every margin safety net waves it through.
 *
 * The one case novi named where a bond is worth buying is a Jagex announcement of a membership price
 * rise, which lifts the bond with it. That is a news event rather than a spread, so it belongs with
 * the news-to-item causal chains, not in the ordinary margin ranking.
 *
 * Buying only. gateCandidate is on the three BUY tiers and not on computeHoldingSuggestion, so a
 * player who already holds one is still helped to sell it -- the standing warn-don't-block rule.
 */
export const UNFLIPPABLE_ITEM_IDS = new Set([13190]);

function gateCandidate(itemId, quantity, options) {
  if (UNFLIPPABLE_ITEM_IDS.has(itemId)) return null;
  if (options.membersBlocked?.(itemId)) return null;
  if (options.focusBlocked?.(itemId)) return null;
  const limit = options.limitFor?.(itemId);
  if (!limit || !Number.isFinite(limit.remaining)) return {quantity, limited: false};
  if (limit.remaining < 1) return null; // the 4-hour limit for this item is already used up
  return limit.remaining < quantity ? {quantity: limit.remaining, limited: true, limit} : {quantity, limited: false};
}

// latestPrices: {[itemId]: {high, low, ...}} in the shape of the Wiki /latest response's "data" object.
// options: {minProfit?: number, blocklist?: Set<number>, risk?: 'low'|'medium'|'high', maxSpend?:
// number, targetDurationMinutes?: number, volumes?: object}, all optional. maxSpend is the
// player's actual current cash stack (read from their inventory's coins) -- when set, a candidate
// whose buy price alone is more than that is dropped entirely (can't afford even one unit at the
// current cash stack), and the suggested quantity is otherwise capped so the total cost never
// exceeds it, however large the typical/historical quantity was. targetDurationMinutes is the
// player's own preferred trade length (e.g. "give me a ~10-minute flip"), paired with volumes (the
// Wiki /1h response's "data" object, keyed by item ID) as the only signal available to judge it by
// -- a candidate that couldn't realistically trade even one unit within that window (per
// estimatedFillMinutes above) is dropped, and one that could but only at a smaller quantity has it
// capped down, same treatment as maxSpend. Without volumes (or without a matching item in it),
// duration is simply not checked for that candidate -- never a reason to drop it for lack of data.
// Returns a single best suggestion (or null), ranked purely from this account's own reviewed-flip
// history. When this returns null, the caller (GET /api/suggestion) can optionally fall back to
// computeMarketSuggestion below, which is not gated on any personal history at all.
export function computeSuggestion(flips, latestPrices, now = Date.now(), options = {}) {
  const minProfit = Number.isFinite(options.minProfit) && options.minProfit > 0 ? options.minProfit : 0;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  // >= 0, not > 0: an EMPTY coin pouch is a real answer, not a missing one. The plugin sends no
  // cash parameter at all when it has not read the inventory yet (cashStack -1), so absent already
  // means unknown -- and treating a genuine 0 as unknown removed the cap entirely. Found by novi on
  // 29 Sept 2026 after banking their coins: EVI offered four 3rd age robe tops at 131,812,123 each,
  // over half a billion gp, to a player carrying nothing. At cash=1000 it correctly sized down to a
  // 200 gp trade, which is what made the falsy-zero obvious.
  const maxSpend = Number.isFinite(options.maxSpend) && options.maxSpend >= 0 ? options.maxSpend : undefined;
  const targetDurationMinutes = Number.isFinite(options.targetDurationMinutes) && options.targetDurationMinutes > 0 ? options.targetDurationMinutes : undefined;
  const tier = RISK_TIERS[options.risk] || RISK_TIERS.medium;
  const history = personalHistory(flips).filter(h =>
    h.trades >= tier.minTrades && h.winRate >= tier.minWinRate && h.medianQty >= 1 && !blocklist.has(h.itemId));
  const candidates = [];
  for (const h of history) {
    const p = latestPrices?.[String(h.itemId)];
    if (!p || !(p.low > 0) || !(p.high > 0)) continue;
    const tax = estimateUnitTax(h.itemId, p.high);
    const net = p.high - p.low - tax;
    if (net <= 0) continue;
    // An edge that does not cover this item's own tax, however good the track record (see
    // marginClearsTax). Applies here too: a history of winning on an item does not make a two gp
    // margin on it survive a one gp tick.
    if (options.requireMarginOverTax !== false
        && !marginClearsTax(net, tax, options.marginTaxMultiple ?? MARGIN_TAX_MULTIPLE)) continue;
    // A margin too good to be true, on something nobody is trading (see implausibleSpread). This tier
    // does not drop stale prices -- an old last-trade is context here -- which is exactly how a ten-hour
    // old 10 gp print on Rune dart(p++) became a suggestion to buy 1,301 of them.
    if (implausibleSpread(net, p.low, volumeReadingFor(options.volumes, h.itemId))) continue;
    // ...and the same for the buy price itself, which every check downstream takes on trust.
    if (implausibleBuyPrint(p.low, options.volumes?.[String(h.itemId)])) continue;
    let quantity = Math.max(1, Math.round(h.medianQty));
    let cashLimited = false;
    if (maxSpend !== undefined) {
      const affordable = Math.floor(maxSpend / p.low);
      if (affordable < 1) continue; // can't afford even one unit at the current cash stack
      if (affordable < quantity) { quantity = affordable; cashLimited = true; }
    }
    // The same concentration limit the market-wide tier applies (see maxStackShare there). A history
    // of trading an item says nothing about it being safe to put the whole stack into: the losses the
    // backtest found were all one expensive, slow item holding everything, and that shape does not
    // care which tier suggested it.
    let stackLimited = false;
    if (Number.isFinite(options.maxStackShare) && options.maxStackShare > 0 && maxSpend !== undefined) {
      const withinShare = Math.floor(maxSpend * options.maxStackShare / p.low);
      if (withinShare < 1) continue; // one unit alone would commit more of the stack than allowed
      if (withinShare < quantity) { quantity = withinShare; stackLimited = true; }
    }
    // The same volume-share cap the market-wide tier applies (see DEFAULT_MAX_VOLUME_SHARE). Having
    // traded an item before says nothing about the market absorbing a large order today: measured
    // against this account's own offers, orders above 200% of an item's hourly trading finished
    // within a day only 17% of the time, against 65% for orders under 10%.
    let shareLimited = false;
    const ownVolume = options.volumes?.[String(h.itemId)];
    // A MEASURED zero is not missing data. This used to read `ownLiquidity > 0`, so an item nobody
    // had bought in the last hour skipped the cap entirely -- zero demand treated exactly like "no
    // volume data, constrain nothing". That is how an Eclipse Moon chestplate (broken) that no one had
    // bought at the high side for four full hours was suggested at quantity 3, with a sell target
    // resting on a single two-unit print; the player followed it and lost the tax. See volumeReadingFor.
    const ownLiquidity = sizingLiquidityFor(options, h.itemId);
    const personalVolumeShare = Number.isFinite(options.maxVolumeShare) ? options.maxVolumeShare : volumeShareForDuration(targetDurationMinutes);
    if (ownLiquidity !== null) {
      const withinVolume = orderSizeCap(ownLiquidity, targetDurationMinutes, options);
      if (withinVolume !== null && withinVolume < quantity) { quantity = withinVolume; shareLimited = true; }
    }
    let durationLimited = false;
    if (targetDurationMinutes !== undefined) {
      const v = options.volumes?.[String(h.itemId)];
      const liquidity = v ? Math.min(v.highPriceVolume || 0, v.lowPriceVolume || 0) : 0;
      if (liquidity > 0) {
        // Dropped only when even a single unit would run well past the target (see
        // DURATION_TOLERANCE), because the estimate is too imprecise to reject on a near miss.
        if (correctedFillMinutes(estimatedFillMinutes(1, liquidity, VOLUME_WINDOW_MINUTES)) > targetDurationMinutes * DURATION_TOLERANCE) continue;
        // Sizing gets no tolerance: too large is what leaves stock unsold at the end of the window.
        const fillable = Math.max(1, Math.floor(liquidity / VOLUME_WINDOW_MINUTES * targetDurationMinutes / PASSIVE_FILL_FACTOR));
        if (fillable < quantity) { quantity = fillable; durationLimited = true; }
      }
      // No volume data for this item at all: leave it unconstrained -- no signal to judge it by.
    }
    // Tradeable here, and within what's left of this item's GE buy limit over the player's trade window (see limitAllowance).
    const gated = gateCandidate(h.itemId, quantity, options);
    if (!gated) continue;
    let limitLimited = gated.limited;
    quantity = gated.quantity;
    const predictedProfit = net * quantity;
    if (predictedProfit < minProfit) continue;
    const score = tier.score(h, recencyWeight(h.lastTradeAt, now));
    if (score <= 0) continue;
    // Never dropped for staleness here, unlike a market-wide pick: this item has the player's own
    // track record behind it, so an old last-trade is context, not a reason to withhold it.
    const ageMinutes = priceAgeMinutes(p, now);
    candidates.push({h, p, net, score, quantity, predictedProfit, cashLimited, durationLimited, limitLimited, ageMinutes, stackLimited, shareLimited, personalShareUsed: personalVolumeShare});
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const {h, p, quantity, predictedProfit, cashLimited, durationLimited, limitLimited, ageMinutes, stackLimited, shareLimited, personalShareUsed} = candidates[0];
  const notes = [];
  if (cashLimited) notes.push('reduced from your usual size to what your current cash stack can afford');
  if (stackLimited) notes.push(`reduced so this one trade commits at most `+Math.round(options.maxStackShare*100)+`% of your cash stack`);
  if (shareLimited) notes.push(`reduced to `+Math.round(personalShareUsed*100)+`% of what this item trades in a typical hour, so the order isn't larger than the market absorbs`);
  if (durationLimited) notes.push(`reduced to fit an estimated ~${targetDurationMinutes}-minute trade`);
  if (limitLimited) notes.push('reduced to what EVI has seen left of this item\'s GE buy limit, which is all that can fill before the limit resets in 4 hours -- a bigger offer would sit part-filled until then');
  if (ageMinutes !== null && ageMinutes > MAX_PRICE_AGE_MINUTES)
    notes.push(`note that one side of this item's price is about ${Math.round(ageMinutes / 60)} hour(s) old, so the current spread may not be real`);
  return {
    itemId: h.itemId,
    name: h.name,
    action: 'buy', // the suggested next move if you don't already hold this item; both prices below are always populated regardless
    quantity,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'personal',
    // Carried so the sidebar's verdict can say "your N flips here" without re-deriving it from prose.
    trades: h.trades,
    reasoning: `You've flipped this ${h.trades} time${h.trades === 1 ? '' : 's'} with a ${Math.round(h.winRate * 100)}% win rate and ~${Math.round(h.avgProfit).toLocaleString('en-US')} GP average profit. Suggested quantity matches your typical size (${quantity})${notes.length ? ' -- ' + notes.join('; ') : ''}; buy near ${p.low.toLocaleString('en-US')} gp, aim to sell near ${p.high.toLocaleString('en-US')} gp for a predicted ~${Math.round(predictedProfit).toLocaleString('en-US')} gp.`,
  };
}

// Not a ranked pick at all -- a reminder that the player is already holding stock from an earlier
// buy that hasn't been resold yet. Primary source: the plugin tracks this itself, purely from GE
// offer transitions it observes THIS SESSION (see EviLivePlugin.updateHeldForResale()), and sends
// it as holdItemId/holdQty/holdName on every poll. That signal is necessarily empty right after a
// RuneLite/plugin restart, even though the position is still just as real -- it only gets
// refilled by observing a fresh buy-then-collect transition, never by re-noticing something
// collected in an earlier session. See pickPersistentOpenPosition below for the fallback source
// used when this is empty. When present and its current price is available, the caller (GET
// /api/suggestion) uses this instead of computeSuggestion/computeMarketSuggestion entirely --
// closing out a position you already opened takes priority over EVI pointing you at a brand-new
// one, which was the original complaint: buying an item from a suggestion, then having the
// sidebar move straight on to a completely different pick while that first item just sat in the
// inventory unsold. Returns null (never suppresses or affects the normal ranking) when nothing is
// being held, or its price isn't currently available -- the caller falls back to the normal
// ranking in that case.
// A plain live-market price for a single, arbitrary item ID -- no ranking, no flip-history gate,
// no volume/liquidity/affordability filtering, just "what is this item's current low/high right
// now" straight from the already-fetched Wiki /latest data. This is what lets the plugin's hint
// text and fill hotkey work for ANY item currently open in a GE offer (buy or sell), not only
// EVI's own top-ranked pick from computeSuggestion/computeMarketSuggestion/computeHoldingSuggestion
// above -- those answer "what should I trade next"; this answers "what's a fair price for the
// specific item I already have open right now," which is a different, additive question the
// player can ask about literally any item, reviewed or not. Returns null for an invalid item ID or
// when this item has no usable live price right now (same shape/reasoning as the other lookups
// above: never fabricates a number).
export function lookupItemPrice(latestPrices, itemId) {
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  const p = latestPrices?.[String(itemId)];
  if (!p || !(p.low > 0) || !(p.high > 0)) return null;
  return {itemId, buyPrice: p.low, sellPrice: p.high};
}

// Fallback source for the holding reminder above, used only when the plugin's own live
// holdItemId/holdQty is empty (most notably: right after a RuneLite/plugin restart, before any
// buy-collect has been observed fresh this session). Unlike the live signal, this survives
// restarts -- it comes from Store.state().autoOpenPositions, which computeAutoFlips (store.mjs)
// derives from the bridge's own on-disk journal, so it knows about a bought-but-unsold position
// from any earlier session, suggested by EVI or not, exactly as durably as the journal itself.
// account scopes the pick to the account currently asking (never mixes in stock held on a
// different account tracked by this same bridge, which that account couldn't sell anyway);
// blocklist is the same active-GE-slot/skip exclusion set the caller already builds for the
// normal ranking, reused here so an item you're already mid-sale on right now (which the journal
// may not have caught up to yet, since an in-progress sell isn't "finished") is never re-suggested
// as something to newly sell. Ties broken by earliest-bought-first, the same "don't forget the
// oldest thing you're sitting on" intent as the live path's lowest-item-id tiebreak. Returns null
// (never throws) when there's no account, no open positions, or nothing left after exclusions --
// the caller falls through to the normal ranking exactly as when the live signal is empty.
//
// This is a reconstruction from journaled GE offers, not a live read of the player's actual
// inventory -- it can go stale (a position that, in reality, was fully resold through some
// combination of separate sale offers the automatic FIFO matcher in store.mjs didn't perfectly
// reconcile) and, since this only ever nominates its single earliest-bought candidate per call,
// one stale entry can otherwise crowd out a real, currently-held item behind it forever. The
// caller (GET /api/suggestion in server.mjs) marks a suggestion built from this path with
// `persisted: true`; the plugin then verifies it against the player's actual current inventory
// before trusting it (see EviLivePlugin.verifyPersistedHolding), and -- if it isn't actually
// there -- excludes it via the same `exclude=`/blocklist mechanism used for a manual skip, which
// naturally makes the *next* call here advance to the next-earliest candidate instead of
// repeating the same stale one. See the 2026-09-16 "checks the actual inventory" README entry.
export function pickPersistentOpenPosition(openPositions, account, blocklist, isListed) {
  if (!Array.isArray(openPositions) || !account) return null;
  const exclude = blocklist instanceof Set ? blocklist : new Set();
  const listed = typeof isListed === 'function' ? isListed : () => false;
  const mine = openPositions.filter(p => p && p.account === account && p.remaining > 0 && !exclude.has(p.itemId));
  if (!mine.length) return null;
  mine.sort((a, b) => a.firstSeen - b.firstSeen);
  // The FIRST one not already on the market, not simply the oldest.
  //
  // Returning the oldest and letting the caller silence it starved every position behind it. A
  // position already listed is being sold, so the caller correctly declines to remind about it --
  // but it then stopped, and nothing newer was ever reached. Found on novi's own bridge, 29 Sept
  // 2026: a Cannon base listed since 00:02 sat at the head of the queue all day, hiding Granite
  // boots, a Dagon'hai hat and 103 Black d'hide shields behind it, and the queue only advances when
  // a position CLOSES, never when it is merely selling. The trigger is ordinary -- take a
  // suggestion, collect a partial fill, take another -- so this reaches every user, not just a
  // large trader.
  //
  // Walking past a listed position cannot make EVI noisier: it only ever arrives at stock that is
  // genuinely sitting unsold with no offer behind it, which is exactly what this tier is for. If
  // everything is listed there is nothing waiting to be sold, and null is the right answer.
  return mine.find(p => !listed(p.itemId)) || null;
}

// holdBuyId: the specific GE buy offer this holding position came from, when known -- the live
// path (EviLivePlugin.heldForResale) sends the buy offer's own offerId as holdBuyId; the
// persisted-fallback path (pickPersistentOpenPosition below) already carries one on every open
// position it returns (computeAutoFlips's own lot.offerId). Passed straight through as `buyId` on
// the returned suggestion so the plugin can send it back unchanged via POST
// /api/suggestion/personal-use if the player flags this specific holding as personal use (bought
// for their own use, not to flip) -- see Store.markPersonalUse in store.mjs. Left null when not
// supplied (older/partial callers, or a holding signal with no identifiable single buy behind it)
// -- the "Personal use" button simply has nothing to mark in that case, same fail-safe shape as
// every other optional field here.
// holdBuyPrice: the actual average price per unit this holding was bought at, when known -- the
// live path sends it as Held.price (EviLivePlugin, computed from the real GE offer's
// spent/filled, not its set/offered price), and the persisted-fallback path sends it as
// openPosition.unitCost (computeAutoFlips in store.mjs, the exact same lot-cost figure the
// journal's own realized-profit numbers are built from). This exists specifically so a holding
// reminder never again reads as a plain, neutral "sell near X gp" regardless of whether X is
// above or below what was actually paid -- the real failure this was built to fix: EVI suggested
// a buy, the market (or the cached price data) moved against it before the position was even
// fully bought and collected, and the follow-up "you're holding this" reminder said nothing about
// it, reading exactly like a normal profitable flip. Left undefined when not supplied (an older
// caller, or a reconstructed position with no reliable cost basis) -- the reasoning simply falls
// back to its original, cost-agnostic wording, same fail-safe shape as every other optional field
// here; this must never THROW or drop the suggestion for missing cost data, only lose the extra
// context.
export function computeHoldingSuggestion(latestPrices, holdItemId, holdQty, holdName, holdBuyId, holdBuyPrice) {
  if (!Number.isFinite(holdItemId) || holdItemId <= 0 || !Number.isFinite(holdQty) || holdQty <= 0) return null;
  const p = latestPrices?.[String(holdItemId)];
  if (!p || !(p.low > 0) || !(p.high > 0)) return null;
  const name = holdName || `item ${holdItemId}`;
  let reasoning = `You're holding ${holdQty.toLocaleString('en-US')} ${name} from an earlier buy that hasn't been resold yet -- sell near ${p.high.toLocaleString('en-US')} gp before starting anything new.`;
  let breakEvenPrice = null, lossIfSoldNow = null, netIfSoldNow = null;
  if (Number.isFinite(holdBuyPrice) && holdBuyPrice > 0) {
    const tax = estimateUnitTax(holdItemId, p.high);
    const netPerUnit = p.high - holdBuyPrice - tax;
    const totalNet = Math.round(netPerUnit * holdQty);
    breakEvenPrice = breakEvenSellPrice(holdItemId, holdBuyPrice);
    const breakEvenText = breakEvenPrice ? ` Break-even after tax: ${breakEvenPrice.toLocaleString('en-US')} gp.` : '';
    netIfSoldNow = totalNet;
    if (netPerUnit < 0) lossIfSoldNow = Math.abs(totalNet);
    reasoning = netPerUnit >= 0
      ? `You're holding ${holdQty.toLocaleString('en-US')} ${name} bought at ${holdBuyPrice.toLocaleString('en-US')} gp -- selling near ${p.high.toLocaleString('en-US')} gp now would net about +${totalNet.toLocaleString('en-US')} gp.${breakEvenText}`
      // Deliberately a warning, never a block, and not phrased as an instruction either way: the
      // player decides whether to cap the loss now or list at break-even and wait. Both numbers are
      // given so "cut the loss to a minimum" is an informed choice rather than a guess.
      : `WARNING: you're holding ${holdQty.toLocaleString('en-US')} ${name} bought at ${holdBuyPrice.toLocaleString('en-US')} gp -- selling near ${p.high.toLocaleString('en-US')} gp now would be a LOSS of about ${Math.abs(totalNet).toLocaleString('en-US')} gp.${breakEvenText} Not a recommendation either way: sell now to cap the loss at that amount, or list at or above break-even if you'd rather wait for the price to recover (it may not).`;
  }
  return {
    itemId: holdItemId,
    name,
    action: 'sell', // the suggested next move is closing this position out, not opening a new one
    quantity: holdQty,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'holding',
    reasoning,
    buyId: typeof holdBuyId === 'string' && holdBuyId ? holdBuyId : null,
    // null when the real cost basis isn't known -- never estimated.
    breakEvenPrice,
    lossIfSoldNow,
    // What closing this position out is actually worth, total and after tax: positive for a gain,
    // negative for a loss, null when the cost basis is unknown. Returned so the caller can judge
    // whether it deserves to pre-empt a real trade -- see holdingPreempts.
    netIfSoldNow,
  };
}

// Is this item ACTUALLY on the market right now, as opposed to merely still marked SELLING?
//
// Pass `Store.state().active`, which is the plugin's live snapshot of the eight Grand Exchange slots
// with finished offers dropped -- the same source the wealth view and slot reasoning already use, and
// the only one that answers this question.
//
// The journal is NOT that source, and the difference is not small. It keeps an offer's state until the
// bridge SEES it end, so anything cancelled or collected while the bridge was down stays SELLING for
// ever. Measured on novi's journal, 28 Sept 2026: **64 offers still marked open, of which the plugin
// was reporting 8** -- the GE's entire capacity -- with 33 SELLING records covering 29 distinct items
// whose last refresh was over a day earlier, the oldest 343 hours. Reading those as "already listed"
// silences the holding reminder for 29 items the player is not selling, which is the opposite of the
// fault this check exists for.
//
// This first shipped scanning the journal and excluding anything not refreshed within five minutes.
// That worked, but it was a staleness heuristic standing in for data the bridge already had, with a
// window that would have needed defending. `active` needs no window: an offer is in a slot or it is not.
export function hasLiveSellOffer(activeOffers, itemId, account) {
  if (!Number.isFinite(itemId) || !account || !activeOffers) return false;
  for (const o of activeOffers) {
    if (o && o.itemId === itemId && o.state === 'SELLING' && o.account === account) return true;
  }
  return false;
}

// Should a holding reminder take the place of a ranked suggestion?
//
// It always used to, unconditionally, and that is right for the case it was built for: closing out a
// position you already opened beats being pointed at a brand-new one. But it has no sense of scale.
// On 28 Sept 2026, with 205m idle and a 1,000,000 gp minimum set, EVI's answer was to sell one
// Uncooked dragonfruit pie for **152 gp** -- a leftover single unit outranking the entire catalogue.
//
// So: a LOSS always speaks, whatever it is worth, because warn-don't-block is the standing rule here
// and the player needs to know. An unknown value always speaks too, since staying quiet about a
// position because its cost basis is missing would be the wrong way round. What steps aside is a
// merely trivial GAIN -- below the minimum the player set for being shown a trade at all. It is not
// suppressed, only stopped from pre-empting: the ranking runs, and the sidebar's own held-stock
// lines still name the position.
export function holdingPreempts(suggestion, minProfit) {
  if (!suggestion) return false;
  if (!Number.isFinite(suggestion.netIfSoldNow)) return true;   // unknown worth: say it anyway
  if (suggestion.netIfSoldNow < 0) return true;                 // a loss is always worth saying
  if (!Number.isFinite(minProfit) || minProfit <= 0) return true;
  return suggestion.netIfSoldNow >= minProfit;
}

// The lowest whole sell price per unit at which selling nets at least unitCost after GE tax --
// i.e. the price to list at to avoid a loss on stock bought at unitCost. Uses the same tax rules as
// every other calculation here (estimateUnitTax: 2% rounded down, capped at 5m per item, exempt
// items untaxed). Net proceeds (p - tax(p)) never decrease as p rises, so starting from the
// closed-form estimate and nudging a few gp either way is exact. Returns null for a missing or
// non-positive cost -- never a guessed cost basis.
// The plain open-item price, made aware of what the player paid when they hold the item.
//
// Reported from the live client, and it cost GP: a player holding an Eclipse Moon chestplate (broken)
// bought at 595,350 opened a sell offer, and the offer prompt's hint and fill hotkey gave the market's
// current sell price -- also 595,350 -- with no warning, because this lookup has never known anyone's
// cost. Selling there lost exactly the tax, 11,907. The loss-aware version existed only in the
// sidebar's holding reminder, which appeared too late.
//
// Same arithmetic as computeHoldingSuggestion, deliberately: the prompt and the sidebar must never
// disagree about whether a sale loses GP. A warning, never a block -- the price is still offered,
// exactly as the standing warn-don't-block rule requires, with the break-even beside it. Returns the
// price unchanged when the cost is unknown: never a guessed cost basis.
export function withCostBasis(openItemPrice, unitCost, quantity = 1) {
  if (!openItemPrice || !Number.isFinite(unitCost) || unitCost <= 0) return openItemPrice;
  const breakEvenPrice = breakEvenSellPrice(openItemPrice.itemId, unitCost);
  const tax = estimateUnitTax(openItemPrice.itemId, openItemPrice.sellPrice);
  const netPerUnit = openItemPrice.sellPrice - unitCost - tax;
  const held = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
  return {
    ...openItemPrice,
    // Marks it as a sale of stock the player holds, which is what lets the prompt's existing loss
    // warning fire. Matching to the open offer is by item ID alone, so a buy prompt is unaffected.
    action: 'sell',
    breakEvenPrice,
    lossIfSoldNow: netPerUnit < 0 ? Math.round(Math.abs(netPerUnit) * held) : null,
  };
}

// What the player has paid, on average, for the units of an item they hold -- for the offer prompt's
// loss warning. Counts two sources:
//   * finished purchases still held (FIFO open positions), at each lot's own unit cost;
//   * buy offers STILL RUNNING that have filled some units. Asked for by the user, who collects
//     part of a large order (2,200 of 12,001 diamond dragon bolts) while the rest keeps filling. The
//     FIFO journal only admits a purchase once the offer finishes, so until then the prompt had no
//     idea what those collected units cost and could not warn before selling them at a loss.
// An open buy is never double counted: FIFO excludes unfinished offers, so it appears in exactly one
// source. The average is over everything held, which is what "what did I pay for these" means at the
// prompt; the books still match sales first-in-first-out once the order finishes. Returns null when
// nothing held has a known price -- never a guessed cost.
export function heldCostBasis(openPositions, activeOffers, itemId, account) {
  const mine = x => x && x.itemId === itemId && (!account || x.account === account);
  let units = 0, gp = 0;
  for (const p of openPositions || []) {
    if (!mine(p) || !(p.unitCost > 0) || !(p.remaining > 0)) continue;
    units += p.remaining; gp += p.unitCost * p.remaining;
  }
  for (const o of activeOffers || []) {
    if (!mine(o) || o.state !== 'BUYING' || !(o.filled > 0) || !(o.spent > 0)) continue;
    units += o.filled; gp += o.spent;
  }
  return units > 0 ? {unitCost: gp / units, quantity: units} : null;
}

export function breakEvenSellPrice(itemId, unitCost) {
  if (!Number.isFinite(unitCost) || unitCost <= 0) return null;
  const clears = p => p - estimateUnitTax(itemId, p) >= unitCost;
  let p = Math.ceil(unitCost);
  if (clears(p)) return p; // tax-exempt, or too cheap to be taxed
  p = Math.min(Math.ceil(unitCost * 50 / 49), Math.ceil(unitCost) + 5000000);
  for (let i = 0; i < 1000 && !clears(p); i++) p++;
  for (let i = 0; i < 1000 && p > 1 && clears(p - 1); i++) p--;
  return clears(p) ? p : null;
}

// The fallback of last resort, checked only when nothing else above has anything to suggest (no
// live hold, no persisted-fallback hold from the journal, no personal-history ranked pick). Every
// other holding-reminder path above only ever reconstructs from an *observed buy* -- live this
// session, or journaled from an earlier one -- so stock that arrived some other way (a quest/drop
// reward, a purchase made before this bridge ever started watching, or supplies bought for
// personal use and never logged through a "flip" at all) never surfaces as anything to sell, no
// matter how long it sits there. This is the gap that closes: it scans the player's own current
// inventory (sent by the plugin only when EviLiveConfig.suggestIdleInventory() is turned on --
// see EviLivePlugin.refreshInventoryItemIds/suggestionQuery) for anything with a meaningful GE
// sell value and no active offer, with no flip history or observed-buy requirement at all. Ranks
// purely by current total GE sell value (quantity * high price) since there's no track record to
// judge it by otherwise, and applies MIN_INVENTORY_VALUE as a floor so trivial junk never gets
// suggested.
// inventory: {[itemId]: quantity} -- the plugin's own current inventory snapshot, already summed
// across any unstacked duplicate slots. Coins and platinum tokens (COINS_ITEM_ID,
// PLATINUM_TOKEN_ITEM_ID) are always excluded -- gp itself is never "something to sell". mapping: the Wiki /mapping response body (array of {id, name, limit,
// members, ...}), used only to resolve a display name.
// options.blocklist: unlike computeSuggestion/computeMarketSuggestion's blocklist (session
// skip/active-GE-slot exclusions only), the caller (GET /api/suggestion) also merges in every
// item ID behind a personal-use-flagged buy here specifically -- see Store.state's
// personalUseItemIds -- never into the blocklist passed to the other ranking functions, since
// flagging one past purchase as personal use must never block a genuinely new, separate flip of
// the same item bought later. Returns a single best candidate (or null); source:'inventory',
// buyId:null since, by definition, there is no specific buy offer behind this pick to round-trip
// through the personal-use flow.
const COINS_ITEM_ID = 995;
// Platinum tokens are gp too, at 1,000 each. Excluded for exactly the same reason coins are, and
// the omission became a contradiction on 30 Sept 2026: the plugin now counts tokens as spending
// power (refreshCashStack), so without this the idle-inventory tier would offer to SELL the very
// stack the buy tiers were sizing against -- telling a player holding 5,000 tokens both that they
// have 5m to spend and that they should sell 5m of stock.
const PLATINUM_TOKEN_ITEM_ID = 13204;
const MIN_INVENTORY_VALUE = 100000;
export function computeInventorySuggestion(latestPrices, inventory, mapping, options = {}) {
  if (!inventory || typeof inventory !== 'object' || !Array.isArray(mapping) || !latestPrices) return null;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  // Items EVI DID watch being bought and holds a cost basis for. They belong to the holding tier,
  // which can state what was paid, what selling now nets and where break-even is. This tier cannot:
  // its whole sentence is "no buy EVI ever observed for it -- likely a drop, a quest reward, or
  // stock from before this bridge started watching", which about one of these is simply false.
  //
  // It said exactly that on 30 September 2026. A player raised their minimum profit;
  // holdingPreempts silenced the holding tier for a Gilded d'hide vambraces worth +254,063; and
  // THIS tier, which runs last, picked up the same vambraces one second later and called it stock
  // EVI never saw bought -- with breakEvenPrice null, after quoting 4,183,673 for it a minute
  // earlier. Both lines are in suggestion-log.jsonl a minute apart.
  //
  // Note what this does NOT do: it does not put the holding back. When the holding tier steps aside
  // the player now hears nothing about that item, which is what holdingPreempts actually decided.
  // That is the point -- the wrong sentence was hiding the cost of that decision behind a right-
  // looking card, and a gate whose effect is invisible cannot be judged.
  const positionItemIds = options.positionItemIds instanceof Set ? options.positionItemIds : new Set();
  // How many of each item the player keeps FOR USE, when they have said so with a quantity.
  // Marking an item personal-use used to hide every unit of it for ever -- the one being worn and
  // any duplicate that dropped -- because "I own one of these for use" and "I never sell this item"
  // were the same statement. novi, 29 Sept: "if I get an ancestral robe top for example as a drop,
  // it will probably still not suggest to sell that one." It bites hardest for a player who marks
  // their whip, is later given one as a drop, carries it, and is never told it is worth 2m.
  const keptForUse = options.keptForUse instanceof Map ? options.keptForUse
    : new Map(Object.entries(options.keptForUse || {}).map(([k, v]) => [Number(k), v]));
  const names = new Map(mapping.filter(m => m && Number.isFinite(m.id)).map(m => [m.id, m.name]));
  const candidates = [];
  for (const [idStr, qty] of Object.entries(inventory)) {
    const itemId = parseInt(idStr, 10);
    // A members item can't be sold on a free-to-play world either, so the same gate applies here.
    if (!Number.isFinite(itemId) || itemId === COINS_ITEM_ID || itemId === PLATINUM_TOKEN_ITEM_ID || !(qty > 0) || blocklist.has(itemId) || positionItemIds.has(itemId) || options.membersBlocked?.(itemId)) continue;
    const p = latestPrices[String(itemId)];
    if (!p || !(p.low > 0) || !(p.high > 0)) continue;
    // Only the SURPLUS above what is kept for use is stock. Holding exactly what you keep leaves
    // nothing to offer, which is the common case and must stay silent.
    const kept = keptForUse.get(itemId);
    const sellable = Number.isFinite(kept) ? qty - Math.max(1, kept) : qty;
    if (!(sellable > 0)) continue;
    const value = sellable * p.high;
    if (value < MIN_INVENTORY_VALUE) continue;
    candidates.push({itemId, qty: sellable, p, value, name: names.get(itemId) || `item ${itemId}`});
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.value - a.value);
  const {itemId, qty, p, value, name} = candidates[0];
  return {
    itemId,
    name,
    action: 'sell',
    quantity: qty,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'inventory',
    buyId: null,
    reasoning: `You're holding ${qty.toLocaleString('en-US')} ${name} worth an estimated ${Math.round(value).toLocaleString('en-US')} gp at current prices, with no active offer and no buy EVI ever observed for it -- likely a drop, a quest reward, or stock from before this bridge started watching. Sell near ${p.high.toLocaleString('en-US')} gp if you don't need it.`,
  };
}

/**
 * Is this pick one of the two BUYS that "Best of both" is meant to choose between?
 *
 * The setting exists because the personal-history tier could silently veto a better market pick --
 * two ways of answering "what should I buy next", where keeping the worse one costs the player the
 * difference. Both are claims on the same free slot and the same coins, so comparing them is right.
 *
 * A SELL of stock already owned is not a third answer to that question. The player holds it either
 * way; selling it consumes neither the slot nor the coins the buy needs, and with a free slot they
 * can do both. Ranking the two by value therefore compares nothing: whichever "loses" does not stop
 * being worth doing. Until 30 September 2026 it did compare them, and the bridge's own words for it
 * were "Your own Gilded d'hide vambraces is worth about 209,700 gp ... against 1,114,253 gp for this
 * market-wide pick, so EVI set your history aside this time." novi was holding 1 Gilded d'hide
 * vambraces, had four free slots, and could not get EVI to mention them even at "No minimum at all"
 * -- which bypasses the OTHER gate on holdings (holdingPreempts) and lands squarely on this one.
 *
 * Whether a holding should pre-empt a new trade at all is a separate question with its own answer
 * (holdingPreempts, judged against the player's minimum profit). This function must not also decide
 * it, or one behaviour is governed in two places that cannot see each other.
 */
export function comparableAsHistoryPick(suggestion, wantSource) {
  return wantSource === 'both' && !!suggestion && suggestion.action === 'buy';
}

// An hourly-volume floor below which an item is excluded from market-wide candidates even at a
// great margin: the Wiki's high/low prices are last-traded prices, not a live orderbook, so a
// barely-traded item can show a wide, stale, unrealistic spread. Deliberately conservative --
// this free tier has no real depth-of-book signal, only this one coarse proxy.
const MIN_HOURLY_VOLUME = 5;
// Caps a market-wide pick's suggested quantity ONLY when the item's own GE buy limit is unknown --
// deliberately small, since this is an item with no track record and no known ceiling. When the
// limit IS known (the Wiki's /mapping gives one for most items), that limit is the size, because it
// is the real ceiling the GE itself enforces per 4 hours. This flat cap used to apply to every
// candidate regardless, which the surrounding doc already said it shouldn't: it silently held every
// market-wide pick to 100 units, so with a 500k minimum predicted profit only items with ~5,000 gp
// margin per unit could ever qualify, ruling out exactly the high-volume, thinner-margin flips that
// reach that profit through quantity. Changed on the user's explicit instruction. The cash stack
// (maxSpend) and the target trade duration both still cap the quantity afterwards, so a bigger size
// is only ever suggested when it is actually affordable and realistically tradeable.
const DEFAULT_MARKET_QUANTITY_CAP = 100;
// The share of an item's recent hourly trading a single suggestion may represent, applied unless the
// caller overrides it (0 turns it off). Chosen by backtest, not by feel: replaying 90 archived days
// with no cap left 93-94% of committed capital still stuck in unsold stock at the 24-hour horizon,
// with only 8 completed sales out of 249 positions on a 50m stack. At 10% the same 90 days produced
// 139 completed sales on a 50m stack and 220 on a 2m one, cutting stuck capital to 29-45% and
// leaving far less unrealised exposure. Tighter (5%) sells slightly more but earns less per sale;
// looser (25%) leaves a lot more capital tied up. Sizing an order beyond what an item actually
// trades is what creates stuck positions, which is the single failure mode behind every loss the
// backtest found.
const DEFAULT_MAX_VOLUME_SHARE = 0.10;

// How much of an item's hourly trading one order may be, given how long the player is willing to
// wait. 10% at every trade length was too tight for a long one: at the player's own settings (500k+
// profit, 12-hour trades) it put 500k out of reach on liquid items and pushed EVI towards thin,
// stale ones instead -- exactly the items the sell-price check then has to warn about.
//
// Measured, not chosen (tools/fill-by-size.mjs, 427 of this account's own offers watched from
// placement). Its point is that a cancelled order is not a failed one: most large orders here were
// cancelled within minutes on another tool's advice, so counting them as failures understates them.
// Treating a cancellation as "stopped watching" instead (Kaplan-Meier), the chance an order filled:
//
//   size of order vs the item's hourly volume     within 6h     within 12h
//   under 10%                                        82%           82%
//   10-25%                                           60%           70%
//   25-50%                                           52%           82%
//   50-100%                                          26%           49%
//   over 200%                                        16%           25%
//
// So at 12 hours everything up to half an hour's volume behaves much alike and clearly better than
// anything past it, while at 6 hours the larger sizes are already worse, and at 1 hour only the
// smallest holds up (37% for 10-50% against 65%). Hence three steps rather than a formula: the
// evidence supports "about the same up to 50% if you will wait half a day", not a precise curve.
// These are upper bounds -- orders were often cancelled BECAUSE they looked slow -- so the steps stay
// conservative, and the 10% floor is kept for anyone who has not set a duration at all.
// How much of an item's HOURLY volume one order may be, given how long the player will wait for it.
//
// This was a three-step ladder -- 10% under six hours, 25% at six, 50% at twelve -- and it stopped
// there, because twelve hours was the longest trade duration that existed when it was written. On
// 26 Sept 2026 TradePace added Overnight (~12h) and Slow (~2 days) and this was not extended with it.
// The consequence showed up on 28 Sept: on the Slow pace, with 205m idle and a 1,000,000 gp minimum,
// the market-wide tier had **nothing at all** to suggest -- its best pick in the entire catalogue was
// 5,594 Adamant arrows for 5,594 gp -- because every liquid item was sized to a handful of units. A
// blowpipe ornament kit trading 66 units a day was capped at one. Raising the cap to 1x turns that
// same moment into a 2.06m trade, so the cap, not the ranking, was the whole problem.
//
// The ladder was never really three steps: 0.25 at six hours and 0.50 at twelve are both exactly
// 4.17% of what the item trades during the window, which is `hours / 24`. So this is the same rule
// it always was, continued past the point where it stopped. Every value the old ladder produced is
// reproduced exactly -- 6h -> 0.25, 12h -> 0.50 -- and only the paces it never covered are new:
// 24h -> 1.00, and Slow's two days -> 2.00.
//
// The floor stays at DEFAULT_MAX_VOLUME_SHARE so a very short pace is no more permissive than before.
//
// **This is an extrapolation, not a measurement, and the difference matters.** The one measured point
// is tools/fill-by-size.mjs: at a TWELVE-hour horizon an order up to 50% of hourly volume filled about
// as often as a small one. Re-running it at a 48-hour horizon returns byte-identical numbers, because
// nearly every large order in this journal was cancelled within minutes -- 52 of the 61 largest -- so
// there is nothing left standing to observe and the counterfactual has never been run. Leaving a large
// order up for a full two days a few times is the experiment that would confirm or refute this.
// Only the region past twelve hours changes. Below it the old steps are kept exactly, because making
// a five-hour trade more permissive would be extrapolating in the risky direction with nothing behind
// it -- the measured point is at twelve hours and the steps under it were deliberately conservative.
const VOLUME_SHARE_PER_HOUR = 1 / 24;
// The most of one hour's volume a single order may ever be, however long the player will wait. Both
// measurements behind volumeShareForDuration put the useful ceiling here: past about 2x, median
// profit stops rising while hold time and the loss rate keep climbing.
export const MAX_VOLUME_SHARE = 2;
/**
 * The most units one order may be, given an item hourly liquidity and the player window.
 *
 * Two rules in the same place because they answer the same question in different units, and mixing
 * them up is what shut a large stack out of thin markets. The default is a multiple of ONE hour
 * volume; options.volumeWindowShare instead takes a share of the volume that will trade in the whole
 * window, which is what "Bigger positions" turns on. See PositionSizing.java for the measurement.
 */
export function orderSizeCap(liquidity, targetDurationMinutes, options = {}) {
  // A MEASURED zero is not missing data, and the two must not be conflated here. Zero demand means
  // one unit, never "no constraint" -- that conflation is how an Eclipse Moon chestplate (broken)
  // nobody had bought for four hours was suggested at quantity 3 against a single two-unit print.
  // Callers separate the two before this is reached (volumeReadingFor returns null for absent data),
  // so anything arriving here is a real reading and the floor of one below is what zero deserves.
  if (!Number.isFinite(liquidity) || liquidity < 0) return null;
  if (Number.isFinite(options.volumeWindowShare) && options.volumeWindowShare > 0) {
    const windowHours = Number.isFinite(targetDurationMinutes) && targetDurationMinutes > 0 ? targetDurationMinutes / 60 : 1;
    return Math.max(1, Math.floor(liquidity * windowHours * options.volumeWindowShare));
  }
  const share = Number.isFinite(options.maxVolumeShare) ? options.maxVolumeShare : volumeShareForDuration(targetDurationMinutes);
  if (!(share > 0)) return null;
  return Math.max(1, Math.floor(liquidity * share));
}

export function volumeShareForDuration(targetDurationMinutes) {
  if (!Number.isFinite(targetDurationMinutes) || targetDurationMinutes <= 0) return DEFAULT_MAX_VOLUME_SHARE;
  // Reaches the ceiling at twelve hours instead of two days, and stops there. Changed 28 Sept 2026
  // on two measurements that agree, after novi's head-to-head: with 100m in hand Copilot offered 24
  // Echo virtus ornament kits, an item trading about 4 an hour, where EVI would allow 2.
  //
  // The old ladder was hours/24, a constant 1/24th of the volume that will trade in the window, and
  // it came from tools/fill-by-size.mjs -- whose real finding was narrower than it read. Orders up to
  // about half an hour's volume filled as often as small ones, and there was almost nothing ABOVE
  // that line to judge, because 52 of the 61 largest orders were cancelled within minutes. The cap
  // sat at an observation ceiling, not at a measured cliff.
  //
  // tools/copilot-fill-sizes.mjs supplied the missing half from a player's COMPLETED Copilot
  // flips, which are sized far more aggressively: 59% of them were larger than this cap allowed, and
  // banded against one hour of the item's volume the median profit runs 34,510 at or under 0.5x,
  // 122,167 from 0.5x to 2x, then flattens (119,064 at 2x-5x, 161,462 at 5x-20x) while the median
  // hold climbs 1.3h -> 11.3h -> 16.4h -> 19.5h, and collapses past 20x. That is survivorship -- a
  // Copilot order that never filled never became a flip -- so it is an existence result about what
  // size is achievable, never a fill rate.
  //
  // tools/market-tier-ranking.mjs then tested it on outcomes rather than survivors, and agreed. At a
  // twelve-hour pace, doubling the share held the median return at 5.56%, moved the median order from
  // 900,000 to 6,620,550 and total profit up 33%, for a loss rate of 8% against 6%. Doubling AGAIN
  // was clearly worse (4.29% return, 14% losing), and at a two-day pace -- where the share was
  // already 2x -- doubling took the loss rate from 8% to 14% and doubled stuck capital for 20% more
  // profit. Both measurements put the useful ceiling at about 2x an hour's volume.
  //
  // So the ladder climbs at twice the old rate and is capped where the evidence stops supporting it.
  // Twelve hours goes 0.50x -> 1.00x; two days stays at 2.00x, which it already was.
  if (targetDurationMinutes >= 12 * 60)
    return Math.min(MAX_VOLUME_SHARE, (targetDurationMinutes / 60) * VOLUME_SHARE_PER_HOUR * 2);
  // Under twelve hours is deliberately unchanged. The band that carries the extra profit takes about
  // eleven hours to fill, so it belongs to a twelve-hour trade or longer; at a six-hour pace the same
  // widening measurably cost return (6.94% -> 5.56%) to buy size the window cannot settle.
  if (targetDurationMinutes >= 6 * 60) return 0.25;
  return DEFAULT_MAX_VOLUME_SHARE;
}

// The fallback this tier reaches for only when computeSuggestion above finds nothing eligible in
// this account's own history: ranks the *entire* item catalogue by current net margin after tax,
// gated by a minimum-hourly-volume liquidity floor so an untraded item's stale spread can't win
// just because nobody is around to close the margin. Deliberately simpler than the browser
// scanner's own multi-factor score (no price-history/prediction signal, no personal-history
// weighting) -- this is meant as a "something is currently open" nudge for items you have no
// track record on, not a replacement for reviewing it yourself before committing capital.
// mapping: the Wiki /mapping response body (array of {id, name, limit, members, ...}).
// volumes: the Wiki /1h response's "data" object, keyed by item ID, each an
// {avgHighPrice, highPriceVolume, avgLowPrice, lowPriceVolume} snapshot.
// options.maxSpend: the player's actual current cash stack (read from their inventory's coins),
// optional. Without it, this ranks purely by per-unit margin, which can surface a huge-margin,
// low-limit item (e.g. a rare piece of equipment) at a quantity nobody could actually afford --
// OSRS's own cash stack caps out at ~2.147 billion gp, and a suggestion should never assume more
// than the player actually has on hand. With maxSpend set: an item costing more than that per unit
// is dropped outright (unaffordable even at quantity 1); every other candidate's quantity is
// capped so total cost never exceeds it; and ranking switches from per-unit net margin to total
// realizable profit at that affordable quantity, so the pick is the best trade actually reachable
// with the cash on hand, not just the item with the biggest margin per unit.
// options.targetDurationMinutes: the player's own preferred trade length, checked against this
// same volumes argument (already fetched for the liquidity floor below, so this adds no extra
// cost) via estimatedFillMinutes -- a candidate that couldn't realistically trade even one unit
// within that window is dropped, and one that could but only at a smaller quantity has it capped
// down, exactly like maxSpend, and also switches ranking to total realizable profit (see below).
/**
 * A steady view of what an item has been worth, from archived hourly averages: the MEDIAN of each
 * side over the last `hours` hours, in the same shape as the Wiki's `latest`.
 *
 * This exists because the market tier ranks on `latest`, where `high` is the last price anyone paid
 * and `low` the last price anyone sold at. Its score is built on `high - low - tax`, so maximising
 * that gap is an argmax over outliers: the item whose last print was a fluke is exactly the one that
 * wins. Measured live on 28 Sept 2026, an Ape atoll teleport (tablet) was ranked top on a
 * `latest.high` of 28,756 while every hourly average that day sat between 6,000 and 6,300.
 *
 * A median rather than a mean, so a single freak hour moves the estimate by one rank instead of by
 * its own size. Returns nothing for an item with no archived hours, which is fail-open on purpose:
 * `computeMarketSuggestion` then ranks that item exactly as it does today rather than dropping it,
 * so a fresh install with no archive behaves precisely as before.
 *
 * Measured by tools/market-tier-ranking.mjs, which runs the shipped ranking twice over the archive
 * and changes only where prices come from. Over 14 days at an 89m stack, ranking this way instead of
 * on the last print moved the median return 2.23% -> 5.56%, the share of picks that ever reached
 * break-even 77% -> 92%, the share that lose GP 23% -> 8%, and capital left stuck 4.06bn -> 513m. It
 * was never worse at any stack size tested, and at 200k-2m the two are level on return while this one
 * still loses less.
 */
export function robustPrices(hourlyBuckets, hours = ROBUST_PRICE_HOURS) {
  if (!Array.isArray(hourlyBuckets) || !hourlyBuckets.length) return null;
  const newest = hourlyBuckets.reduce((m, b) => Math.max(m, b?.ts || 0), 0);
  const from = newest - hours * 3600;
  const highs = new Map(), lows = new Map();
  for (const bucket of hourlyBuckets) {
    if (!bucket || !bucket.d || !(bucket.ts > from)) continue;
    for (const [id, row] of Object.entries(bucket.d)) {
      if (!Array.isArray(row)) continue;
      if (row[0] > 0) { if (!highs.has(id)) highs.set(id, []); highs.get(id).push(row[0]); }
      if (row[2] > 0) { if (!lows.has(id)) lows.set(id, []); lows.get(id).push(row[2]); }
    }
  }
  const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const out = {};
  for (const [id, h] of highs) {
    const l = lows.get(id);
    if (!l || !l.length || !h.length) continue;
    // Too few hours is not a steady reading, it is one print wearing a median's clothes. Left out, so
    // the item falls back to being ranked on `latest` exactly as before.
    if (h.length < MIN_ROBUST_HOURS || l.length < MIN_ROBUST_HOURS) continue;
    out[id] = {high: median(h), low: median(l)};
  }
  return Object.keys(out).length ? out : null;
}
/**
 * How much history the robust price takes its median from, and the least it will accept.
 *
 * Two weeks, not one day. 24 hours was chosen on 28 Sept 2026 because it was obviously long enough
 * to drown a single freak print, which was the problem in front of us -- an Ape atoll teleport
 * (tablet) topping the catalogue on one 28,756 print against hourly averages of 6,000. Nothing said
 * 24 was right, and it is not long enough for the next problem along: a bad DAY.
 *
 * A player was offered Raw kyatt the same evening. Over 14 archived days its margin has a median
 * of 14 gp on an item costing 1,136, whose own GE tax is about 22 -- so its typical edge is thinner
 * than its tax, the exact band this tier refuses at, and it is negative in 37% of hours. It passed
 * because the last day happened to be unusually wide, and a 24-hour median endorses an unusually
 * wide day. That is the blood-rune shape wearing a different hat.
 *
 * Measured by tools/robust-window.mjs, which varies nothing but this number. Across a two-day pace
 * at 85m, a twelve-hour pace at 85m, and a twelve-hour pace at 2m, moving 24h -> 336h:
 *
 *   worst single trade   -32.4% -> -6.5%,  -35.1% -> -4.3%,  -35.1% -> -0.6%
 *   picks that lose GP     9% -> 3%,         8% -> 6%,         4% -> 1%
 *   picks reaching B/E    89% -> 97%,       89% -> 94%,       94% -> 98%
 *   total profit         56.7m -> 71.5m,   31.3m -> 32.1m,   17.4m -> 16.0m
 *
 * A large, consistent improvement in the tail for roughly neutral total profit -- which is the trade
 * this project takes every time, because the tail is what the adamant arrows and the blood runes
 * were. 72h and 168h were also measured and sit between the two, monotonically in the worst case.
 *
 * It degrades gracefully on a fresh install: MIN_ROBUST_HOURS still governs, so an item with only a
 * few days of archive is judged on what exists rather than dropped, and one with almost none falls
 * back to the live price exactly as before. See robustPricesCached in server.mjs for why this must
 * be read through readArchive and cached rather than recomputed per request.
 */
export const ROBUST_PRICE_HOURS = 336;
export const MIN_ROBUST_HOURS = 6;

/**
 * A quoted BUY price can be a print rather than a price, and every other check takes it as given.
 *
 * Found live on 29 Sept 2026: EVI offered 2,000 Divine super defence potion(4) at **299** to sell at
 * 5,177, a headline of nearly 10m gp. The item normally trades around 5,000-5,500, and its own hour
 * had an average sell of **2,984 across 1,898 real trades** -- the 299 was a single print, a tenth of
 * what everyone else in that same hour got. novi's read on the cause is the likely one: a player
 * emptying leftovers after training Herblore floods the low side, which explains the volume spike and
 * the crashed print together.
 *
 * Nothing caught it, and the reason is structural. The robust gate judged the ITEM and was right to
 * pass it -- its steady spread is 5,022 -> 5,579, a real 446 gp margin. `implausibleSpread` requires
 * the hour to be empty, and this hour was the busiest in a fortnight. And `headlineProfit` caps the
 * figure using sell-support, but sell-support measures the SELL side and then subtracts the same
 * bogus 299, so both of its inputs inherited the bad number and `min(quoted, supported)` was still
 * about 9.5m. **Everything downstream trusted buyPrice; nothing validated it.**
 *
 * The test is deliberately against the SAME HOUR's own average rather than the 14-day median. An item
 * in a genuine sustained decline sits far below its fortnight median quite legitimately and must not
 * be dropped for it; a print at half of what 1,898 other trades in the same hour fetched cannot be
 * explained that way. Measured across 2,496 items with a traded hourly average: the median print is
 * 1.000x its hour's average, the 10th percentile 0.954x, the 1st percentile 0.506x. A cut at 0.5x
 * touches **22 items, 0.88%**; the potion was at 0.100x.
 *
 * Returns false whenever there is nothing to judge against -- no average, or an hour with no trades
 * on that side -- the standing fail-open rule. Absence of evidence never invents a constraint; this
 * fires only on evidence that the print disagrees with its own hour.
 */
export const BUY_PRINT_MULTIPLE = 0.5;
export function implausibleBuyPrint(low, volumeEntry, multiple = BUY_PRINT_MULTIPLE) {
  if (!Number.isFinite(low) || low <= 0) return false;
  const avg = volumeEntry?.avgLowPrice;
  const traded = volumeEntry?.lowPriceVolume;
  if (!(avg > 0) || !(traded > 0)) return false;
  return low < avg * multiple;
}

export function computeMarketSuggestion(mapping, latestPrices, volumes, options = {}) {
  if (!Array.isArray(mapping) || !latestPrices) return null;
  const minProfit = Number.isFinite(options.minProfit) && options.minProfit > 0 ? options.minProfit : 0;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  // >= 0, not > 0: an EMPTY coin pouch is a real answer, not a missing one. The plugin sends no
  // cash parameter at all when it has not read the inventory yet (cashStack -1), so absent already
  // means unknown -- and treating a genuine 0 as unknown removed the cap entirely. Found by novi on
  // 29 Sept 2026 after banking their coins: EVI offered four 3rd age robe tops at 131,812,123 each,
  // over half a billion gp, to a player carrying nothing. At cash=1000 it correctly sized down to a
  // 200 gp trade, which is what made the falsy-zero obvious.
  const maxSpend = Number.isFinite(options.maxSpend) && options.maxSpend >= 0 ? options.maxSpend : undefined;
  const targetDurationMinutes = Number.isFinite(options.targetDurationMinutes) && options.targetDurationMinutes > 0 ? options.targetDurationMinutes : undefined;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const maxPriceAgeMinutes = Number.isFinite(options.maxPriceAgeMinutes) ? options.maxPriceAgeMinutes : MAX_PRICE_AGE_MINUTES;
  // See the note where this is applied below: off unless the caller asks for it.
  // Defaults to DEFAULT_MAX_VOLUME_SHARE; an explicit 0 (or a negative) turns the cap off entirely.
  const volumeShare = Number.isFinite(options.maxVolumeShare) ? options.maxVolumeShare : volumeShareForDuration(targetDurationMinutes);
  const maxVolumeShare = volumeShare;
  const candidates = [];
  for (const item of mapping) {
    if (!item || !Number.isFinite(item.id) || blocklist.has(item.id)) continue;
    // A members-only item can't be traded on a free-to-play world at all. `item.members === true`
    // is the mapping's own flag; the caller's membersBlocked gate (same answer, one source) is used
    // when supplied so every tier agrees.
    if (options.membersBlocked ? options.membersBlocked(item.id) : false) continue;
    const p = latestPrices[String(item.id)];
    if (!p || !(p.low > 0) || !(p.high > 0)) continue;
    const v = volumes?.[String(item.id)];
    const liquidity = Math.min(v?.highPriceVolume || 0, v?.lowPriceVolume || 0);
    // The floor above ("does this item trade at all") stays on the LATEST hour, because that is a
    // question about now. Only the SIZE moves to a typical hour -- see sizingLiquidityFor.
    const sizingLiquidity = sizingLiquidityFor(options, item.id) ?? liquidity;
    // options.minHourlyVolume raises the liquidity floor above the conservative default, for callers
    // who would rather only see items that clearly trade all day.
    //
    // options.minVolumeInWindow replaces the per-HOUR floor with a per-WINDOW one, because the two
    // are in different units and the mismatch is what shuts a large cash stack out. The floor asks
    // for 5 units an hour whatever the player's pace, so an item trading 3 an hour is excluded even
    // on a two-day trade -- where it will trade 144 units, and a 45m item needs 2 of them to commit
    // 90m. Measured 28 Sept 2026: this one gate drops 1,388 items at a 2-day pace, more than any
    // other stage, and the largest unconstrained trade among them is worth 2.5bn.
    //
    // Opt-in and off by default, because a thin market is a real risk and not merely an inconvenient
    // one. thinMarket.mjs is the measured backstop underneath it (under 10% of hours traded, or under
    // 50% price recurrence, warns and demotes), so relaxing the raw hourly count does not leave an
    // illiquid item unexamined -- but it is never the default until the measurement says so.
    const windowHours = targetDurationMinutes !== undefined ? targetDurationMinutes / 60 : 1;
    const liquidityFloorMet = Number.isFinite(options.minVolumeInWindow) && options.minVolumeInWindow > 0
      ? liquidity * windowHours >= options.minVolumeInWindow
      : liquidity >= Math.max(MIN_HOURLY_VOLUME, options.minHourlyVolume || 0);
    if (!liquidityFloorMet) continue;
    // options.taxFreeOnly keeps only items the GE charges no tax on (under 50 gp, or on the
    // exemption list). Tax took 43% of this account's gross spread over 296 days, so for a small
    // stack working thin margins it can be the difference between growing and standing still.
    if (options.taxFreeOnly && estimateUnitTax(item.id, p.high) > 0) continue;
    // No track record backs this tier, so a spread nobody has traded on either side recently is
    // dropped outright rather than ranked (see priceAgeMinutes). Unknown timestamps fail open.
    const ageMinutes = priceAgeMinutes(p, now);
    if (ageMinutes !== null && ageMinutes > maxPriceAgeMinutes) continue;
    const tax = estimateUnitTax(item.id, p.high);
    const net = p.high - p.low - tax;
    if (net <= 0) continue;
    // The tier a player with no history gets, and the one that suggested the blood runes: an edge
    // thinner than the item's own tax is not offered at all (see marginClearsTax). Held to the
    // stricter no-history bar -- there is no track record here to earn the benefit of the doubt.
    if (options.requireMarginOverTax !== false
        && !marginClearsTax(net, tax, options.marginTaxMultiple ?? MARGIN_TAX_NO_HISTORY_MULTIPLE)) continue;
    // RANK on a steady price, QUOTE the live one. `options.rankPrices` (see robustPrices) holds each
    // item's median over the last day; `p` above stays the live reading, because that is the only
    // price anyone can actually transact at and quoting a median nobody is paying would be a
    // different change entirely -- an unmeasured one, and sell-side patience has already been
    // measured separately (tools/sell-patience-observed.mjs).
    //
    // The item has to clear every bar on BOTH views. Robust alone would let EVI offer a spread that
    // has since closed; live alone is what let one freak print win the whole ranking. An item with no
    // robust reading keeps the live one for both, so nothing changes on a fresh install with no
    // archive yet.
    const r = options.rankPrices?.[String(item.id)];
    const rankHigh = r && r.high > 0 ? r.high : p.high;
    const rankLow = r && r.low > 0 ? r.low : p.low;
    const rankTax = estimateUnitTax(item.id, rankHigh);
    const netRank = rankHigh - rankLow - rankTax;
    if (netRank <= 0) continue;
    if (options.requireMarginOverTax !== false
        && !marginClearsTax(netRank, rankTax, options.marginTaxMultiple ?? MARGIN_TAX_NO_HISTORY_MULTIPLE)) continue;
    // Belt and braces: MIN_HOURLY_VOLUME should already have excluded anything untraded here, but the
    // same reading is cheap and this tier must never be the one that offers a dead spread.
    if (implausibleSpread(net, p.low, volumeReadingFor(volumes, item.id))) continue;
    // ...and the same for the buy price itself. A print that disagrees with its own hour is not a
    // price, and quoting it makes every figure built on it wrong (see implausibleBuyPrint).
    if (implausibleBuyPrint(p.low, volumes?.[String(item.id)])) continue;
    // The item's own GE buy limit when known (see DEFAULT_MARKET_QUANTITY_CAP above), else the cap.
    const limitKnown = Number.isFinite(item.limit) && item.limit > 0;
    // One limit per four-hour window the player's duration spans (see limitAllowance); the account's
    // own recorded purchases are applied afterwards by gateCandidate, and the volume cap still binds.
    let quantity = Math.max(1, limitKnown ? limitAllowance({limit: item.limit, targetDurationMinutes}) : DEFAULT_MARKET_QUANTITY_CAP);
    const fullSize = quantity;
    let cashLimited = false;
    if (maxSpend !== undefined) {
      const affordable = Math.floor(maxSpend / p.low);
      if (affordable < 1) continue; // can't afford even one unit at the current cash stack
      if (affordable < quantity) { quantity = affordable; cashLimited = true; }
    }
    let durationLimited = false;
    if (targetDurationMinutes !== undefined) {
      // liquidity is already known to be > 0 here (the MIN_HOURLY_VOLUME gate above guarantees it).
      // Same corrected estimate, same tolerance on dropping and none on sizing, as computeSuggestion.
      if (correctedFillMinutes(estimatedFillMinutes(1, liquidity, VOLUME_WINDOW_MINUTES)) > targetDurationMinutes * DURATION_TOLERANCE) continue;
      const fillable = Math.max(1, Math.floor(liquidity / VOLUME_WINDOW_MINUTES * targetDurationMinutes / PASSIVE_FILL_FACTOR));
      if (fillable < quantity) { quantity = fillable; durationLimited = true; }
    }
    // Optional cap on how much of an hour's trading this one order may represent. Off unless the
    // caller sets it (so nothing changes for anyone who doesn't), and used by tools/backtest.mjs to
    // test whether over-sizing relative to liquidity is what turns market-wide picks into losses.
    // Optional cap on how much of the cash stack one suggestion may commit. Also off by default.
    // Backtesting found this is what turns market-wide picks into large losses: with 50m available,
    // every catastrophic trade was a single expensive item bought with nearly the whole stack and
    // still unsold a day later.
    let stackLimited = false;
    if (Number.isFinite(options.maxStackShare) && options.maxStackShare > 0 && maxSpend !== undefined) {
      const affordableByStack = Math.floor(maxSpend * options.maxStackShare / p.low);
      if (affordableByStack < 1) continue; // one unit already commits more of the stack than allowed
      if (affordableByStack < quantity) { quantity = affordableByStack; stackLimited = true; }
    }
    let shareLimited = false;
    // options.volumeWindowShare replaces the per-HOUR cap with a share of the volume that will trade
    // in the player's whole WINDOW. The two are in different units, and the mismatch is what shuts a
    // large stack out of exactly the items it can use. An Abyssal dagger trades about 6 an hour and
    // is worth 1.27m, so a 29-hour trade will see about 174 of them change hands; capping the order
    // at "one hour's volume" allows 6, or 0.8m of capital, on an item whose market would absorb 20
    // times that. Measured 28 Sept 2026 against Flipping Copilot's own picks, which take 20-33% of
    // window volume on such items. Off unless the caller sets it, so nothing changes by default.
    if (Number.isFinite(options.volumeWindowShare) && options.volumeWindowShare > 0) {
      const windowHours = targetDurationMinutes !== undefined ? targetDurationMinutes / 60 : 1;
      const affordableByWindow = Math.max(1, Math.floor(sizingLiquidity * windowHours * options.volumeWindowShare));
      if (affordableByWindow < quantity) { quantity = affordableByWindow; shareLimited = true; }
    } else if (volumeShare > 0) {
      const affordableByVolume = Math.max(1, Math.floor(sizingLiquidity * volumeShare));
      if (affordableByVolume < quantity) { quantity = affordableByVolume; shareLimited = true; }
    }
    const gated = gateCandidate(item.id, quantity, options);
    if (!gated) continue;
    const limitLimited = gated.limited;
    quantity = gated.quantity;
    // The floor is judged on the more cautious of the two, for the same reason the sidebar's headline
    // is (see headlineProfit in server.mjs): a trade is never offered on the strength of a number EVI
    // has a steadier reading contradicting. What the reasoning quotes stays the live figure, which is
    // what the player would actually collect at the prices they are being told to use.
    const predictedProfit = net * quantity;
    if (Math.min(predictedProfit, netRank * quantity) < minProfit) continue;
    // Rewards both margin and real liquidity, log-damped so one exceptionally deep item can't
    // dominate purely on volume with a thin margin. Once a cash stack or a target duration is
    // known, ranking targets the best *total* profit actually reachable within that constraint
    // rather than the best per-unit margin -- otherwise a wildly unaffordable (or unrealistically
    // slow) item would still win the ranking capped down to a quantity of 1, instead of a cheaper
    // or faster-moving item that can be bought and sold for real within the same constraint.
    // Scored on the robust margin, which is the whole point of the change: WHICH item wins is decided
    // by what the item has steadily been worth, not by whichever one happened to print a freak trade
    // in the last few minutes. Identical to the old line when there is no archived reading, since
    // netRank then falls back to net.
    const rankProfit = netRank * quantity;
    const constrained = maxSpend !== undefined || targetDurationMinutes !== undefined;
    let score = (constrained ? rankProfit : netRank) * Math.log(liquidity + 1);
    // 'profit-per-hour' ranks by how much the trade is expected to make per hour of waiting, using
    // the calibrated fill estimate for both sides. It deliberately prefers a small, quick, liquid
    // flip over a large slow one worth more on paper -- which is what someone with little gp needs,
    // since their capital being stuck IS the cost. Opt-in via options.rankBy; the default above is
    // unchanged.
    if (options.rankBy === 'profit-per-hour') {
      const hours = Math.max(correctedFillMinutes(estimatedFillMinutes(quantity, liquidity, VOLUME_WINDOW_MINUTES)) * 2, FILL_FLOOR_MINUTES) / 60;
      score = rankProfit / hours;
    }
    // 'profit' drops the liquidity multiplier entirely. The multiplier is what makes a large stack
    // useless: `log(liquidity + 1)` spans about 12 across the catalogue while the profits it scales
    // span thousands, so a deep cheap item beats a shallow expensive one even when the expensive one
    // makes several times as much. At 89m on 28 Sept 2026 that produced a 599,845 gp Water rune trade
    // ahead of an 81,818,646 gp Old school bond trade worth more than twice as much -- and the median
    // surviving candidate committed 15,333 gp of the 89m. Opt-in, and measured before it is used:
    // ranking on absolute profit alone has been the single most damaging thing measured on this
    // project before (see the EVI Score V1 work in README.md), so it is never the default and never
    // goes anywhere near a player without tools/market-tier-ranking.mjs behind it.
    if (options.rankBy === 'profit') score = rankProfit;
    // 'soft-liquidity' keeps a liquidity preference but stops it deciding the ranking on its own.
    // `log(liquidity + 1)` spans about 1.4 for an item trading 3 an hour against 9.5 for one trading
    // 12,000, so a thin item carries a near-sevenfold handicap however much more the trade is worth.
    // Measured 28 Sept 2026, that is why the robust ranking picked a thin item only 3 times in 193 --
    // and every one of Flipping Copilot's genuinely good picks that day was a thin, expensive item
    // (Abyssal dagger at 6 an hour, Light ballista at 3, Seers icon at 0), while every one of its
    // losers was a liquid thin-margin item EVI already refuses on tax. The square root halves that
    // handicap in log terms without discarding the preference the way 'profit' does.
    if (options.rankBy === 'soft-liquidity') score = (constrained ? rankProfit : netRank) * Math.sqrt(Math.log(liquidity + 1));
    if (score <= 0) continue;
    candidates.push({item, p, net, quantity, predictedProfit, score, cashLimited, durationLimited, limitKnown, fullSize, limitLimited, shareLimited, stackLimited});
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score);
  const {item, p, quantity, predictedProfit, cashLimited, durationLimited, limitKnown, fullSize, limitLimited, shareLimited, stackLimited} = candidates[0];
  const notes = [];
  notes.push(limitKnown
    ? `sized to this item's own GE buy limit of ${fullSize.toLocaleString('en-US')} per 4 hours`
    : `capped at ${fullSize.toLocaleString('en-US')} because this item's GE buy limit is unknown`);
  if (cashLimited) notes.push('capped to what your current cash stack can afford');
  if (durationLimited) notes.push(`capped to fit an estimated ~${targetDurationMinutes}-minute trade`);
  if (limitLimited) notes.push('capped to what EVI has seen left of this item\'s GE buy limit, which is all that can fill before the limit resets in 4 hours -- a bigger offer would sit part-filled until then');
  if (stackLimited) notes.push(`capped so this one trade commits at most `+Math.round(options.maxStackShare*100)+`% of your cash stack`);
  if (shareLimited) notes.push(`capped to ${Math.round(maxVolumeShare * 100)}% of what this item trades in a typical hour, so the order isn't larger than the market absorbs`+(maxVolumeShare > DEFAULT_MAX_VOLUME_SHARE ? ` over your ${targetDurationMinutes >= 120 ? Math.round(targetDurationMinutes / 60) + '-hour' : targetDurationMinutes + '-minute'} trade window` : ''));
  return {
    itemId: item.id,
    name: item.name,
    action: 'buy',
    quantity,
    buyPrice: p.low,
    sellPrice: p.high,
    source: 'market',
    reasoning: `Market-wide pick -- you have no flip history for this item yet. Current margin after tax is ~${Math.round(predictedProfit).toLocaleString('en-US')} gp at quantity ${quantity}${notes.length ? ' (' + notes.join('; ') + ')' : ''} (buy near ${p.low.toLocaleString('en-US')} gp, sell near ${p.high.toLocaleString('en-US')} gp). Verify liquidity and news yourself before committing capital; this ranking has no track record behind it.`,
  };
}

// A richer alternative to computeMarketSuggestion above, used by GET /api/suggestion in server.mjs
// when includeMarketSuggestions is on AND the browser scanner has pushed a recent shortlist (see
// POST /api/scanner-suggestions, MAX_PUSHED_AGE_MS in server.mjs) -- otherwise this tier falls back
// to computeMarketSuggestion exactly as before this existed, so a plugin user who never opens the
// scanner sees no change at all. candidates: whatever the scanner last pushed, already ranked
// best-first by its own EVI Score (personal history, liquidity, stability, and -- when the scanner's
// own Predict button has been used -- price-direction prediction too), each shaped like
// {itemId, name, buy, sell, net, qty, score, mode}. Never trusts that ranking blindly: re-sorts by
// score here, and still applies the same blocklist/affordability/minProfit gates computeSuggestion
// and computeMarketSuggestion both apply, so a scanner-pushed pick can never bypass them. Returns the
// best surviving candidate (or null, exactly like the other compute* functions here), letting the
// caller's own pickWithForecast retry loop move to the next one on an unfavourable forecast.
export function computePushedSuggestion(candidates, options = {}) {
  if (!Array.isArray(candidates)) return null;
  const blocklist = options.blocklist instanceof Set ? options.blocklist : new Set();
  // >= 0, not > 0: an EMPTY coin pouch is a real answer, not a missing one. The plugin sends no
  // cash parameter at all when it has not read the inventory yet (cashStack -1), so absent already
  // means unknown -- and treating a genuine 0 as unknown removed the cap entirely. Found by novi on
  // 29 Sept 2026 after banking their coins: EVI offered four 3rd age robe tops at 131,812,123 each,
  // over half a billion gp, to a player carrying nothing. At cash=1000 it correctly sized down to a
  // 200 gp trade, which is what made the falsy-zero obvious.
  const maxSpend = Number.isFinite(options.maxSpend) && options.maxSpend >= 0 ? options.maxSpend : undefined;
  const minProfit = Number.isFinite(options.minProfit) && options.minProfit > 0 ? options.minProfit : 0;
  // Ranked by the BRIDGE's own measure, with the scanner's score only as a tie-break.
  //
  // Until 28 Sept 2026 this sorted on `c.score` alone -- the scanner's EVI Score V2, computed in the
  // browser. That made the least-evidenced ranking in the system the one that decided what a player
  // saw, because the pushed tier takes precedence over the market tier whenever the scanner is open.
  // Measured live at an 85m stack: the pushed tier offered Teak logs worth 12,816 gp while the market
  // tier, on the same prices and the same cash, offered about ten times that. The scanner's score is
  // still the tie-break, so where the bridge genuinely cannot separate two candidates the browser's
  // richer view (price history, the player's own record, news) still orders them.
  //
  // Same shape as computeMarketSuggestion's score, for the same reason: margin scaled by real
  // liquidity, log-damped so one deep item cannot win on volume alone, and on the robust price where
  // one exists so a freak print cannot carry a candidate. It honours options.rankBy identically, so
  // "Bigger positions" reaches this tier as well -- before this it could not, which is why turning the
  // setting on changed nothing at all for a player with the scanner open.
  const scoreOf = c => {
    const r = options.rankPrices?.[String(c.itemId)];
    const net = r && r.high > 0 && r.low > 0
      ? Math.min(c.net, r.high - r.low - estimateUnitTax(c.itemId, r.high))
      : c.net;
    if (!(net > 0)) return 0;
    const liquidity = volumeReadingFor(options.volumes, c.itemId) ?? 0;
    const qty = Math.max(1, Math.round(Number.isFinite(c.qty) && c.qty > 0 ? c.qty : 1));
    if (options.rankBy === 'profit') return net * qty;
    if (options.rankBy === 'soft-liquidity') return net * qty * Math.sqrt(Math.log(liquidity + 1));
    return net * qty * Math.log(liquidity + 1);
  };
  const ranked = candidates
    .filter(c => c && Number.isFinite(c.itemId) && c.itemId > 0 && !blocklist.has(c.itemId)
      && Number.isFinite(c.buy) && c.buy > 0 && Number.isFinite(c.sell) && c.sell > 0 && Number.isFinite(c.net) && c.net > 0)
    .sort((a, b) => (scoreOf(b) - scoreOf(a)) || ((b.score || 0) - (a.score || 0)));
  for (const c of ranked) {
    // A buy price that disagrees with its own hour is a print, not a price. The scanner computes its
    // rows from the same `latest` feed, so it inherits the same bad number and cannot see past it.
    if (implausibleBuyPrint(c.buy, options.volumes?.[String(c.itemId)])) continue;
    // The scanner ranks on far more than current margin, but it cannot rank away the tax: an edge
    // thinner than this item's own tax is dropped here too (see marginClearsTax).
    if (options.requireMarginOverTax !== false
        && !marginClearsTax(c.net, estimateUnitTax(c.itemId, c.sell),
             options.marginTaxMultiple ?? MARGIN_TAX_NO_HISTORY_MULTIPLE)) continue;
    // Sized by EVI, not by the browser, wherever EVI knows the item's buy limit.
    //
    // The scanner sends a quantity it worked out from the bankroll typed into the page and its own
    // liquidity rule, and until 28 Sept 2026 that number was the ceiling here -- every cap below could
    // only shrink it. So the tier that answers most often for anyone with the scanner open was sized
    // by a different program against a different cash figure, and neither the player's trade pace nor
    // "Bigger positions" could move it. `limitOf` lets the bridge start from the item's own GE buy
    // limit across the windows the trade spans, exactly as the market tier does; the cash stack, the
    // volume cap and the limit already used all still bind below. Without a limit reading it falls
    // back to the scanner's own figure, so nothing changes for a caller that cannot supply one.
    const pushedLimit = options.limitOf?.(c.itemId);
    const scannerQty = Math.max(1, Math.round(Number.isFinite(c.qty) && c.qty > 0 ? c.qty : 1));
    let quantity = Number.isFinite(pushedLimit) && pushedLimit > 0
      ? Math.max(1, limitAllowance({limit: pushedLimit, targetDurationMinutes: options.targetDurationMinutes}))
      : scannerQty;
    // The same cap on how much of an item's hourly trading one order may be that the other two tiers
    // apply (see volumeShareForDuration). A scanner-pushed pick carries the scanner's own quantity,
    // sized from bankroll and the item's buy limit but not from what the item actually trades -- so
    // until this was added, the tier that runs most often for anyone with the scanner open was the
    // one tier with no guard against ordering more than the market absorbs, which is the failure
    // mode behind every large loss the 90-day backtest found. A measured zero constrains to a single
    // unit; genuinely absent volume data constrains nothing, exactly as in the other tiers.
    let shareLimited = false;
    const pushedLiquidity = sizingLiquidityFor(options, c.itemId);
    if (pushedLiquidity !== null) {
      const withinVolume = orderSizeCap(pushedLiquidity, options.targetDurationMinutes, options);
      if (withinVolume !== null && withinVolume < quantity) { quantity = withinVolume; shareLimited = true; }
    }
    // Same world/buy-limit gates every other tier applies, so a scanner-pushed pick can't bypass them.
    const gated = gateCandidate(c.itemId, quantity, options);
    if (!gated) continue;
    const limitLimited = gated.limited;
    quantity = gated.quantity;
    let cashLimited = false;
    if (maxSpend !== undefined) {
      const affordable = Math.floor(maxSpend / c.buy);
      if (affordable < 1) continue; // can't afford even one unit at the current cash stack
      if (affordable < quantity) { quantity = affordable; cashLimited = true; }
    }
    const predictedProfit = c.net * quantity;
    if (predictedProfit < minProfit) continue;
    const name = typeof c.name === 'string' && c.name ? c.name : `item ${c.itemId}`;
    const notes = [];
    if (cashLimited) notes.push('reduced to what your current cash stack can afford');
    if (limitLimited) notes.push('reduced to what EVI has seen left of this item\'s GE buy limit, which is all that can fill before the limit resets in 4 hours -- a bigger offer would sit part-filled until then');
    // Worded from whichever rule actually bound, since the two are in different units and quoting the
    // wrong one would misdescribe the order (see orderSizeCap).
    if (shareLimited) notes.push(Number.isFinite(options.volumeWindowShare) && options.volumeWindowShare > 0
      ? `reduced to ${Math.round(options.volumeWindowShare * 100)}% of what this item trades over your whole trade window`
      : `reduced to ${Math.round((Number.isFinite(options.maxVolumeShare) ? options.maxVolumeShare : volumeShareForDuration(options.targetDurationMinutes)) * 100)}% of what this item trades in a typical hour`);
    return {
      itemId: c.itemId,
      name,
      action: 'buy',
      quantity,
      buyPrice: c.buy,
      sellPrice: c.sell,
      source: 'scanner',
      reasoning: `Scanner pick (EVI score ${Math.round(c.score || 0)}${c.mode ? `, ${c.mode} pace` : ''}) -- ranked in your browser's scanner using price history, liquidity and your own trade record, not just current margin. Current margin after tax is ~${Math.round(predictedProfit).toLocaleString('en-US')} gp at quantity ${quantity}${notes.length ? ' (' + notes.join('; ') + ')' : ''} (buy near ${c.buy.toLocaleString('en-US')} gp, sell near ${c.sell.toLocaleString('en-US')} gp). Verify liquidity and news yourself before committing capital.`,
    };
  }
  return null;
}

// ---- Price-direction forecast, deliberately kept in lockstep with the scanner's own Predict-button
// model (forecastFromSeries and its helpers in scanner/EVI_Flip_Scanner_V3.html) -- same math, same
// thresholds, so a bridge-side forecast for an item/horizon and a scanner-side one for the same
// item/horizon agree. If one changes, change the other to match. See GET /api/suggestion in
// server.mjs for how this is actually wired into a "buy" suggestion (EviLiveConfig.forecastHorizon /
// ForecastPolicy on the plugin side -- ?forecast=/&onForecast= on the query string).
const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
function midpointPoint(x) {
  const hi = Number(x.avgHighPrice), lo = Number(x.avgLowPrice);
  if (Number.isFinite(hi) && hi > 0 && Number.isFinite(lo) && lo > 0) return (hi + lo) / 2;
  if (Number.isFinite(hi) && hi > 0) return hi;
  if (Number.isFinite(lo) && lo > 0) return lo;
  return null;
}
function linSlope(vals) {
  const a = vals.filter(Number.isFinite);
  if (a.length < 3) return 0;
  const n = a.length, mx = (n - 1) / 2, my = a.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - mx) * (a[i] - my); den += (i - mx) * (i - mx); }
  return den ? num / den : 0;
}
function ret(a, b) { return (Number.isFinite(a) && a > 0 && Number.isFinite(b)) ? (b / a - 1) : 0; }
function volOf(vals) {
  const rs = [];
  for (let i = 1; i < vals.length; i++) if (vals[i - 1] > 0 && vals[i] > 0) rs.push(Math.log(vals[i] / vals[i - 1]));
  if (rs.length < 2) return 0;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  return Math.sqrt(rs.reduce((a, b) => a + (b - m) * (b - m), 0) / (rs.length - 1));
}

// series: the Wiki /timeseries response's "data" array (already fetched by the caller). horizon:
// '1h'|'6h'|'overnight', matching ForecastHorizon.param() on the plugin side and the scanner's own
// three buckets exactly. Returns {label, dir (-1/-0.5.../0/0.5/1), confidence (0-100), move, ...} --
// never throws; fewer than 8 usable data points yields a deliberately low-confidence "Uncertain"
// rather than a fabricated direction.
export function forecastFromSeries(series, horizon) {
  const clean = (series || []).filter(x => midpointPoint(x) !== null).sort((a, b) => a.timestamp - b.timestamp);
  if (clean.length < 8) return {label: 'Uncertain', dir: 0, confidence: 20, move: 0};
  const mids = clean.map(midpointPoint), last = mids[mids.length - 1];
  const n = horizon === '1h' ? 12 : horizon === '6h' ? 18 : 28;
  const recent = mids.slice(-n), prev = mids.slice(-Math.min(mids.length, n * 2), -n);
  const slope = linSlope(recent) / (last || 1);
  const momentum = ret(recent[0], recent[recent.length - 1]);
  const longer = prev.length >= 3 ? ret(prev[0], prev[prev.length - 1]) : momentum;
  const volatility = volOf(recent);
  const buyVol = clean.slice(-n).reduce((s, x) => s + (x.highPriceVolume || 0), 0);
  const sellVol = clean.slice(-n).reduce((s, x) => s + (x.lowPriceVolume || 0), 0);
  const imbalance = (buyVol - sellVol) / Math.max(1, buyVol + sellVol);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const deviation = (last - mean) / Math.max(1, mean);

  let signal = 0.45 * momentum + 4.0 * slope + 0.012 * imbalance + 0.12 * longer;
  // Small mean-reversion term only after a meaningful deviation.
  if (Math.abs(deviation) > .025) signal += -0.08 * deviation;

  const noise = Math.max(.002, volatility * Math.sqrt(Math.max(1, recent.length / 4)));
  const strength = Math.abs(signal) / noise;
  let confidence = Math.round(clamp(42 + strength * 22, 42, 88));
  if (clean.length < 20) confidence = Math.min(confidence, 60);

  const threshold = Math.max(.0025, noise * .35);
  let label = 'Stable', dir = 0;
  if (signal > threshold) { label = 'Likely rising'; dir = 1; }
  else if (signal < -threshold) { label = 'Likely falling'; dir = -1; }
  else if (momentum < -.02 && deviation < -.015 && signal >= -threshold) { label = 'Possible rebound'; dir = 0.5; }
  // noise/threshold are returned so a caller can judge an outcome by the same rule this function
  // predicts by: it calls "rising" when the signal clears `threshold`, so a realised move is only
  // counted as a rise when it clears the same bar. Without that, calibration would be scoring the
  // model against a different definition of "moved" than the one it uses, and the accuracy number
  // would mean nothing. Per item and per moment by construction, never a flat percentage.
  return {label, dir, confidence, move: signal, volatility, deviation, imbalance, noise, threshold};
}

// Which Wiki /timeseries timestep to fetch for a given forecast horizon -- mirrors the scanner's own
// pairing exactly (its Predict button forecasts '1h' from a 5-minute series, '6h' from an hourly
// series, and 'overnight' from a 6-hourly series; forecastFromSeries's n above assumes that pairing,
// not the horizon's own literal length). Returns null for an unrecognised horizon.
export function timestepForHorizon(horizon) {
  return {'1h': '5m', '6h': '1h', overnight: '6h'}[horizon] || null;
}

// ---- Volatility-relative margin safety cushion (EviLiveConfig.marginSafetyCushion, on by
// default). Reuses the exact same Wiki /timeseries fetch and price-history plumbing as the
// forecast feature above, but answers a different question: not "which way is this item's price
// heading" but "how thin is this predicted margin compared to how much this SPECIFIC item's price
// normally wobbles on its own." A flat percentage floor would either block legitimate thin-margin,
// high-volume flips (bad for a low-capital account) or let a volatile item's margin get swallowed
// by its own ordinary noise (the real risk this was built to catch) -- comparing against the
// item's own recent behaviour avoids both.

// series: the Wiki /timeseries response's "data" array (same shape forecastFromSeries takes,
// already fetched by the caller). n: how many of the most recent points to look at -- defaults to
// 24 (e.g. roughly 2 hours of 5-minute candles) as a general "how much does this item normally
// move over a short window" estimate, independent of any particular forecast horizon. Returns null
// when there isn't enough price history to say anything (fewer than 8 usable points) or the item
// shows no measurable movement in that window at all -- callers must treat null as "no signal",
// never as "zero volatility": an unknown wobble must never silently block a suggestion, which would
// be exactly the kind of guess the accuracy directive this feature exists to satisfy rules out.
export function estimateVolatility(series, n = 24) {
  const clean = (series || []).filter(x => midpointPoint(x) !== null).sort((a, b) => a.timestamp - b.timestamp);
  if (clean.length < 8) return null;
  const mids = clean.map(midpointPoint).slice(-n);
  const stepVol = volOf(mids);
  if (!(stepVol > 0)) return null;
  // Scales the per-candle noise up to roughly "how far this item's price randomly wanders over the
  // whole window looked at" -- the standard random-walk sqrt(steps) approximation, the same scaling
  // forecastFromSeries's own noise term already uses.
  const windowVol = stepVol * Math.sqrt(Math.max(1, mids.length - 1));
  return {stepVol, windowVol, points: mids.length};
}

// How many "typical price wobble" widths (see estimateVolatility above) a predicted per-unit margin
// must clear before a candidate is trusted. 1 keeps only candidates whose margin is at least as
// large as this item's own recent swings would often produce on their own -- so ordinary noise
// alone is unlikely to erase a predicted profit, or flip it into a loss, before the trade even
// completes. This can never prove a trade WILL be profitable, only that its margin isn't already
// sitting inside the item's own noise floor.
export const MARGIN_CUSHION_MULTIPLIER = 1;

// How much of an item's own Grand Exchange tax its after-tax margin must cover before EVI will offer
// the trade. Added 27 Sept 2026 after a first user was suggested 25,000 blood runes -- the full buy
// limit, 8.35m of capital -- on a spread that cleared tax by about two gp a unit, and lost GP as soon
// as the price ticked. The 500 gp Auto floor could not catch it: it is a floor on the TOTAL predicted
// profit, so a 25,000-unit order satisfies it with 0.02 gp a unit, and quantity launders an edge
// smaller than one price step into a five-figure "predicted profit".
//
// Measured over 335 archived hours (tools/edge-vs-tax.mjs), selling at the median price available in
// the following 12 hours rather than the single best print:
//
//   band                 candidates   median return   lower quartile   loses GP
//   tax-free                 48,577          11.11%            2.78%         7%
//   net under 0.5x tax       68,010           0.42%           -0.30%        33%
//   0.5x to 1x tax           43,946           1.40%            0.32%        20%
//   1x to 2x tax             56,839           2.65%            1.07%        15%
//   2x to 5x tax             76,055           5.94%            2.91%        12%
//   5x or more              125,816          26.60%           11.61%        10%
//
// Monotone across every band, and it picks the line out by itself: below half the tax the LOWER
// QUARTILE is negative, meaning an ordinary bad draw loses GP, and a third of those trades do. At half
// to one times tax the quartile is positive again and the loss rate is 20%. So there are two bars
// rather than one:
//
//   * below 0.5x tax the candidate is not offered. That is where a normal bad case loses GP, and it
//     drops 16% of offerable candidates -- close to the 8% the 500 gp Auto floor cost, nowhere near
//     the 71% a flat percentage-of-stack would have. The blood runes sit at 0.33x.
//   * below 1x tax it is offered with a warning (see server.mjs). Requiring 1x outright was measured
//     and rejected as too strict: it would have dropped 27% of candidates, and among them real trades
//     of novi's own -- the Eclipse Moon chestplate flip sits at 0.83x and made 1.78m on 1.65m.
//
// Dropping the clear losers and warning on the merely thin is the standing warn-don't-block rule here.
//
// This is deliberately NOT a flat cutoff, which is a standing rule here. The bar is the item's own
// tax, so it scales with that item's own price, and a tax-free item (anything the GE charges no tax
// on, which is where a small stack's thin-margin high-volume flipping lives) is exempt by
// construction -- that band is also the safest one measured, at a 7% loss rate. MinProfitTier.NONE
// still switches it off entirely, the same escape hatch the Auto floor has.
// The bar for a tier that has the player's own track record on the item behind it. Half the tax is
// where the measured lower quartile turns positive, so an ordinary bad draw no longer loses GP.
// A margin can be too GOOD to be true, and that is a data-quality signal rather than an opportunity.
//
// On 28 September 2026 EVI offered to buy 1,301 Rune dart(p++) at **10 gp** to sell at 874 -- an 8,470%
// margin. The 10 gp was a single print from ten hours earlier, against a 24-hour average sell price of
// 357, with nothing traded at all in the intervening hour. Nobody would have sold at 10, so the offer
// would simply have sat there, holding a slot and displacing a real trade. None of the existing checks
// looked at it: every one of them tests whether a margin is too THIN.
//
// A ratio alone is the wrong test, because cheap items genuinely carry huge percentage margins and
// that band is deliberately protected -- a 1 gp item selling at 3 is a 200% margin and perfectly real.
// What separates the two is whether anyone is trading it. Measured across the 2,779 items showing a
// positive after-tax spread on 28 Sept: the median margin is 17% of the buy price, the 90th percentile
// 476%, and the extreme tail is entirely dead stock -- the top eight all traded 0 or 1 units in a day,
// led by an Adamant hasta(p) quoting buy 1 / sell 4,912 on no volume whatsoever.
//
// So the test is both together: an extreme margin AND nothing traded this hour. At 5x that drops 8.0%
// of items, whose median 24-hour volume is 2, while keeping 59 cheap liquid items carrying margins
// above 100%. The 8% matches what the 500 gp Auto floor cost when it was accepted on the same standard.
//
// Absence of a volume reading is treated as "did not trade", not as "unknown", and only here: the Wiki
// omits an item from its hourly endpoint entirely when nothing changed hands, which is exactly the
// signal wanted. Sizing still treats absence as unknown (see volumeReadingFor), because there the
// fail-open rule is the right one.
export const IMPLAUSIBLE_MARGIN_MULTIPLE = 5;

// Pure decision. net: the per-unit margin after tax. buyPrice: what EVI would bid. hourVolume: units
// traded this hour, or null when the item is absent from the hourly data. Returns true only for a
// margin that is both extreme and unsupported by any trading at all; anything it cannot judge -- a
// missing price, a non-positive margin, or an item that did trade -- is never rejected here.
export function implausibleSpread(net, buyPrice, hourVolume, multiple = IMPLAUSIBLE_MARGIN_MULTIPLE) {
  if (!Number.isFinite(net) || !Number.isFinite(buyPrice) || buyPrice <= 0 || net <= 0) return false;
  if (hourVolume > 0) return false;          // someone is trading it: the spread is real enough to test
  return net / buyPrice > multiple;
}

export const MARGIN_TAX_MULTIPLE = 0.5;

// The bar for a tier with NO track record -- the market-wide and scanner-pushed tiers, which is what
// every new player gets and where a first impression is made. The full tax, because the measurement
// above is drawn from exactly that population: every item, every hour, no history involved. It takes
// the loss rate from 20% to 15%, and on live prices it drops 16% of offerable candidates against the
// 0.5x bar's 10%. The looser bar is reserved for the personal tier because a real track record on the
// item is evidence the whole-catalogue measurement cannot see.
export const MARGIN_TAX_NO_HISTORY_MULTIPLE = 1;

// The looser bar, used for a warning rather than a drop (see server.mjs).
export const MARGIN_TAX_WARN_MULTIPLE = 1;

// Pure decision. net: the predicted per-unit margin after tax. tax: the per-unit tax already
// subtracted from it. Unknown or non-finite inputs never block a candidate, and neither does a
// tax-free item -- there is nothing for its margin to clear. Can never prove a trade will be
// profitable, only that its edge is not smaller than the tax it has to pay.
export function marginClearsTax(net, tax, multiple = MARGIN_TAX_MULTIPLE) {
  if (!Number.isFinite(net) || !Number.isFinite(tax)) return true;
  if (!(tax > 0)) return true;
  return net >= tax * multiple;
}

// Pure decision. marginPerUnit: predicted buy/sell margin per unit, after tax. price: the current
// sell price, used to turn volEstimate's fraction into a gp figure comparable to marginPerUnit.
// Returns {blocked, noiseGp}: noiseGp is null (and blocked is always false) whenever volEstimate,
// price or marginPerUnit isn't a usable positive number -- unknown or non-positive inputs never
// block a candidate, only a confirmed thin-relative-to-noise margin does.
export function marginClearsCushion(marginPerUnit, price, volEstimate, cushionMultiplier = MARGIN_CUSHION_MULTIPLIER) {
  if (!volEstimate || !(price > 0) || !(marginPerUnit > 0)) return {blocked: false, noiseGp: null};
  const noiseGp = price * volEstimate.windowVol;
  return {blocked: marginPerUnit < noiseGp * cushionMultiplier, noiseGp};
}

// OSRS allows 8 Grand Exchange offers at once and no more. Until this existed, EVI had no idea how
// many were in use and would keep suggesting trades with nowhere to put them -- advice that cannot
// be followed, which is its own kind of wrong answer.
export const GE_SLOTS = 8;

// Pure decision, from the two counts the plugin sends (see EviLivePlugin's freeSlots and
// collectableSlots). Both are raw query values, so anything that isn't a whole count -- absent,
// empty, negative, not a number -- becomes null, meaning "the plugin hasn't established a slot
// snapshot yet". Unknown never invents a constraint, the same fail-open rule the cash and
// members-world signals follow.
//
//   full  -- every slot is occupied and none of them holds a finished offer. Nothing can be placed
//            at all, so the caller should stop ranking rather than suggest something unplaceable.
//   tight -- every slot is occupied, but at least one holds a finished offer (or the finished count
//            is unknown). Collecting is one click, so ranking continues and the suggestion just
//            carries a note about it. Deliberately NOT treated as "no room": suppressing a real
//            signal over a click would hide a trade the player could perfectly well make.
export function slotCapacity(freeRaw, collectableRaw) {
  const count = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= GE_SLOTS ? n : null;
  };
  const free = count(freeRaw), collectable = count(collectableRaw);
  const full = free === 0 && collectable === 0;
  return {free, collectable, full, tight: free === 0 && !full};
}

// Two different questions about what the player already has on, which an earlier version tangled
// together -- and the tangle capped the player at FOUR slots out of eight.
//
//   exposure      -- every item they are committed to, held or still being bought. This is what a
//                    new candidate must not duplicate (see correlation.mjs): an in-progress buy is
//                    as much a position as stock in the bank.
//   sellSlotsOwed -- how many sells need a slot they do not already have. This is the part that
//                    was wrong. The original reasoning was "every buy needs a second slot later, to
//                    sell what it bought", which counted each in-progress buy as an owed exit. But a
//                    buy vacates its own slot when collected, and the sell goes straight into it: a
//                    flip uses ONE slot at a time, buy phase then sell phase. Four buys therefore
//                    reserved four more slots for exits they would never need, and suggestions
//                    stopped at four -- reported by the user from the live client.
//
// So an exit is owed only for stock with nowhere to go: held unsold (an open position) and not
// currently sitting in any slot at all -- bought, collected and left in the inventory. Anything in a
// slot, finished or not, brings its own slot with it.
export function slotExposure(openPositions, occupiedOffers, account) {
  const mine = x => !account || x.account === account;
  const held = (openPositions || []).filter(mine).map(p => p.itemId);
  const occupied = (occupiedOffers || []).filter(mine);
  const inASlot = new Set(occupied.map(o => o.itemId));
  const buying = occupied.filter(o => ['BUYING', 'BOUGHT'].includes(o.state)).map(o => o.itemId);
  const owed = [...new Set(held)].filter(id => !inASlot.has(id));
  return {exposure: new Set([...held, ...buying]), owedItems: owed, sellSlotsOwed: owed.length};
}

// One sentence to append to a suggestion's reasoning when the GE is tight (see slotCapacity).
// Returns null when there is nothing to say, so the caller appends nothing.
export function slotNote(capacity) {
  if (!capacity || !capacity.tight) return null;
  const n = capacity.collectable;
  return n > 0
    ? `All ${GE_SLOTS} GE slots are in use, but ${n} finished offer${n === 1 ? '' : 's'} can be collected to free one.`
    : `All ${GE_SLOTS} GE slots are in use -- you will need to collect or cancel an offer before placing this.`;
}

// A forecast this confident and this negative is treated as "meaningfully unfavorable" by
// ForecastPolicy.SKIP in server.mjs -- deliberately above forecastFromSeries' own default-ish
// confidence band (most real forecasts land in the low-to-mid 40s-60s) so only a comparatively
// strong "likely falling" reading ever drops a candidate, not routine noise.
export const UNFAVORABLE_FORECAST_CONFIDENCE = 55;

// Human-readable horizon text folded into a forecast-carrying suggestion's reasoning.
export const FORECAST_HORIZON_LABEL = {'1h': '~1 hour', '6h': '~6 hours', overnight: 'overnight'};

// Whether an unfavourable forecast is allowed to DROP a candidate. Currently false, and that is a
// measurement, not an opinion: replaying this same forecaster over 90 days of archived prices
// (bridge/forecastCalibration.mjs, 42,659 non-overlapping predictions across 120 items) found its
// directional calls inverted -- "likely falling" was followed by a rise 41.1% of the time against a
// fall 18.4%, and the candidates this policy drops went on to move +4.261% over the next six hours
// while the ones it kept moved +0.553%. Switched on, it systematically discarded the best
// candidates it saw. Verified with a shuffled control that landed exactly on the base rate, with
// bid-ask bounce ruled out, and holding across both halves of the period, three disjoint item sets
// and a second horizon.
//
// So the signal does not get to remove a trade from consideration until it has earned it. The
// forecast is still SHOWN -- never silently suppressed, and the player still decides -- which is the
// same fail-open rule every other check here follows. Flip this back to true only when a calibration
// run says the forecast predicts direction better than the base rate, and never on a single
// backtest: a predictor that measures as backwards is not a predictor to trust inverted either.
export const FORECAST_MAY_DROP_CANDIDATES = false;

// Pure decision: given a forecast (or null/undefined -- no data) and a policy ('warn'|'skip'),
// should the caller keep this candidate or retry with the next-best one? Split out from
// pickWithForecast below purely so the threshold logic itself has a direct, trivial unit test.
export function decideForecast(forecast, policy) {
  if (!forecast) return 'keep';
  if (!FORECAST_MAY_DROP_CANDIDATES) return 'keep';
  if (policy === 'skip' && forecast.dir === -1 && forecast.confidence >= UNFAVORABLE_FORECAST_CONFIDENCE) return 'retry';
  return 'keep';
}

// What to say when the player asked for skipping and it is deliberately not happening. Silence
// would be a setting that quietly does nothing; this states the reason in the wording they see.
export function forecastPolicyNote(policy) {
  return policy === 'skip' && !FORECAST_MAY_DROP_CANDIDATES
    ? 'Note: "skip on an unfavourable forecast" is currently inactive. Measured against 90 days of price history, this forecast\'s direction calls were wrong more often than chance, and skipping on them threw away better trades than it avoided -- so the forecast is shown but no longer removes a candidate.'
    : null;
}

// Generic forecast-aware retry driver shared by the personal-history and market-wide "buy" tiers in
// server.mjs's GET /api/suggestion. Kept here (not inline in the HTTP handler) so the actual
// decision logic -- when to keep vs. retry, how a forecast gets folded into reasoning -- has direct
// test coverage with synthetic rank/forecastFor functions, no live HTTP server or real Wiki API call
// needed. rank(blocklist) is called fresh each attempt against the same (mutated) blocklist Set, so
// an excluded item compounds across attempts exactly like every other blocklist use in this file.
// forecastFor(itemId) is only ever awaited for a candidate whose action is 'buy' and only when
// horizon is set -- a 'sell' suggestion (a holding/inventory reminder) or a disabled forecast
// (horizon falsy, i.e. EviLiveConfig.forecastHorizon() is OFF) skips straight to the cushion check
// below, no extra call at all. cushionFor(candidate) (added alongside forecastFor, same "only for a
// 'buy' candidate" gating) is the margin-safety-cushion counterpart -- see marginClearsCushion above
// and EviLiveConfig.marginSafetyCushion() -- only awaited when requireCushion is truthy, and only
// ever expected to return {blocked, note} (note optional); a blocked candidate is retried exactly
// like an unfavourable SKIP-policy forecast, and a kept one has `note` (when present) folded into
// its reasoning the same way a forecast is. Both checks share the same blocklist and attempt
// budget, so a candidate that fails either one compounds into the next attempt's ranking exactly
// once, never twice. Returns null (never throws) when rank runs out of candidates (every attempt
// either found nothing, or every attempt so far failed forecast/cushion) -- the caller falls
// through to its own next fallback tier exactly as when nothing was eligible before either of these
// existed.
export async function pickWithForecast({rank, forecastFor, policy, horizon, cushionFor, requireCushion,
  correlationFor, supportFor, blocklist, maxAttempts = 3, onBlocked, onDemoted}) {
  // What was held back and why, so the caller can say so rather than silently returning nothing --
  // "nothing passes your settings" would be wrong when a real candidate was set aside deliberately.
  const blocked = [];
  // Picks whose margin disappears at what buyers actually paid (see sellPriceSupport), in rank order.
  // DEMOTED rather than blocked: each is set aside so the next candidate gets a chance, and the best of
  // them comes back only if nothing better passes -- carrying its warning. Warn-don't-block, applied to
  // ranking: a stale pick loses its place in line, never its visibility.
  const demoted = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = rank(blocklist);
    if (!candidate) break;
    if (candidate.action !== 'buy') return candidate;
    if (forecastFor && horizon) {
      const forecast = await forecastFor(candidate.itemId);
      if (forecast) {
        candidate.forecast = forecast;
        // The direction label is deliberately NOT shown. Calibration over 90 days found it wrong
        // more often than chance -- "Likely rising" was followed by a fall 43.6% of the time -- so
        // printing it next to a buy suggestion would hand the player a prediction measured to be
        // misleading, hedged wording or not. What the same signal does predict, and cleanly, is
        // which side of the flip completes (see fillOutlook.mjs), so that is what it now says.
        const outlook = fillOutlook(forecast, undefined, horizon);
        candidate.fillOutlook = outlook;
        const sentence = fillOutlookSentence(outlook);
        if (sentence) candidate.reasoning += ` ${sentence}`;
        const note = forecastPolicyNote(policy);
        if (note) candidate.reasoning += ` ${note}`;
        if (decideForecast(forecast, policy) === 'retry') { blocklist.add(candidate.itemId); continue; }
      }
    }
    if (cushionFor && requireCushion) {
      const cushion = await cushionFor(candidate);
      if (cushion) {
        if (cushion.blocked) { blocklist.add(candidate.itemId); continue; }
        if (cushion.note) candidate.reasoning += ` ${cushion.note}`;
      }
    }
    // Same retry path as the cushion, for the same reason: several slots in items that move
    // together is one position wearing several hats. Measured per pair from the price archive (see
    // correlation.mjs), never inferred from item names -- the measurement showed names get it
    // exactly wrong. A null result means the pair could not be compared and never blocks anything.
    if (correlationFor) {
      const correlated = await correlationFor(candidate);
      if (correlated && correlated.blocked) {
        blocked.push({itemId: candidate.itemId, reason: correlated.note});
        blocklist.add(candidate.itemId);
        continue;
      }
    }
    // Last, because it is the one check that costs a fetch. Reported live: EVI's top personal picks
    // included a Mummy's head whose sell price was 58.6 hours old and a Tzhaar-ket-em at 12.7 hours,
    // with nobody buying either in 12 hours. The warning alone flagged them but left them ranked first,
    // since an outlier sell price inflates exactly the margin the ranking rewards.
    if (supportFor) {
      const support = await supportFor(candidate);
      // Held back rather than demoted. A demoted pick is still shown when nothing better passes, which
      // is right for "this looks weak" but wrong for "this is worth less than its own tax at the price
      // buyers are really paying" -- that is how 172,266 blood runes reached the sidebar on 27 Sept at a
      // supported margin of 1 gp against a 6 gp tax. Quantity had turned it into a 172k total, which
      // clears any floor, and the demotion only labelled it.
      if (support && support.blocked) {
        candidate.reasoning = `${support.warning || ''} ${candidate.reasoning || ''}`.trim();
        candidate.sellSupport = support.detail;
        blocked.push(candidate);
        blocklist.add(candidate.itemId);
        continue;
      }
      // Carried whether or not anything is wrong with it, so a pick that PASSED can still show what
      // was checked (see verdict.mjs). Attaching it changes nothing on its own.
      if (support && support.detail) candidate.sellSupport = support.detail;
      if (support && support.warning) {
        candidate.reasoning = `${support.warning} ${candidate.reasoning || ''}`;
        candidate.sellSupport = support.detail;
        demoted.push(candidate);
        // Reported for the log even when a better pick replaces it, so demotions can be reviewed
        // later -- otherwise the check's calls would be invisible whenever it worked.
        if (onDemoted) onDemoted(candidate);
        blocklist.add(candidate.itemId);
        continue;
      }
    }
    return candidate;
  }
  // Nothing passed every check. If a pick was only demoted, the best of those is still worth showing
  // -- flagged, and saying why it is the one on screen.
  if (demoted.length) {
    const best = demoted[0];
    best.demoted = true;
    best.reasoning += ' No other candidate passed this check right now, which is why this one is shown.';
    return best;
  }
  // Ran out of attempts. If everything that was tried got held back for a stated reason, say so --
  // a candidate deliberately set aside is a different answer from nothing being eligible.
  if (blocked.length && onBlocked) onBlocked(blocked);
  return null;
}
