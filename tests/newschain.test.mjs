import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractSubjects, relevanceOf, chainsForSubject, chainsForPost, chainSentence,
  SECOND_HOP_PENALTY, MAX_PAGE_ITEMS} from '../bridge/newsChain.mjs';

// A miniature wiki shaped like the real one, including the thing that makes this feature necessary:
// the item is reachable only through a mechanic page, and its own page never links back.
const PAGES = {
  'Rooftop Agility Course': ['Amylase crystal', 'Marks of grace', 'Al Kharid Rooftop Course', 'Ardougne Rooftop Course', 'Gielinor'],
  'Al Kharid Rooftop Course': ['Shantay pass', 'Al Kharid'],
  'Ardougne Rooftop Course': ['Summer pie', 'Ardougne'],
  'Marks of grace': ['Amylase crystal', 'Agility'],
  'Amylase crystal': ['Stamina potion', 'Herblore', 'Aldarium', 'Ashes', 'Chocolate dust'],
  Gielinor: Array.from({length: 40}, (_, i) => `Filler item ${i}`),   // a navigation box
  Agility: ['Marks of grace', 'Rope'],
};
const ITEMS = {'Amylase crystal': 12640, 'Shantay pass': 1854, 'Summer pie': 7218, 'Stamina potion': 12625,
  Rope: 954, Aldarium: 29993, Ashes: 592, 'Chocolate dust': 1975};
for (let i = 0; i < 40; i++) ITEMS[`Filler item ${i}`] = 90000 + i;

const wiki = {async links(title) { return PAGES[title] ?? null; }};
const isTradeable = title => ITEMS[title] ? {id: ITEMS[title], name: title} : null;
const volumeOf = () => 500;

test('news chain: subjects come from the post, including a skill named only in passing', () => {
  const subjects = extractSubjects('New Rooftop Agility Course', 'Improved Agility experience for mid-level players.');
  assert.ok(subjects.includes('Agility'), 'a skill mentioned anywhere is a candidate subject');
  assert.ok(subjects.some(s => s.includes('Rooftop Agility Course')), 'and the named content itself');
  // Longest first, so the most specific seed is tried before a one-word fragment.
  assert.ok(subjects[0].length >= subjects.at(-1).length);
});

test('news chain: reaches an item the article never names, and reports the path', async () => {
  const chains = await chainsForSubject('Rooftop Agility Course', {wiki, isTradeable, volumeOf});
  const amylase = chains.find(c => c.name === 'Amylase crystal');
  assert.ok(amylase, 'the whole point: the item is found through the mechanic, not the text');
  assert.deepEqual(amylase.path, ['Rooftop Agility Course', 'Amylase crystal']);
  const sentence = chainSentence(amylase, 'New Rooftop Agility Course');
  assert.match(sentence, /Rooftop Agility Course -> Amylase crystal/);
  assert.match(sentence, /not a prediction/);
  assert.ok(!/rise|fall|increase|decrease|buy now/i.test(sentence), 'it must never imply a direction or an action');
});

test('news chain: an item the update names directly outranks one reached by walking elsewhere', async () => {
  const chains = await chainsForSubject('Rooftop Agility Course', {wiki, isTradeable, volumeOf});
  const direct = chains.find(c => c.name === 'Amylase crystal');
  const indirect = chains.find(c => c.name === 'Summer pie');
  assert.equal(direct.hops, 1);
  assert.equal(indirect.hops, 2);
  assert.ok(direct.score > indirect.score, 'without the hop penalty the incidental item wins, which is backwards');
  assert.ok(SECOND_HOP_PENALTY < 1);
  assert.equal(chains[0].name, 'Amylase crystal', 'and it must come out on top');
});

test('news chain: a navigation box is not evidence about an update', async () => {
  const chains = await chainsForSubject('Rooftop Agility Course', {wiki, isTradeable, volumeOf});
  assert.ok(!chains.some(c => /^Filler item/.test(c.name)), `a page listing more than ${MAX_PAGE_ITEMS} items is a table of contents, not a claim`);
});

