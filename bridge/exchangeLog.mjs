// Reading another plugin's Grand Exchange log, so a new player is not starting from nothing.
//
// EVI's personal-history tier, its fill measurements and the whole idea of "how have you actually
// been trading" all need trades that have already happened. A player who installs EVI today has
// none, and the parts of EVI worth having are the parts that stay quiet until it does. Exchange
// Logger has been on the Plugin Hub since 2021 writing every Grand Exchange transaction to a file
// on disk, so anyone who has run it is carrying exactly the history EVI needs.
//
// Three deliberate choices:
//
//  * **The matching is not reimplemented.** These records are turned into offers of the same shape
//    the plugin produces, then handed to `computeAutoFlips` -- EVI's own FIFO matcher, with its own
//    tax handling and its own rules about what counts. One matcher, one set of answers. A second
//    implementation would eventually disagree with the first, and the first is the one that has
//    been checked against real trades.
//  * **Nothing is guessed.** An offer whose start is not in the log is left unmatched rather than
//    assumed to have begun when the file happens to start, and a sale with no purchase behind it is
//    reported as unmatched rather than counted as pure profit. Both are stated in the summary.
//  * **It is read-only and local.** Files are read from the player's own `.runelite` folder and
//    never written to, and nothing here reaches the network.
//
// The formats, from Exchange Logger's own README and source:
//   plain text  2026-08-24 23:44:10 state: BUY slot: 0 item: 2351 (Iron bar) max: 1 offer: 164
//               2026-08-24 23:44:11 state: BOUGHT slot: 0 item: 2351 (Iron bar) qty: 1 worth: 153 tax: 0
//   csv         date,time,state,slot,item,qty,worth,max,offer,itemName,tax
//   json        {"date":"…","time":"…","state":"SOLD","slot":0,"item":2351,"qty":1,"worth":149,
//                "max":1,"offer":143,"itemName":"Iron bar","tax":3}
import {computeAutoFlips} from './store.mjs';

// Exchange Logger's own states, plus the two short forms its plain text uses for a freshly placed
// offer. Anything else (EMPTY, an unknown word) ends an offer without contributing to it.
const STATES = new Set(['BUYING', 'SELLING', 'BOUGHT', 'SOLD', 'CANCELLED_BUY', 'CANCELLED_SELL', 'EMPTY']);
const SHORT = {BUY: 'BUYING', SELL: 'SELLING'};
const TERMINAL = new Set(['BOUGHT', 'SOLD', 'CANCELLED_BUY', 'CANCELLED_SELL']);
const SELL_SIDE = new Set(['SELLING', 'SOLD', 'CANCELLED_SELL']);

const int = v => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : null; };

// The log carries wall-clock date and time with no zone, written by the player's own client on this
// machine, so it is read as local time -- the same clock every other date in EVI comes from.
function at(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || '').trim());
  const t = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(String(time || '').trim());
  if (!m || !t) return null;
  const ms = new Date(+m[1], +m[2] - 1, +m[3], +t[1], +t[2], +t[3]).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** One line of any of the three formats, or null if it is not a record at all. */
export function parseLine(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  if (text.startsWith('{')) return fromJson(text);
  if (/^\d{4}-\d{2}-\d{2},/.test(text)) return fromCsv(text);
  if (/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}:\d{2}\s/.test(text)) return fromPlain(text);
  return null; // a CSV header, a blank line, or something this reader does not recognise
}

