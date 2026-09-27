// The CSV import, published with the bridge since 27 Sept 2026.
//
// It was only ever reachable through the browser scanner, which is in neither published repository, so
// the one history import a Plugin Hub user could reach was the Exchange Logger one -- and anyone who had
// never run that plugin had no route at all. A player's own history is meant to be an extra safety layer
// rather than a requirement, and it cannot be either if there is no way to hand it over.
//
// The test that matters most here is the last one: it feeds the parser's own output straight into
// Store.importFlips. That seam is where this breaks -- the parser produces `boughtAt`/`soldAt` and the
// store demands `firstBuy`/`lastSell` and whole numbers, and nothing but a test crossing both would
// notice a drift.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parseDelimited, parseNumber, parseTime, suggestMapping, previewTable, FIELDS} from '../bridge/csvImport.mjs';
import {Store} from '../bridge/store.mjs';
import {createBridge} from '../bridge/server.mjs';

const CSV = [
  'Item,Quantity,Avg. buy price,Profit,First buy time,Last sell time,Account',
  'Blood rune,3411,339,13644,2026-09-13T11:31:27Z,2026-09-13T11:36:57Z,le evi',
  'Mage\'s book,1,158781,158781,2026-09-14T08:00:00Z,2026-09-14T19:30:00Z,le evi',
  '"Ranger\'s tunic, worn",2,1000,-500,2026-09-15T08:00:00Z,2026-09-15T09:00:00Z,le evi',
].join('\n');

test('csv import: a quoted field containing a comma stays one field', () => {
  const table = parseDelimited(CSV);
  assert.equal(table.length, 4);
  assert.equal(table[0].length, 7);
  assert.equal(table[3][0], "Ranger's tunic, worn", 'the comma inside the quotes is not a separator');
  assert.equal(table[3].length, 7);
});

test('csv import: columns are guessed from headings, not from position', () => {
  const m = suggestMapping(parseDelimited(CSV)[0]);
  assert.equal(m.item, 0);
  assert.equal(m.quantity, 1);
  assert.equal(m.buyPrice, 2);
  assert.equal(m.profit, 3);
  assert.equal(m.boughtAt, 4);
  assert.equal(m.soldAt, 5);
  assert.equal(m.account, 6);
  // Reordering the file must not change the result, which is the point of matching on the heading.
  const shuffled = suggestMapping(['Profit', 'Item', 'Last sell time', 'Quantity', 'First buy time', 'Buy price']);
  assert.equal(shuffled.item, 1);
  assert.equal(shuffled.profit, 0);
  assert.equal(shuffled.soldAt, 2);
  // A heading it does not know is simply left unmapped rather than guessed at by position.
  assert.equal(suggestMapping(['Thing', 'Amount']).item, undefined);
  for (const f of Object.keys(suggestMapping(parseDelimited(CSV)[0]))) assert.ok(FIELDS.includes(f));
});

test('csv import: it refuses to treat a gross figure as profit', () => {
  const table = parseDelimited(CSV);
  const mapping = suggestMapping(table[0]);
  // Confirming the mapped profit is after tax is mandatory, because tax is what turned five of six real
  // losses into losses -- a gross figure imported as net would teach EVI the opposite of the truth.
  assert.throws(() => previewTable(table, mapping, {source: 'test'}), /after tax/);
  assert.throws(() => previewTable(table, mapping, {source: 'test', profitMeaning: 'gross'}), /after tax/);
});

test('csv import: capital is derived from quantity and price, never invented', () => {
  const table = parseDelimited(CSV);
  const {records, errors} = previewTable(table, suggestMapping(table[0]), {profitMeaning: 'after-tax', source: 'test'});
  assert.equal(errors.length, 0);
  assert.equal(records.length, 3);
  assert.equal(records[0].capital, 3411 * 339, 'quantity times price, since no total column was given');
  assert.equal(records[0].profit, 13644);
  assert.equal(records[0].boughtAt, Date.parse('2026-09-13T11:31:27Z'));
  assert.equal(records[2].profit, -500, 'a loss stays a loss');
  assert.equal(records[2].loss, true);
  // With neither a total nor a price, capital is left NULL rather than assumed to be zero -- which
  // would read as pure profit. The row still parses, because the profit column was given outright.
  const noCost = parseDelimited(['Item,Quantity,Profit,First buy time,Last sell time',
    'Coal,10,500,2026-09-13T11:00:00Z,2026-09-13T12:00:00Z'].join('\n'));
  const out = previewTable(noCost, suggestMapping(noCost[0]), {profitMeaning: 'after-tax', source: 'test'});
  assert.equal(out.errors.length, 0);
  assert.equal(out.records[0].capital, null, 'unknown cost stays unknown');
  assert.equal(out.records[0].roi, null, 'and no return is computed from it');
  // Which matters because the store refuses it, so the setup page must filter such a row out rather
  // than send it. This asserts the contract the page relies on.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-csv-nocost-'));
  const store = new Store(dir);
  const r = out.records[0];
  assert.throws(() => store.importFlips({source: 'test', flips: [{fp: r.fp, itemId: 453, item: r.item,
    quantity: r.quantity, capital: r.capital, profit: r.profit, firstBuy: r.boughtAt, lastSell: r.soldAt}]}),
    /capital|quantity|profit/i, 'a null cost must be refused, never treated as zero');
  fs.rmSync(dir, {recursive: true, force: true});
});

