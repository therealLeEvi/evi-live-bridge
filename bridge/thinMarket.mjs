// "EVI quotes the price it last sold for -- how realistic is buying at that price again?"
//
// The player's question about a Berserker icon suggestion, and measuring it (tools/price-recurrence.mjs,
// 60 days of archive) showed the gap was real. That item traded in 43 of 1,439 hours -- 3%, about one a
// day -- and a seller matched its own price again within 4 hours in 7% of cases, within 12 hours in 21%,
// with a median of 0 units available. Across 400 items, grouped by how often they trade at all:
//
//   how often it trades        price matched within 4h    within 12h   median units within 12h
//   under 10% of hours                29%                    52%                1
//   10-40% of hours                   67%                    88%                7
//   40-80% of hours                   85%                    94%               24
//   most hours                        83%                    91%           10,900
//
// EVI's existing checks missed this entirely: the sell-support check looks at BUYERS in the last 12
// hours, and the fill-time estimate needs hourly volume, which for an item this thin is zero -- so it
// returned "no view" and said nothing, exactly where it should speak up.
//
// What this measures, per item, from the archive only:
//   * cadence -- in how many of the archived hours the item traded at all, and units a day;
//   * recurrence -- how often a price came back: for each hour the item traded, whether any hour within
//     the window traded at or below THAT hour's own price. Measured at the item's own level rather than
//     against today's price, so an item whose price has drifted over the window is not scored as
//     "always available" simply because it used to be cheaper.
//
// Every figure is a count over hours that really happened. An item with too little archive to judge
// gets `null` and no warning at all -- the established fail-open rule, since "EVI has not watched this
// long enough" must never read as "this is fine".

// Windows worth precomputing; a player's own trade duration is matched to the nearest of these.
export const WINDOWS = [1, 4, 12, 24];
// Below this many archived hours for an item, there is nothing to judge it on.
export const MIN_HOURS = 72;
// A trade window where fewer than half the item's own price levels came back is a coin flip at best.
export const THIN_RECURRENCE = 0.5;
// An item trading in under a tenth of hours is thin however well its prices appear to recur: that is the
// band the measurement found bad on both counts (29% within 4 hours, a median of one unit available).
// Deliberately NOT a quarter: the 10-40% band came out at 67% within 4 hours with 7 units, which is a
// real trade, and flagging it would have thrown away most of the market to no purpose.
export const THIN_CADENCE = 0.10;

const median = a => { const v = [...a].sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : 0; };

// buckets: archived hourly buckets, oldest first. Returns {hours, byItem}, computed in one pass so a
// suggestion only ever does a lookup. hours matters as much as the per-item stats: an item absent from
// byItem traded in NONE of those hours, which is a count, not missing data.
export function buildThinMarketIndex(buckets) {
  const hours = (buckets || []).length;
  if (!hours) return {hours: 0, byItem: new Map()};
  const grid = new Map();
  buckets.forEach((b, i) => {
    for (const [id, [, , lo, lv]] of Object.entries(b.d)) {
      if (!(lo > 0) || !(lv > 0)) continue;
      let s = grid.get(id);
      if (!s) { s = {lo: new Float64Array(hours), lv: new Float64Array(hours), traded: 0, units: 0}; grid.set(id, s); }
      s.lo[i] = lo; s.lv[i] = lv; s.traded++; s.units += lv;
    }
  });
  const out = new Map();
  for (const [id, s] of grid) {
    const stats = {hours, hoursTraded: s.traded, cadence: s.traded / hours, unitsPerDay: s.units / (hours / 24),
      recurrence: {}, unitsWithin: {}};
    for (const w of WINDOWS) {
      let samples = 0, matched = 0; const units = [];
      for (let i = 0; i + w < hours; i++) {
        const price = s.lo[i];
        if (!(price > 0)) continue;
        samples++;
        let available = 0;
        for (let j = i + 1; j <= i + w; j++) if (s.lo[j] > 0 && s.lo[j] <= price) available += s.lv[j];
        if (available > 0) matched++;
        units.push(available);
      }
      stats.recurrence[w] = samples ? matched / samples : null;
      stats.unitsWithin[w] = samples ? median(units) : null;
      stats.samples = samples;
    }
    out.set(Number(id), stats);
  }
  return {hours, byItem: out};
}

