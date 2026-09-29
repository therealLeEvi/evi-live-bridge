// "I took this" -- the record that turns EVI's track record from an inference into an observation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAcceptances} from '../bridge/acceptances.mjs';
import {createSuggestionLog} from '../bridge/suggestionLog.mjs';
import {joinSuggestionOutcomes, summarizeOutcomes} from '../bridge/suggestionOutcomes.mjs';

const tempDir = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-accept-'));
  t.after(() => { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
  return dir;
};
const T = Date.UTC(2026, 8, 29, 12);
const suggestion = {itemId: 4151, name: 'Abyssal whip', action: 'buy', source: 'market', quantity: 2,
  buyPrice: 1_500_000, sellPrice: 1_560_000};
const offer = (over = {}) => ({offerId: 'o1', itemId: 4151, state: 'BOUGHT', price: 1_500_000, total: 2,
  filled: 2, firstSeen: T + 60_000, completedAt: T + 900_000, ...over});

test('an acceptance is recorded, and reads back as accepted', t => {
  const a = createAcceptances(tempDir(t));
  assert.equal(a.wasAccepted('abc'), false, 'nothing is accepted before it is pressed');
  const r = a.accept({id: 'abc', itemId: 4151, now: T});
  assert.equal(r.ok, true);
  assert.equal(a.wasAccepted('abc'), true);
  assert.equal(a.acceptedAt('abc'), T);
  assert.equal(a.count(), 1);
});

test('it is reversible, because a tap the player cannot undo is one they stop making', t => {
  const a = createAcceptances(tempDir(t));
  a.accept({id: 'abc', itemId: 4151, now: T});
  a.accept({id: 'abc', itemId: 4151, accepted: false, now: T + 1000});
  assert.equal(a.wasAccepted('abc'), false, 'the newest record for an id wins');
  assert.equal(a.count(), 0);
  a.accept({id: 'abc', itemId: 4151, now: T + 2000});
  assert.equal(a.wasAccepted('abc'), true, 'and it can be taken back again');
});

test('the undo is an append, so the original acceptance is still on record', t => {
  const dir = tempDir(t);
  const a = createAcceptances(dir);
  a.accept({id: 'abc', itemId: 4151, now: T});
  a.accept({id: 'abc', itemId: 4151, accepted: false, now: T + 1000});
  const lines = fs.readFileSync(path.join(dir, 'suggestion-accepted.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'nothing is rewritten in place');
  assert.equal(JSON.parse(lines[0]).accepted, true);
  assert.equal(JSON.parse(lines[1]).accepted, false);
});

test('acceptances survive a restart', t => {
  const dir = tempDir(t);
  createAcceptances(dir).accept({id: 'abc', itemId: 4151, now: T});
  assert.equal(createAcceptances(dir).wasAccepted('abc'), true);
});

test('an id is required, and a bad one is refused rather than recorded as something', t => {
  const a = createAcceptances(tempDir(t));
  assert.equal(a.accept({id: null}).ok, false);
  assert.equal(a.accept({id: 42}).ok, false, 'an id must be the string the log issued');
  assert.equal(a.count(), 0);
});

test('the log issues a stable id, and a repeat of the same pick keeps it', t => {
  const log = createSuggestionLog(tempDir(t));
  const first = log.record({account: 'a', suggestion, now: T});
  assert.ok(first.id, 'a written suggestion gets an id');
  // The plugin polls every couple of seconds. If each poll minted a new id, accepting a pick that
  // had been on screen for a minute would refer to a log entry that was never written.
  const repeat = log.record({account: 'a', suggestion: {...suggestion}, now: T + 2000});
  assert.equal(repeat.written, false);
  assert.equal(repeat.id, first.id, 'the same pick still showing is the same suggestion');
  const changed = log.record({account: 'a', suggestion: {...suggestion, buyPrice: 1_400_000}, now: T + 4000});
  assert.notEqual(changed.id, first.id, 'a different pick is a different suggestion');
});

test('an accepted suggestion is attributed as observed, an unaccepted one as inferred', () => {
  const rows = joinSuggestionOutcomes(
    [{...suggestion, id: 'x1', ts: T}],
    [offer()], [], {wasAccepted: id => id === 'x1'});
  assert.equal(rows[0].taken, true);
  assert.equal(rows[0].attribution, 'observed');

  const guessed = joinSuggestionOutcomes([{...suggestion, id: 'x1', ts: T}], [offer()], []);
  assert.equal(guessed[0].taken, true);
  assert.equal(guessed[0].attribution, 'inferred', 'with no acceptance record it is still only a reading');
});

test('an accepted suggestion counts even when the offer came later than the inference window', () => {
  const late = offer({firstSeen: T + 5 * 3600_000, completedAt: T + 6 * 3600_000});
  const inferred = joinSuggestionOutcomes([{...suggestion, id: 'x1', ts: T}], [late], []);
  assert.equal(inferred[0].taken, false, 'five hours later is outside the two-hour guess');

  const observed = joinSuggestionOutcomes([{...suggestion, id: 'x1', ts: T}], [late], [], {wasAccepted: () => true});
  assert.equal(observed[0].taken, true, 'but the player said they took it, so find the offer');
  assert.equal(observed[0].attribution, 'observed');
});

test('an acceptance with no offer at all is kept as taken-but-never-placed', () => {
  const rows = joinSuggestionOutcomes([{...suggestion, id: 'x1', ts: T}], [], [], {wasAccepted: () => true});
  assert.equal(rows[0].taken, true);
  assert.equal(rows[0].noOfferFound, true,
    'dropping these would quietly delete the times following EVI led nowhere');
  const s = summarizeOutcomes(rows);
  assert.equal(s.acceptedNeverPlaced, 1);
});

test('the summary never pools observed and inferred into one number', () => {
  const rows = joinSuggestionOutcomes(
    [{...suggestion, id: 'x1', ts: T}, {...suggestion, itemId: 4153, id: 'x2', ts: T + 20 * 3600_000}],
    [offer(), offer({offerId: 'o2', itemId: 4153, firstSeen: T + 20 * 3600_000 + 60_000, completedAt: T + 21 * 3600_000})],
    [], {wasAccepted: id => id === 'x1'});
  const s = summarizeOutcomes(rows);
  assert.equal(s.taken, 2);
  assert.equal(s.observed, 1);
  assert.equal(s.inferred, 1);
});

test('an exact fingerprint is attributed as matched, between observed and inferred', () => {
  // 40 units is above the measured bar, and the offer carries both EVI's price and its quantity.
  const s = {...suggestion, id: 'x1', ts: T, quantity: 40, buyPrice: 1_500_000};
  const rows = joinSuggestionOutcomes([s], [offer({total: 40, filled: 40, price: 1_500_000})], []);
  assert.equal(rows[0].attribution, 'matched');
});

test('a fingerprint is not claimed when the player set their own price or size', () => {
  const s = {...suggestion, id: 'x1', ts: T, quantity: 40, buyPrice: 1_500_000};
  const otherPrice = joinSuggestionOutcomes([s], [offer({total: 40, filled: 40, price: 1_499_000})], []);
  assert.equal(otherPrice[0].attribution, 'inferred', 'a different price is the player\'s own call');
  const otherSize = joinSuggestionOutcomes([s], [offer({total: 39, filled: 39, price: 1_500_000})], []);
  assert.equal(otherSize[0].attribution, 'inferred', 'a different quantity is the player\'s own call');
});

test('a small quantity never fingerprints, because matching it proves nothing', () => {
  // Measured on the real log: a quantity of 1 is 45% of every suggestion EVI has ever made, and two
  // independent picks in the 1-2 band collide 79.9% of the time. An exact match there is noise.
  const s = {...suggestion, id: 'x1', ts: T, quantity: 1, buyPrice: 1_500_000};
  const rows = joinSuggestionOutcomes([s], [offer({total: 1, filled: 1, price: 1_500_000})], []);
  assert.equal(rows[0].attribution, 'inferred', 'an exact match on one unit is a coincidence, not evidence');
});

test('pressing the button still outranks a fingerprint', () => {
  const s = {...suggestion, id: 'x1', ts: T, quantity: 40, buyPrice: 1_500_000};
  const rows = joinSuggestionOutcomes([s], [offer({total: 40, filled: 40, price: 1_500_000})], [],
    {wasAccepted: () => true});
  assert.equal(rows[0].attribution, 'observed', 'a stated fact beats an inferred one');
  assert.equal(summarizeOutcomes(rows).matched, 0, 'and it is never counted in both');
});
