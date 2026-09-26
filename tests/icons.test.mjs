import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {iconFileFor, iconUrlFor, createIconCache} from '../bridge/icons.mjs';

const mapping = [
  {id: 4151, name: 'Abyssal whip', icon: 'Abyssal whip.png'},
  {id: 4757, name: "Verac's helm", icon: "Verac's helm.png"},
  {id: 9001, name: 'No picture', icon: null},
  {id: 9002, name: 'Escaping', icon: '../../secrets.png'},
  {id: 9003, name: 'Wrong type', icon: 'payload.svg'},
];
const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-icons-'));
  t.after(() => { try { fs.rmSync(dir, {recursive: true, force: true}); } catch {} });
  return dir;
};

test('an item resolves to the wiki file name, and anything suspect resolves to nothing', () => {
  assert.equal(iconFileFor(mapping, 4151), 'Abyssal whip.png');
  assert.equal(iconFileFor(mapping, 9001), null, 'an item with no picture asks for nothing');
  // The catalogue is fetched, so its file names are untrusted input, not trusted configuration.
  assert.equal(iconFileFor(mapping, 9002), null, 'a name that climbs out of the folder is refused');
  assert.equal(iconFileFor(mapping, 9003), null, 'only picture types the wiki serves are accepted');
  assert.equal(iconFileFor(mapping, 12345), null, 'an item not in the catalogue asks for nothing');
  assert.equal(iconFileFor(mapping, -1), null);
});

test('the wiki url uses underscores and encodes the apostrophes item names are full of', () => {
  assert.equal(iconUrlFor('Abyssal whip.png'), 'https://oldschool.runescape.wiki/images/Abyssal_whip.png');
  const v = iconUrlFor("Verac's helm.png");
  assert.ok(v.includes('%27'), 'an apostrophe must not sit raw in the url: ' + v);
  assert.ok(!v.includes("'"), v);
});

test('a picture is fetched once, written to disk, and served from there afterwards', async t => {
  const dir = tmp(t);
  let fetches = 0;
  const cache = createIconCache({dir, mapping: () => mapping,
    fetchBuffer: async () => { fetches++; return Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); }});
  const first = await cache.get(4151);
  assert.equal(first.contentType, 'image/png');
  assert.equal(fetches, 1);
  assert.ok(fs.existsSync(path.join(dir, 'icons', '4151.png')), 'the picture is kept on this machine');
  const second = await cache.get(4151);
  assert.equal(fetches, 1, 'the second ask must not reach the wiki at all');
  assert.deepEqual(Array.from(second.body), Array.from(first.body));
});

test('a list asking for the same picture at once produces one fetch, not one per row', async t => {
  const dir = tmp(t);
  let fetches = 0;
  const cache = createIconCache({dir, mapping: () => mapping,
    fetchBuffer: async () => { fetches++; await new Promise(r => setTimeout(r, 5)); return Buffer.from([1, 2, 3]); }});
  const all = await Promise.all([cache.get(4151), cache.get(4151), cache.get(4151)]);
  assert.equal(fetches, 1, 'one request for one picture, however many rows want it');
  assert.ok(all.every(x => x && x.body.length === 3));
});

test('a picture that cannot be fetched is absent, never fatal and never cached', async t => {
  const dir = tmp(t);
  let fetches = 0;
  const cache = createIconCache({dir, mapping: () => mapping,
    fetchBuffer: async () => { fetches++; throw new Error('the wiki answered 404'); }, log: () => {}});
  assert.equal(await cache.get(4151), null, 'a failure reads as no picture, not as an error');
  assert.ok(!fs.existsSync(path.join(dir, 'icons', '4151.png')), 'nothing broken is written to disk');
  assert.equal(await cache.get(4151), null);
  assert.equal(fetches, 2, 'a failed fetch is not remembered as a permanent answer');
});

test('an implausibly large file is refused rather than written', async t => {
  const dir = tmp(t);
  const cache = createIconCache({dir, mapping: () => mapping,
    fetchBuffer: async () => Buffer.alloc(600 * 1024, 7)});
  assert.equal(await cache.get(4151), null);
  assert.ok(!fs.existsSync(path.join(dir, 'icons', '4151.png')));
});
