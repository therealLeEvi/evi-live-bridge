import fs from 'node:fs';
import path from 'node:path';

// Records every suggestion EVI actually hands the plugin, so its outcomes can later be scored
// against what really happened (the plugin's own journaled offers in events.jsonl): did a suggested
// buy fill, how long it took, what it really made. That is the prerequisite for measuring any
// prediction model's accuracy before trusting it. The plugin polls every 2 seconds, so an identical
// suggestion for the same account is logged once and again only after REPEAT_MS, keeping the file
// small. Local only, never sent anywhere; rotates to .1 past MAX_BYTES. A write failure never
// affects the suggestion itself.
const REPEAT_MS = 30 * 60 * 1000;
const MAX_BYTES = 50 * 1024 * 1024;

// What each safety check concluded about a suggestion, recorded beside it. The log already held every
// pick and the settings behind it, but not whether a check had flagged it -- so there was no way to
// show later whether the checks were RIGHT: did demoted picks really do worse, did exit-risk warnings
// really precede unsold stock? That is the evidence EVI's "every claim is measured" standard needs,
// and it only exists if it is recorded from the start. Numbers are stored as measured, rounded to whole
// GP; a check that did not run is recorded as null, never as a pass.
export function checksOf(s) {
  if (!s) return null;
  const support = s.sellSupport;
  const outlook = s.fillOutlook;
  return {
    demoted: !!s.demoted,
    sellSupport: support ? {
      supported: !!support.supported, buyers: support.units ?? null, hours: support.hours ?? null,
      averagePaid: Number.isFinite(support.averagePaid) ? Math.round(support.averagePaid) : null,
      netAtAverage: Number.isFinite(support.netAtAverage) ? Math.round(support.netAtAverage) : null,
    } : null,
    exitRisk: outlook ? {buy: outlook.buy, sell: outlook.sell, worst: outlook.worst, notable: !!outlook.notable} : null,
  };
}

export function createSuggestionLog(dir) {
  const file = path.join(dir, 'suggestion-log.jsonl');
  const last = new Map(); // account -> {key, at, id}
  let seq = 0;
  // A stable handle for one shown suggestion, so the player can say "I took THIS one" and be
  // believed rather than guessed at. Sortable by time and unique without a dependency: the
  // timestamp in base 36, the item, and a counter that breaks ties inside the same millisecond.
  const makeId = (now, itemId) => `${now.toString(36)}-${itemId}-${(seq++ % 1296).toString(36).padStart(2, '0')}`;
  function record({account, suggestion, now = Date.now(), context = {}}) {
    if (!suggestion) return {written: false, id: null};
    const s = suggestion;
    // Which picks were demoted counts too: the same pick shown after a different item was pushed down
    // is a different call by the checks, and would otherwise go unrecorded.
    const demotedIds = (context.demotedPicks || []).map(p => p.itemId).join(',');
    const key = [s.itemId, s.action, s.source, s.quantity, s.buyPrice, s.sellPrice, demotedIds].join('|');
    const who = account || '';
    const prev = last.get(who);
    // A repeat of the same suggestion is the SAME suggestion still being shown, so it keeps the
    // earlier id. Otherwise accepting a pick that had been on screen for a minute would refer to a
    // log entry that was never written, and the acceptance could not be joined to anything.
    if (prev && prev.key === key && now - prev.at < REPEAT_MS) return {written: false, id: prev.id};
    const id = makeId(now, s.itemId);
    last.set(who, {key, at: now, id});
    const entry = {
      id, ts: now, account: account || null, itemId: s.itemId, name: s.name, action: s.action, source: s.source,
      quantity: s.quantity, buyPrice: s.buyPrice, sellPrice: s.sellPrice,
      breakEvenPrice: s.breakEvenPrice ?? null, lossIfSoldNow: s.lossIfSoldNow ?? null, persisted: !!s.persisted,
      forecast: s.forecast ? {label: s.forecast.label, confidence: s.forecast.confidence} : null,
      checks: checksOf(s),
      ...context,
    };
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch { return {written: false, id: null}; }
    return {written: true, id};
  }
  // The most recent entries, read from the tail of the file so this stays cheap however large the
  // log grows (it is capped at MAX_BYTES, but that is still 50 MB). A partial first line from
  // landing mid-record is discarded rather than guessed at.
  function recent(limit = 500) {
    try {
      if (!fs.existsSync(file)) return [];
      const size = fs.statSync(file).size;
      const want = Math.min(size, 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(want);
        fs.readSync(fd, buffer, 0, want, size - want);
        const lines = buffer.toString('utf8').split('\n');
        if (size > want) lines.shift();
        return lines.filter(Boolean).slice(-limit).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } finally { fs.closeSync(fd); }
    } catch { return []; }
  }
  return {record, recent, file};
}