function normalise(r) {
  const state = SHORT[r.state] || r.state;
  if (!STATES.has(state)) return null;
  if (!Number.isFinite(r.at) || !Number.isInteger(r.itemId) || r.itemId <= 0) return null;
  if (!Number.isInteger(r.slot) || r.slot < 0 || r.slot > 7) return null;
  return {at: r.at, state, slot: r.slot, itemId: r.itemId,
    name: typeof r.name === 'string' && r.name ? r.name.slice(0, 150) : null,
    qty: Number.isInteger(r.qty) && r.qty >= 0 ? r.qty : 0,
    worth: Number.isInteger(r.worth) && r.worth >= 0 ? r.worth : 0,
    max: Number.isInteger(r.max) && r.max > 0 ? r.max : null,
    offer: Number.isInteger(r.offer) && r.offer > 0 ? r.offer : null,
    tax: Number.isInteger(r.tax) && r.tax >= 0 ? r.tax : 0};
}

function fromJson(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  return normalise({at: at(j.date, j.time), state: String(j.state || '').toUpperCase(), slot: int(j.slot),
    itemId: int(j.item), name: j.itemName, qty: int(j.qty), worth: int(j.worth), max: int(j.max),
    offer: int(j.offer), tax: int(j.tax)});
}

// The item name is a quoted field and may itself contain a comma, so the row is split on commas
// outside quotes rather than with a plain split.
function splitCsv(text) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function fromCsv(text) {
  const f = splitCsv(text);
  if (f.length < 11) return null;
  return normalise({at: at(f[0], f[1]), state: f[2].trim().toUpperCase(), slot: int(f[3]), itemId: int(f[4]),
    qty: int(f[5]), worth: int(f[6]), max: int(f[7]), offer: int(f[8]), name: f[9], tax: int(f[10])});
}

function fromPlain(text) {
  const head = /^(\d{4}-\d{2}-\d{2}) (\d{1,2}:\d{2}:\d{2})\s+state:\s*(\w+)/.exec(text);
  if (!head) return null;
  const field = key => { const m = new RegExp(key + ':\\s*(-?\\d+)').exec(text); return m ? int(m[1]) : null; };
  const item = /item:\s*(\d+)\s*(?:\(([^)]*)\))?/.exec(text);
  if (!item) return null;
  return normalise({at: at(head[1], head[2]), state: head[3].toUpperCase(), slot: field('slot'),
    itemId: int(item[1]), name: item[2] || null, qty: field('qty'), worth: field('worth'),
    max: field('max'), offer: field('offer'), tax: field('tax')});
}

/** Every record in a file, in the order written, with a count of what could not be read. */
export function parseLog(text) {
  const records = [];
  let unreadable = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    // The CSV header is expected, not a failure.
    if (/^date,time,state,/i.test(line.trim())) continue;
    const r = parseLine(line);
    if (r) records.push(r); else unreadable++;
  }
  records.sort((a, b) => a.at - b.at);
  return {records, unreadable};
}

/**
 * The records turned into finished offers of the shape EVI's own matcher expects.
 *
 * An offer occupies one Grand Exchange slot from the moment it is placed until it completes or is
 * cancelled, so the records are followed per slot: a run ends at a terminal state, at EMPTY, or when
 * the item in that slot changes. `knownStart` is true only when the run began with a freshly placed
 * offer -- EVI's matcher refuses anything else, which is what keeps a file that begins halfway
 * through a purchase from inventing a buy that was never seen.
 */