test('csv import: a sell before its own buy is an error, not a negative hold', () => {
  const back = parseDelimited(['Item,Quantity,Avg. buy price,Profit,First buy time,Last sell time',
    'Coal,10,100,500,2026-09-13T12:00:00Z,2026-09-13T11:00:00Z'].join('\n'));
  const {records, errors} = previewTable(back, suggestMapping(back[0]), {profitMeaning: 'after-tax', source: 'test'});
  assert.equal(records.length, 0);
  assert.match(errors[0].message, /precedes/);
});

test('csv import: numbers and times survive the formats trackers actually use', () => {
  assert.equal(parseNumber('1,234,567'), 1234567, 'thousands separators are normal in an export');
  assert.equal(parseNumber('  42  '), 42);
  assert.equal(parseNumber('-500'), -500, 'a loss arrives as a negative');
  assert.equal(parseNumber(''), null, 'blank is unknown, not zero');
  // Anything unparseable THROWS rather than returning null, so previewTable records it as an error on
  // that row instead of quietly importing a trade with a missing figure.
  assert.throws(() => parseNumber('not a number'), /Invalid number/);
  assert.throws(() => parseNumber('1.234.567'), /Invalid number/, 'a European format needs the European separator');
  assert.equal(parseNumber('1.234.567', ','), 1234567, 'and reads correctly when told');
  assert.equal(parseTime('2026-09-13T11:31:27Z'), Date.parse('2026-09-13T11:31:27Z'));
  assert.equal(parseTime(''), null, 'a missing time is never guessed at');
});

test('csv import: the parser\'s output is exactly what Store.importFlips accepts', t => {
  // The seam. previewTable produces boughtAt/soldAt and may leave a value fractional; importFlips wants
  // firstBuy/lastSell and whole numbers, and validates hard. This is the translation the setup page
  // performs, asserted end to end so a change to either side fails here rather than in someone's browser.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-csv-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new Store(dir);
  const table = parseDelimited(CSV);
  const {records} = previewTable(table, suggestMapping(table[0]), {profitMeaning: 'after-tax', source: 'csv test.csv'});
  const ids = {'blood rune': 565, "mage's book": 3721, "ranger's tunic, worn": 2501};
  const flips = records.map(r => ({
    fp: r.fp, itemId: ids[r.item.toLowerCase()], item: r.item,
    quantity: Math.round(r.quantity), capital: Math.round(r.capital), profit: Math.round(r.profit),
    firstBuy: r.boughtAt, lastSell: r.soldAt, account: r.account || undefined,
  }));
  const result = store.importFlips({source: 'csv test.csv', flips});
  assert.equal(result.accepted, 3, 'every row the parser accepted must satisfy the store too');
  assert.equal(result.duplicates, 0);

  // Importing the same file twice adds nothing, which is what the fingerprint is for.
  const again = store.importFlips({source: 'csv test.csv', flips});
  assert.equal(again.accepted, 0);
  assert.equal(again.duplicates, 3);

  // And the whole import can be taken back out, since it is grouped under one source name.
  const undone = store.importFlips({source: 'csv test.csv', remove: true});
  assert.equal(undone.removed, 3);
});

test('csv import: the parser is served to the browser, and only to an unlocked one', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-csv-http-'));
  const port = 51764, app = createBridge({dir, port});
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dir, {recursive: true, force: true}); });
  const get = (p, opts) => fetch(app.origin + p, opts);

  assert.equal((await get('/csvImport.mjs')).status, 401, 'as private as anything else here');
  const headers = {'Content-Type': 'application/json', Origin: app.origin};
  const unlock = await get('/api/unlock', {method: 'POST', headers, body: JSON.stringify({token: app.secrets.scanner})});
  const cookie = unlock.headers.get('set-cookie').split(';')[0];

  const served = await get('/csvImport.mjs', {headers: {Cookie: cookie}});
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /javascript/);
  const body = await served.text();
  for (const name of ['parseDelimited', 'suggestMapping', 'previewTable'])
    assert.ok(body.includes('export function ' + name), 'the setup page imports ' + name);
  // The setup page drives these; a rename on either side should fail here.
  const page = await (await get('/setup', {headers: {Cookie: cookie}})).text();
  for (const route of ['/csvImport.mjs', '/api/flips/import', '/api/market/mapping'])
    assert.ok(page.includes(route), 'the page uses ' + route);
});