test('news chain: an item that does not trade is dropped, whatever the wiki says', async () => {
  const noVolume = await chainsForSubject('Rooftop Agility Course', {wiki, isTradeable, volumeOf: () => 0});
  assert.equal(noVolume.length, 0, 'a chain to an item nobody buys is a curiosity, not a signal');
  // With no volume source at all, nothing is filtered -- unknown never invents a constraint.
  const unknown = await chainsForSubject('Rooftop Agility Course', {wiki, isTradeable});
  assert.ok(unknown.length > 0);
});

test('news chain: a missing page or a failing lookup yields nothing rather than throwing', async () => {
  assert.deepEqual(await chainsForSubject('No Such Page', {wiki, isTradeable, volumeOf}), []);
  const broken = {async links(t) { if (t === 'Rooftop Agility Course') return PAGES[t]; throw new Error('wiki down'); }};
  const chains = await chainsForSubject('Rooftop Agility Course', {wiki: broken, isTradeable, volumeOf});
  assert.ok(chains.some(c => c.name === 'Amylase crystal'), 'a partial chain is still a real chain');
});

test('news chain: the lookup budget is respected across a whole post', async () => {
  let calls = 0;
  const counting = {async links(t) { calls++; return PAGES[t] ?? null; }};
  await chainsForPost({title: 'New Rooftop Agility Course', body: 'Agility and Gielinor and Ardougne.'},
    {wiki: counting, isTradeable, volumeOf, maxLookups: 2});
  assert.ok(calls <= 2 + 4, `a long post must not walk the wiki unbounded (made ${calls} lookups)`);
});

test('news chain: a camel-case name is never chopped into a shorter subject', () => {
  // The live feed caught this: "RuneScape: Dragonwilds" yielded the subject "Rune", which the wiki
  // resolves to the rune article, dragging Runite ore and every rune type into an announcement
  // about a different game.
  const subjects = extractSubjects('RuneScape: Dragonwilds 1.0 OUT NOW!', 'RuneScape: Dragonwilds releases today!');
  assert.ok(!subjects.includes('Rune'), 'a capitalised word only counts when it actually ends');
  assert.ok(!subjects.includes('Drago'));
});

test('news chain: a second hop through an unrelated page is not evidence', async () => {
  // Also from the live feed: "The Graveyard" reached Raw beef through the Druidic Ritual quest
  // page, which scores full specificity merely by mentioning three items.
  const pages = {
    'The Graveyard': ['Druidic Ritual', 'Marks of grace'],
    'Druidic Ritual': ['Raw beef', 'Raw chicken'],
    'Marks of grace': ['Amylase crystal'],
  };
  const quests = {async links(t) { return pages[t] ?? null; }};
  const chains = await chainsForSubject('The Graveyard', {wiki: quests, isTradeable, volumeOf});
  assert.equal(chains.length, 0, 'nothing on the way shares a word with the subject, so nothing is claimed');
  // The same walk from a subject the middle page IS about still works, which is the case that matters.
  const good = await chainsForSubject('Marks of grace', {wiki: quests, isTradeable, volumeOf});
  assert.equal(good[0].name, 'Amylase crystal', 'a direct link from the subject needs no relevance test');
});

test('news chain: relevance scoring ignores filler words', () => {
  assert.equal(relevanceOf('Rooftop Agility Course', 'Rooftop Agility Course'), 1);
  assert.ok(relevanceOf('Rooftop Agility Course', 'Ardougne Rooftop Course') > 0.5);
  assert.equal(relevanceOf('Rooftop Agility Course', 'Creature of Fenkenstrain'), 0);
  // Nothing but filler on both sides is no evidence of a relationship, so it scores zero rather
  // than a perfect match -- otherwise "The New Update" would look highly relevant to anything.
  assert.equal(relevanceOf('The New Update', 'A New Update'), 0, 'stopwords must never carry a match on their own');
  assert.equal(relevanceOf('', 'Anything'), 0);
});
