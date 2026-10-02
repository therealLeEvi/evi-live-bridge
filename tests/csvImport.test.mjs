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
import {parseDelimited, parseNumber, parseTime, suggestMapping, previewTable, itemResolver, FIELDS} from '../bridge/csvImport.mjs';
import {Store} from '../bridge/store.mjs';
import {createBridge} from '../bridge/server.mjs';

const CSV = [
  'Item,Quantity,Avg. buy price,Profit,First buy time,Last sell time,Account',
  'Blood rune,2000,300,12000,2026-09-13T11:31:27Z,2026-09-13T11:36:57Z,player-one',
  'Mage\'s book,1,150000,150000,2026-09-14T08:00:00Z,2026-09-14T19:30:00Z,player-one',
  '"Ranger\'s tunic, worn",2,1000,-500,2026-09-15T08:00:00Z,2026-09-15T09:00:00Z,player-one',
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
  assert.equal(records[0].capital, 2000 * 300, 'quantity times price, since no total column was given');
  assert.equal(records[0].profit, 12000);
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

test('csv import: a real export\'s own column names are recognised', () => {
  // The headings from a real tracker export, which is how this was found: it names its two
  // quantity columns "Bought" and "Sold", so none of quantity/qty appeared and the whole file was
  // refused. Only "Sold" is an alias, deliberately -- suggestMapping needs exactly one match, so
  // accepting "Bought" too would make this very file ambiguous again.
  const headers = ['First buy time', 'Last sell time', 'Account', 'Item', 'Status', 'Bought', 'Sold',
    'Avg. buy price', 'Avg. sell price', 'Tax', 'Profit', 'Profit ea.'];
  const m = suggestMapping(headers);
  assert.equal(m.quantity, 6, 'the quantity is what was SOLD, since that is what completed');
  assert.equal(headers[m.quantity], 'Sold');
  assert.equal(m.item, 3);
  assert.equal(m.buyPrice, 7);
  assert.equal(m.profit, 10);
  assert.equal(m.boughtAt, 0);
  assert.equal(m.soldAt, 1);
  for (const f of ['item', 'quantity', 'profit', 'boughtAt', 'soldAt'])
    assert.notEqual(m[f], undefined, f + ' must map, or the page refuses the file');
});

test('csv import: a row still in progress is not finished, not broken', () => {
  // A real export carries rows whose status is BUYING: nothing sold yet, no sell time, zero profit.
  // Calling that an unreadable row would report someone's perfectly good file as broken.
  const table = parseDelimited(['Item,Sold,Avg. buy price,Profit,First buy time,Last sell time',
    'Echo crystal,0,2069619,0,2026-09-26T11:37:21Z,',
    'Gold necklace,81,166,81,2026-09-26T10:57:49Z,2026-09-26T11:02:51Z'].join('\n'));
  const {records, errors} = previewTable(table, suggestMapping(table[0]), {profitMeaning: 'after-tax', source: 'test'});
  assert.equal(errors.length, 0, 'an unfinished row is not a file error');
  assert.equal(records.length, 2);
  const [pending, done] = records;
  assert.equal(pending.quantity, null, 'zero sold means no quantity yet, not a quantity of zero');
  assert.equal(pending.capital, null, 'and so nothing to derive a cost from');
  assert.equal(pending.soldAt, null);
  assert.equal(done.quantity, 81);
  assert.equal(done.capital, 81 * 166);
  assert.equal(done.profit, 81);
  // A genuinely broken quantity is still an error, so this did not just loosen the check.
  const bad = parseDelimited(['Item,Sold,Avg. buy price,Profit,First buy time,Last sell time',
    'Coal,-5,100,50,2026-09-13T11:00:00Z,2026-09-13T12:00:00Z'].join('\n'));
  const out = previewTable(bad, suggestMapping(bad[0]), {profitMeaning: 'after-tax', source: 'test'});
  assert.equal(out.records.length, 0);
  assert.match(out.errors[0].message, /negative|whole number/i);
});

test('itemResolver: a shortened name resolves only when it is unambiguous', () => {
  // Trackers export "Varrock teleport" where the catalogue says "Varrock teleport (tablet)". Five of
  // the 68 traded items in one real export went unresolved for that alone. But the restraint is the point: across the
  // real catalogue, 190 of the 487 base names have more than one parenthetical variant, and picking
  // the wrong one would teach EVI a history that never happened.
  const resolve = itemResolver([
    {id: 8007, name: 'Varrock teleport (tablet)'},
    {id: 8449, name: 'Tall box hedge (bagged)'},
    {id: 453, name: 'Coal'},
    // Two variants of one base name: it must refuse to choose between them.
    {id: 1111, name: 'Dragon platebody (g)'},
    {id: 2222, name: 'Dragon platebody (t)'},
    // A base name that is itself a real item, alongside a variant of it.
    {id: 3333, name: 'Rune scimitar'},
    {id: 4444, name: 'Rune scimitar (or)'},
  ]);
  assert.equal(resolve('Varrock teleport'), 8007, 'one candidate, so it resolves');
  assert.equal(resolve('varrock TELEPORT'), 8007, 'and case does not matter');
  assert.equal(resolve('Varrock teleport (tablet)'), 8007, 'the full name still works');
  assert.equal(resolve('Tall box hedge'), 8449);
  assert.equal(resolve('Coal'), 453);
  assert.equal(resolve('Dragon platebody'), null, 'two variants: refuse rather than guess');
  assert.equal(resolve('Rune scimitar'), 3333, 'an exact name always beats a suffix match');
  assert.equal(resolve('Rune scimitar (or)'), 4444);
  assert.equal(resolve('Nothing like this'), null);
  assert.equal(resolve(''), null);
  assert.equal(resolve(null), null);
  // Rubbish in the catalogue is skipped rather than thrown over.
  assert.equal(itemResolver([null, {name: 'x'}, {id: 'y', name: 'z'}, {id: 9, name: 'Real thing'}])('Real thing'), 9);
  assert.equal(itemResolver(undefined)('anything'), null);
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

test('importFlips: the same trade cannot arrive twice by two different routes', t => {
  // A fingerprint only catches a re-import through the same door. The private tool writes
  // "copilot|item|times|..." and the CSV path writes 'generic:["csv <file>",...]', so the same trade
  // arriving the other way has a fingerprint that can never match -- and would double-weight that item
  // in every ranking afterwards, silently. Checked on one real export: its flips.csv happened not to
  // overlap the earlier import (that one stops 12 Sept, the file starts the 18th), so nothing had gone
  // wrong yet, but only by luck.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-crossroute-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = new Store(dir);
  const trade = {itemId: 565, item: 'Blood rune', quantity: 2000, capital: 600000, profit: 12000,
    firstBuy: 1789383383086, lastSell: 1789383710123, account: 'player-one'};

  // Arrives first through the private tool's scheme.
  assert.equal(store.importFlips({source: 'copilot', flips: [{...trade, fp: 'copilot|blood rune|a|b|2000|2000'}]}).accepted, 1);
  // Then the very same trade through the CSV path, different source, different fingerprint entirely.
  const second = store.importFlips({source: 'csv flips.csv', flips: [{...trade, fp: 'generic:["csv flips.csv","sig"]'}]});
  assert.equal(second.accepted, 0, 'the content is already there, whatever describes it');
  assert.equal(second.duplicates, 1);
  assert.equal(store.state().importedFlips.length, 1);

  // A file that simply lists the same trade twice is caught within the one request, which the
  // fingerprint sets alone would not do -- they are only updated once the record is appended.
  const twice = store.importFlips({source: 'csv other.csv', flips: [
    {...trade, itemId: 453, item: 'Coal', fp: 'generic:["csv other.csv","x"]'},
    {...trade, itemId: 453, item: 'Coal', fp: 'generic:["csv other.csv","y"]'},
  ]});
  assert.equal(twice.accepted, 1, 'one of the two, not both');
  assert.equal(twice.duplicates, 1);

  // What must still get through: a different account, a different quantity, a different time.
  const distinct = store.importFlips({source: 'csv third.csv', flips: [
    {...trade, account: 'alt', fp: 'g1'},
    {...trade, quantity: 3410, fp: 'g2'},
    {...trade, lastSell: trade.lastSell + 1000, fp: 'g3'},
  ]});
  assert.equal(distinct.accepted, 3, 'these are genuinely different trades and must not be swallowed');

  // And removing an import takes its content keys with it, so the same file can be imported again.
  store.importFlips({source: 'copilot', remove: true});
  const readded = store.importFlips({source: 'copilot', flips: [{...trade, fp: 'copilot|blood rune|a|b|2000|2000'}]});
  assert.equal(readded.accepted, 1, 'undoing an import must really undo it');
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
