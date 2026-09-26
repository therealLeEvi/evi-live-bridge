// "How have I actually been trading?" -- the player's own settings history, with what happened under
// each one.
//
// Asked for after the minimum profit target moved from 500k to 1M: the natural next question is
// whether the change traded better, and EVI already has the evidence. Every suggestion is logged with
// the settings that produced it (minProfit, durationMinutes, risk, cash), and suggestionOutcomes.mjs
// already joins those to what the player really did. This groups the joined rows into periods where
// the settings held steady and sums each one.
//
// Two rules keep it honest:
//   * Development requests against the running bridge are logged too, with account `test` or none.
//     They are dropped here: counting them would inflate the activity and mix in settings the player
//     never chose.
//   * A period is a description, not an experiment. The market differs from day to day, so a period
//     that looks better may simply have been a better week, and with a handful of closed trades the
//     difference means nothing at all. `enoughToCompare` says so per period rather than leaving the
//     reader to assume; nothing here ranks the periods or recommends a setting.

// Below this many closed round trips, a period's realised profit is one or two trades wearing a
// percentage sign. Chosen as the smallest number that is obviously not a single lucky flip; it gates
// a label, never a suggestion.
export const ENOUGH_CLOSED = 5;

const settingsKey = r => JSON.stringify([r.minProfit ?? null, r.durationMinutes ?? null, r.risk ?? null]);
const real = r => typeof r.account === 'string' && r.account.length >= 16;

// rows: suggestion-log entries already joined to outcomes (joinSuggestionOutcomes), oldest first.
// Returns one entry per settings period, newest first.
export function tradingPeriods(rows, {minShown = 1} = {}) {
  const periods = [];
  for (const r of (rows || []).filter(real).sort((a, b) => a.ts - b.ts)) {
    const key = settingsKey(r);
    const last = periods[periods.length - 1];
    if (last && last.key === key) { last.rows.push(r); last.to = r.ts; continue; }
    periods.push({key, from: r.ts, to: r.ts, rows: [r],
      minProfit: r.minProfit ?? null, durationMinutes: r.durationMinutes ?? null, risk: r.risk ?? null});
  }
  return periods.filter(p => p.rows.length >= minShown).map(p => {
    const taken = p.rows.filter(r => r.taken);
    const closed = taken.filter(r => Number.isFinite(r.profit));
    const profits = closed.map(r => r.profit).sort((a, b) => a - b);
    const checks = r => r.checks || {};
    return {
      from: p.from, to: p.to,
      minProfit: p.minProfit, durationMinutes: p.durationMinutes, risk: p.risk,
      shown: p.rows.length,
      taken: taken.length,
      filledFully: taken.filter(r => r.filledFully).length,
      stillOpen: taken.filter(r => r.stillOpen).length,
      closed: closed.length,
      realisedProfit: profits.reduce((s, x) => s + x, 0),
      winners: profits.filter(x => x > 0).length,
      losers: profits.filter(x => x < 0).length,
      medianProfit: profits.length ? profits[Math.floor(profits.length / 2)] : null,
      worstProfit: profits[0] ?? null,
      // What the safety checks did while these settings were in force, so a quiet period and a period
      // full of warnings do not read the same.
      demoted: p.rows.filter(r => checks(r).demoted).length,
      sellSupportFailed: p.rows.filter(r => checks(r).sellSupport && checks(r).sellSupport.supported === false).length,
      exitRiskFlagged: p.rows.filter(r => checks(r).exitRisk && checks(r).exitRisk.notable).length,
      // Deliberately not a verdict: periods are not controlled experiments, and few closed trades say
      // nothing either way. The caller shows this instead of implying one setting beat another.
      enoughToCompare: closed.length >= ENOUGH_CLOSED,
    };
  }).reverse();
}
