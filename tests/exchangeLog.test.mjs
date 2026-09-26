import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseLine, parseLog, buildOffers, flipsFrom, summarise, resolveLogFile} from '../bridge/exchangeLog.mjs';

// Every fixture below is in Exchange Logger's own three formats, taken from the shapes its README
// and source define. Dates are recent on purpose: EVI refuses to compute tax for sales from before
// the 30 May 2025 regime, so a fixture from 2021 would be correctly ignored and prove nothing.
const day = '2026-09-20';
const plain = (time, state, slot, id, name, rest) =>
  `${day} ${time} state: ${state} slot: ${slot} item: ${id} (${name})${rest}`;

test('a plain-text line is read, in both the placed and the completed shape', () => {
  const placed = parseLine(plain('10:00:00', 'BUY', 0, 2351, 'Iron bar', ' max: 10 offer: 164'));
  assert.equal(placed.state, 'BUYING', 'the short form a fresh offer uses means BUYING');
  assert.equal(placed.itemId, 2351);
  assert.equal(placed.max, 10);
  assert.equal(placed.offer, 164);
  assert.equal(placed.qty, 0);
  const done = parseLine(plain('10:05:00', 'BOUGHT', 0, 2351, 'Iron bar', ' qty: 10 worth: 1530 tax: 0'));
  assert.equal(done.state, 'BOUGHT');
  assert.equal(done.qty, 10);
  assert.equal(done.worth, 1530);
  assert.ok(done.at > placed.at, 'the timestamp is read as this machine\'s own local time');
});

test('a csv row is read, including an item name that contains a comma', () => {
  const r = parseLine(`${day},10:05:00,SOLD,3,2351,10,1470,10,150,"Bar, iron",30`);
  assert.equal(r.state, 'SOLD');
  assert.equal(r.slot, 3);
  assert.equal(r.name, 'Bar, iron', 'the quoted name must survive the split');
  assert.equal(r.worth, 1470);
  assert.equal(r.tax, 30);
});

test('a json line is read, and anything unrecognisable is refused rather than half-read', () => {
  const r = parseLine(`{"date":"${day}","time":"10:05:00","state":"SOLD","slot":0,"item":2351,"qty":1,"worth":149,"max":1,"offer":143,"itemName":"Iron bar","tax":3}`);
  assert.equal(r.itemId, 2351);
  assert.equal(r.worth, 149);
  assert.equal(parseLine('date,time,state,slot,item,qty,worth,max,offer,itemName,tax'), null);
  assert.equal(parseLine('{"nonsense":true}'), null);
  assert.equal(parseLine('hello'), null);
  assert.equal(parseLine(''), null);
  assert.equal(parseLine(`${day},10:05:00,TELEPORTED,0,2351,1,1,1,1,"Iron bar",0`), null, 'an unknown state is not an offer');
});

test('a whole file is read in time order, and unreadable lines are counted not hidden', () => {
  const text = [
    'date,time,state,slot,item,qty,worth,max,offer,itemName,tax',
    `${day},10:05:00,BOUGHT,0,2351,1,153,1,164,"Iron bar",0`,
    'some rubbish a text editor left behind',
    `${day},09:00:00,BUYING,0,2351,0,0,1,164,"Iron bar",0`,
    '',
  ].join('\n');
  const {records, unreadable} = parseLog(text);
  assert.equal(records.length, 2);
  assert.equal(unreadable, 1, 'the header and the blank line are expected; the rubbish is counted');
  assert.ok(records[0].at < records[1].at, 'records come back oldest first whatever order the file is in');
});

// A complete, ordinary trade: ten iron bars bought then sold at a profit.
const boughtThenSold = () => parseLog([
  plain('10:00:00', 'BUY', 0, 2351, 'Iron bar', ' max: 10 offer: 100'),
  plain('10:05:00', 'BOUGHT', 0, 2351, 'Iron bar', ' qty: 10 worth: 1000 tax: 0'),
  plain('10:06:00', 'SELL', 0, 2351, 'Iron bar', ' max: 10 offer: 200'),
  plain('10:30:00', 'SOLD', 0, 2351, 'Iron bar', ' qty: 10 worth: 1960 tax: 40'),
].join('\n')).records;

