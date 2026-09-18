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

export function createSuggestionLog(dir) {
  const file = path.join(dir, 'suggestion-log.jsonl');
  const last = new Map(); // account -> {key, at}
  function record({account, suggestion, now = Date.now(), context = {}}) {
    if (!suggestion) return false;
    const s = suggestion;
    const key = [s.itemId, s.action, s.source, s.quantity, s.buyPrice, s.sellPrice].join('|');
    const who = account || '';
    const prev = last.get(who);
    if (prev && prev.key === key && now - prev.at < REPEAT_MS) return false;
    last.set(who, {key, at: now});
    const entry = {
      ts: now, account: account || null, itemId: s.itemId, name: s.name, action: s.action, source: s.source,
      quantity: s.quantity, buyPrice: s.buyPrice, sellPrice: s.sellPrice,
      breakEvenPrice: s.breakEvenPrice ?? null, lossIfSoldNow: s.lossIfSoldNow ?? null, persisted: !!s.persisted,
      forecast: s.forecast ? {label: s.forecast.label, confidence: s.forecast.confidence} : null,
      ...context,
    };
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    } catch { return false; }
    return true;
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