/** The precomputed window closest to the player's own trade duration. */
export function windowFor(targetDurationMinutes) {
  const hours = Number.isFinite(targetDurationMinutes) && targetDurationMinutes > 0 ? targetDurationMinutes / 60 : 12;
  return WINDOWS.reduce((best, w) => Math.abs(w - hours) < Math.abs(best - hours) ? w : best, WINDOWS[0]);
}

// One sentence when a buy pick's own history says the price may simply not come back, or null when it
// does not. Numbers only: how often it trades, how often the price recurred, how much was available.
// Never a forecast, and never a block -- the caller demotes the pick and shows this, exactly as it does
// for a stale sell price.
export function thinMarketNote(stats, {name, windowHours, quantity, archivedHours} = {}) {
  const gpNum = x => Math.round(x).toLocaleString('en-US');
  // Absent from an archive long enough to judge by: it traded in none of those hours at all.
  if (!stats) {
    if (!(archivedHours >= MIN_HOURS)) return null;
    return `Warning: ${name || 'this item'} did not trade at all in the last ${gpNum(archivedHours)} hours EVI has records for, `
      + `on either side of the market. There is no recent price to buy or sell it at, so an offer may sit indefinitely. `
      + `That is EVI's own record of the market, not a forecast.`;
  }
  if (stats.hours < MIN_HOURS) return null;
  const w = WINDOWS.includes(windowHours) ? windowHours : 12;
  const recurrence = stats.recurrence[w];
  if (recurrence === null || recurrence === undefined) return null;
  const thin = stats.cadence < THIN_CADENCE || recurrence < THIN_RECURRENCE;
  if (!thin) return null;
  const gp = x => Math.round(x).toLocaleString('en-US');
  const perDay = stats.unitsPerDay >= 10 ? gp(stats.unitsPerDay) : stats.unitsPerDay.toFixed(1).replace(/\.0$/, '');
  const available = stats.unitsWithin[w];
  const wanted = Number.isFinite(quantity) && quantity > 0 ? quantity : null;
  return `Warning: ${name || 'this item'} barely trades -- in ${gp(stats.hoursTraded)} of the last ${gp(stats.hours)} hours `
    + `(${Math.round(stats.cadence * 100)}%), about ${perDay} a day. Over those hours, a price like this one was matched again `
    + `within ${w} hour${w === 1 ? '' : 's'} only ${Math.round(recurrence * 100)}% of the time, with typically `
    + `${gp(available)} unit${available === 1 ? '' : 's'} available at or under it`
    + (wanted && available < wanted ? `, against the ${gp(wanted)} you would be buying` : '')
    + `. Your offer may simply sit unfilled. That is this item's own record, not a forecast.`;
}

// The same figures as a plain statement rather than a warning, for every buy pick whose item EVI has
// records for. Added because the thresholds above are a cliff and real items sit on it: a Twisted relic
// hunter (t3) armour set came out at 11% of hours and 54% recurrence with one unit available -- just
// inside both limits, so it drew no warning, while "a coin flip on the single unit you are buying" is
// exactly what the player asked to be told. Facts only, no verdict, and nothing here demotes a pick.
export function thinMarketContext(stats, {windowHours, quantity} = {}) {
  if (!stats || stats.hours < MIN_HOURS) return null;
  const w = WINDOWS.includes(windowHours) ? windowHours : 12;
  const recurrence = stats.recurrence[w];
  if (recurrence === null || recurrence === undefined) return null;
  const gp = x => Math.round(x).toLocaleString('en-US');
  const available = stats.unitsWithin[w];
  const wanted = Number.isFinite(quantity) && quantity > 0 ? quantity : null;
  return `Fill history: this item traded in ${gp(stats.hoursTraded)} of the last ${gp(stats.hours)} hours `
    + `(${Math.round(stats.cadence * 100)}%), and a price like this one was matched again within ${w} hour${w === 1 ? '' : 's'} `
    + `in ${Math.round(recurrence * 100)}% of those cases, typically ${gp(available)} unit${available === 1 ? '' : 's'} `
    + `at or under it${wanted ? ` (you would be buying ${gp(wanted)})` : ''}.`;
}