test('a bought-then-sold pair becomes one flip, with the tax applied exactly once', () => {
  const offers = buildOffers(boughtThenSold(), {account: 'novi'});
  assert.equal(offers.length, 2);
  const sale = offers.find(o => o.state === 'SOLD');
  // Exchange Logger reports a sale's worth already net of tax; EVI's matcher takes tax off itself,
  // so the gross has to be restored or every imported sale is taxed twice.
  assert.equal(sale.spent, 2000, 'the gross is worth plus the tax the log reported');
  const {flips} = flipsFrom(offers);
  assert.equal(flips.length, 1);
  assert.equal(flips[0].quantity, 10);
  assert.equal(flips[0].capital, 1000);
  assert.equal(flips[0].profit, 960, 'profit is the sale after tax less what was paid');
  assert.equal(flips[0].item, 'Iron bar');
  assert.ok(flips[0].fp.startsWith('exchange-logger:'), 'a fingerprint keeps a second import from doubling it');
});

test('the same file imported twice produces the same fingerprints, so nothing is counted twice', () => {
  const a = flipsFrom(buildOffers(boughtThenSold(), {account: 'novi'})).flips.map(f => f.fp);
  const b = flipsFrom(buildOffers(boughtThenSold(), {account: 'novi'})).flips.map(f => f.fp);
  assert.deepEqual(a, b);
});

test('a purchase whose placement is not in the file is left out rather than invented', () => {
  // The file begins with the offer already part-filled: EVI cannot know when it was placed.
  const {records} = parseLog([
    plain('10:05:00', 'BOUGHT', 0, 2351, 'Iron bar', ' qty: 10 worth: 1000 tax: 0'),
    plain('10:06:00', 'SELL', 0, 2351, 'Iron bar', ' max: 10 offer: 200'),
    plain('10:30:00', 'SOLD', 0, 2351, 'Iron bar', ' qty: 10 worth: 1960 tax: 40'),
  ].join('\n'));
  const offers = buildOffers(records, {account: 'novi'});
  const buy = offers.find(o => o.state === 'BOUGHT');
  assert.equal(buy.knownStart, false);
  const {flips, unmatchedSells} = flipsFrom(offers);
  assert.equal(flips.length, 0, 'no flip is manufactured from a purchase that was never seen starting');
  assert.equal(unmatchedSells.length, 1, 'and the sale is reported as unaccounted for, not as pure profit');
});

test('a sale with no purchase behind it is reported, never counted as profit', () => {
  const {records} = parseLog([
    plain('10:00:00', 'SELL', 1, 2351, 'Iron bar', ' max: 5 offer: 200'),
    plain('10:30:00', 'SOLD', 1, 2351, 'Iron bar', ' qty: 5 worth: 980 tax: 20'),
  ].join('\n'));
  const {flips, unmatchedSells} = flipsFrom(buildOffers(records, {account: 'novi'}));
  assert.equal(flips.length, 0);
  assert.equal(unmatchedSells.length, 1);
});

test('stock still held shows as a position, not as a completed trade', () => {
  const {records} = parseLog([
    plain('10:00:00', 'BUY', 2, 2351, 'Iron bar', ' max: 10 offer: 100'),
    plain('10:05:00', 'BOUGHT', 2, 2351, 'Iron bar', ' qty: 10 worth: 1000 tax: 0'),
  ].join('\n'));
  const {flips, openPositions} = flipsFrom(buildOffers(records, {account: 'novi'}));
  assert.equal(flips.length, 0);
  assert.equal(openPositions.length, 1);
  assert.equal(openPositions[0].remaining, 10);
});