export function buildOffers(records, {account = 'exchange-logger'} = {}) {
  const open = new Map();
  const offers = [];
  const close = slot => {
    const run = open.get(slot);
    open.delete(slot);
    if (!run || !TERMINAL.has(run.state) || !(run.qty > 0)) return;
    const sell = SELL_SIDE.has(run.state);
    // Exchange Logger reports `worth` for a sale already net of tax and gives the tax separately.
    // EVI's matcher applies the tax itself from the gross figure, so the gross is restored here --
    // otherwise every imported sale would be taxed twice.
    const spent = sell ? run.worth + run.tax : run.worth;
    offers.push({offerId: `xlog:${account}:${run.slot}:${run.firstSeen}:${run.itemId}`,
      account, itemId: run.itemId, name: run.name || String(run.itemId), slot: run.slot,
      state: run.state, price: run.offer ?? (run.qty > 0 ? Math.round(spent / run.qty) : 0),
      total: run.max ?? run.qty, filled: run.qty, spent,
      firstSeen: run.firstSeen, completedAt: run.at, updated: run.at,
      knownStart: run.knownStart, imported: true});
  };
  for (const r of records) {
    const run = open.get(r.slot);
    if (run && (run.itemId !== r.itemId || TERMINAL.has(run.state))) close(r.slot);
    if (r.state === 'EMPTY') { close(r.slot); continue; }
    const current = open.get(r.slot);
    if (!current) {
      open.set(r.slot, {slot: r.slot, itemId: r.itemId, name: r.name, firstSeen: r.at, at: r.at,
        state: r.state, qty: r.qty, worth: r.worth, tax: r.tax, max: r.max, offer: r.offer,
        // A run that opens already part-filled began before this file did.
        knownStart: r.qty === 0 && !TERMINAL.has(r.state)});
      continue;
    }
    current.at = r.at;
    current.state = r.state;
    current.qty = Math.max(current.qty, r.qty);
    current.worth = Math.max(current.worth, r.worth);
    current.tax = Math.max(current.tax, r.tax);
    current.name = current.name || r.name;
    current.max = current.max ?? r.max;
    current.offer = current.offer ?? r.offer;
  }
  for (const slot of [...open.keys()]) close(slot);
  return offers;
}

/**
 * Completed flips, ready for Store.importFlips, plus everything the import could not account for.
 * The matching itself is EVI's (`computeAutoFlips`); this only carries the result across.
 */
export function flipsFrom(offers) {
  const {flips, openPositions, unmatchedSells} = computeAutoFlips(offers);
  return {
    flips: flips.map(f => ({fp: 'exchange-logger:' + f.buyId, itemId: f.itemId, item: f.item,
      quantity: f.quantity, capital: f.capital, profit: f.profit,
      firstBuy: f.firstBuy, lastSell: f.lastSell, account: f.account})),
    openPositions, unmatchedSells,
  };
}

/**
 * A file name the player chose, resolved inside one of the allowed folders, or null.
 *
 * The bridge is an HTTP server, so a route that opens a path from a request is a way to read any
 * file on the machine unless the set of folders is closed and the name cannot climb out of it. Both
 * are enforced here: no separators, no traversal, and the resolved path must still sit inside the
 * folder it was resolved against. `isFile` is passed in so this can be tested without a disk.
 */
export function resolveLogFile(dirs, name, isFile, sep = '/') {
  if (typeof name !== 'string' || !name || name.length > 200) return null;
  if (name.includes('/') || name.includes(String.fromCharCode(92)) || name.includes('..')) return null;
  for (const dir of dirs || []) {
    const base = dir.endsWith(sep) ? dir.slice(0, -sep.length) : dir;
    const full = base + sep + name;
    if (!full.startsWith(base + sep)) continue;
    if (isFile(full)) return full;
  }
  return null;
}

/** What an import would do, in the words the player is shown before they agree to it. */
export function summarise({records = [], unreadable = 0, offers = [], flips = [], openPositions = [], unmatchedSells = []} = {}) {
  const times = records.map(r => r.at).filter(Number.isFinite);
  const profit = flips.reduce((n, f) => n + f.profit, 0);
  const noStart = offers.filter(o => !o.knownStart).length;
  return {
    records: records.length, unreadable, offers: offers.length,
    offersWithoutAStart: noStart,
    flips: flips.length,
    profit,
    winners: flips.filter(f => f.profit > 0).length,
    losers: flips.filter(f => f.profit < 0).length,
    items: new Set(flips.map(f => f.itemId)).size,
    firstTrade: times.length ? Math.min(...times) : null,
    lastTrade: times.length ? Math.max(...times) : null,
    stillHeld: openPositions.length,
    unmatchedSales: unmatchedSells.length,
  };
}