test('a cancelled offer that partly filled still counts for what it filled', () => {
  const {records} = parseLog([
    plain('10:00:00', 'BUY', 0, 2351, 'Iron bar', ' max: 10 offer: 100'),
    plain('10:20:00', 'CANCELLED_BUY', 0, 2351, 'Iron bar', ' qty: 4 worth: 400 tax: 0'),
    plain('10:25:00', 'SELL', 0, 2351, 'Iron bar', ' max: 4 offer: 200'),
    plain('10:40:00', 'SOLD', 0, 2351, 'Iron bar', ' qty: 4 worth: 784 tax: 16'),
  ].join('\n'));
  const {flips} = flipsFrom(buildOffers(records, {account: 'novi'}));
  assert.equal(flips.length, 1);
  assert.equal(flips[0].quantity, 4);
  assert.equal(flips[0].profit, 384);
});

test('one slot reused for a different item does not merge the two offers', () => {
  const {records} = parseLog([
    plain('10:00:00', 'BUY', 0, 2351, 'Iron bar', ' max: 10 offer: 100'),
    plain('10:05:00', 'BOUGHT', 0, 2351, 'Iron bar', ' qty: 10 worth: 1000 tax: 0'),
    plain('10:06:00', 'BUY', 0, 1515, 'Yew logs', ' max: 5 offer: 300'),
    plain('10:09:00', 'BOUGHT', 0, 1515, 'Yew logs', ' qty: 5 worth: 1500 tax: 0'),
  ].join('\n'));
  const offers = buildOffers(records, {account: 'novi'});
  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map(o => o.itemId).sort((a, b) => a - b), [1515, 2351]);
  assert.ok(offers.every(o => o.knownStart), 'both were seen from the moment they were placed');
});

test('the summary says what was read and, just as plainly, what was left out', () => {
  const {records, unreadable} = parseLog([
    plain('10:00:00', 'BUY', 0, 2351, 'Iron bar', ' max: 10 offer: 100'),
    plain('10:05:00', 'BOUGHT', 0, 2351, 'Iron bar', ' qty: 10 worth: 1000 tax: 0'),
    plain('10:06:00', 'SELL', 0, 2351, 'Iron bar', ' max: 10 offer: 200'),
    plain('10:30:00', 'SOLD', 0, 2351, 'Iron bar', ' qty: 10 worth: 1960 tax: 40'),
    plain('11:00:00', 'SELL', 1, 1515, 'Yew logs', ' max: 5 offer: 300'),
    plain('11:30:00', 'SOLD', 1, 1515, 'Yew logs', ' qty: 5 worth: 1470 tax: 30'),
  ].join('\n'));
  const offers = buildOffers(records, {account: 'novi'});
  const {flips, openPositions, unmatchedSells} = flipsFrom(offers);
  const s = summarise({records, unreadable, offers, flips, openPositions, unmatchedSells});
  assert.equal(s.flips, 1);
  assert.equal(s.profit, 960);
  assert.equal(s.winners, 1);
  assert.equal(s.losers, 0);
  assert.equal(s.items, 1);
  assert.equal(s.unmatchedSales, 1, 'the yew logs sale had no purchase behind it and is said so');
  assert.ok(s.firstTrade < s.lastTrade);
});

// The bridge is an HTTP server, so a route that opens a path named in a request is a way to read any
// file on the machine unless the folder set is closed and the name cannot climb out of it.
test('a log file name can only ever resolve inside an allowed folder', () => {
  const sep = String.fromCharCode(92); // a Windows separator, spelt out so no escaping can blur it
  const folder = ['C:', 'Users', 'p', '.runelite', 'exchange-logger'].join(sep);
  const allowed = [folder];
  const exists = () => true;
  assert.equal(resolveLogFile(allowed, 'exchange.log', exists, sep), folder + sep + 'exchange.log');
  for (const attempt of ['../../../../Windows/win.ini', '..' + sep + '..' + sep + 'keys.json',
    'sub/dir.log', 'sub' + sep + 'dir.log', '..', '', 'x'.repeat(201)]) {
    assert.equal(resolveLogFile(allowed, attempt, exists, sep), null, 'must refuse: ' + attempt);
  }
  assert.equal(resolveLogFile([], 'exchange.log', exists, sep), null, 'with no folders, nothing resolves');
  assert.equal(resolveLogFile(allowed, 'exchange.log', () => false, sep), null, 'a name that is not a file resolves to nothing');
});
