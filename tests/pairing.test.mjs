// The bridge hands the plugin its key, so nobody has to copy one.
//
// The two steps this removes are the only two anybody got wrong, and they produced two separate user
// bug reports: picking the RuneLite plugin key out of a console that prints two similar-looking keys
// on adjacent lines, and pasting it into the sidebar. See bridge/pairing.mjs for why this does not
// touch the 127.0.0.1 rule -- it is a local file write between two halves of one installation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pairingPlan, pluginKeyPath, pluginKeyDir} from '../bridge/pairing.mjs';

const KEY = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const HOME = '/home/player';
// A disk described as a plain object, so every rule below is checked without touching a real one.
const disk = files => ({
  exists: p => Object.prototype.hasOwnProperty.call(files, p),
  read: p => files[p],
});

test('pairing: the path is the one the plugin actually reads', () => {
  // internalName is "evi-live" in @PluginDescriptor, and getPluginDirectory() resolves to
  // .runelite/plugin-data/<internalName>/. If either moves, this is the thing that has to move with
  // it -- the bridge would otherwise write a key nothing reads, and fail silently.
  assert.equal(pluginKeyPath(HOME), '/home/player/.runelite/plugin-data/evi-live/plugin-key.txt');
  assert.equal(pluginKeyDir(HOME), '/home/player/.runelite/plugin-data/evi-live');
  assert.equal(pluginKeyPath('C:\\Users\\p', '\\'), 'C:\\Users\\p\\.runelite\\plugin-data\\evi-live\\plugin-key.txt');
});

test('pairing: writes the key when the plugin has none', () => {
  const d = disk({'/home/player/.runelite': true});
  const plan = pairingPlan({home: HOME, key: KEY, ...d});
  assert.equal(plan.write, true);
  assert.equal(plan.path, pluginKeyPath(HOME));
  assert.match(plan.reason, /paired the RuneLite plugin automatically/);
});

test('pairing: leaves an already-correct key alone', () => {
  // Idempotent on purpose: the bridge runs at every login, and rewriting an identical file every
  // time would be noise in the console line the player reads.
  const d = disk({'/home/player/.runelite': true, [pluginKeyPath(HOME)]: KEY});
  const plan = pairingPlan({home: HOME, key: KEY, ...d});
  assert.equal(plan.write, false);
  assert.match(plan.reason, /already paired/);
});

test('pairing: REPLACES a key that does not match this bridge', () => {
  // The bridge issues the key, so the plugin's copy is a cache of it. A mismatch means the cached
  // one is stale or mistyped -- exactly the case that produced "Companion app out of date" against a
  // bundle downloaded minutes earlier. Only one bridge can hold 127.0.0.1:51743, so there is no
  // legitimate way to be holding a different valid key.
  const d = disk({'/home/player/.runelite': true, [pluginKeyPath(HOME)]: OTHER});
  const plan = pairingPlan({home: HOME, key: KEY, ...d});
  assert.equal(plan.write, true);
  assert.match(plan.reason, /stale or mistyped/);

  // A key saved with a BOM, odd casing or stray whitespace is the same key, not a different one --
  // PairingKey.normalize on the plugin side accepts all three, so this must agree with it or the
  // bridge would rewrite the file on every single startup.
  for (const stored of ['\uFEFF' + KEY, KEY.toUpperCase(), '  ' + KEY + '\n']) {
    const same = pairingPlan({home: HOME, key: KEY, ...disk({'/home/player/.runelite': true, [pluginKeyPath(HOME)]: stored})});
    assert.equal(same.write, false, `a key stored as ${JSON.stringify(stored.slice(0, 12))}... is the same key`);
  }
});

test('pairing: never invents RuneLite', () => {
  // No .runelite means RuneLite is not installed for this user, and the bridge has no business
  // creating its folder layout on a guess. It creates plugin-data/evi-live INSIDE an existing
  // .runelite, which merely anticipates a plugin the player is being told to install.
  const plan = pairingPlan({home: HOME, key: KEY, ...disk({})});
  assert.equal(plan.write, false);
  assert.match(plan.reason, /RuneLite is not installed/);
});

test('pairing: refuses to write anything that is not a real key', () => {
  // Writing a malformed key would pair the plugin to a 401 and leave the player worse off than the
  // manual step, so the guard is on the way IN, not on the way out.
  const d = disk({'/home/player/.runelite': true});
  for (const bad of [null, undefined, '', 'not-a-key', KEY.slice(0, 63), KEY + 'a', KEY.replace('a', 'z')]) {
    const plan = pairingPlan({home: HOME, key: bad, ...d});
    assert.equal(plan.write, false, `must refuse ${JSON.stringify(String(bad).slice(0, 20))}`);
  }
  // And no home directory at all is a quiet no-op, not a crash.
  assert.equal(pairingPlan({home: '', key: KEY, ...d}).write, false);
});

test('pairing: an unreadable existing file is replaced rather than trusted', () => {
  // If the file cannot be read -- permissions, a half-written file, a directory where a file should
  // be -- the safe answer is to write a key known to be good, not to leave the player stuck with
  // something nothing can verify.
  const plan = pairingPlan({home: HOME, key: KEY,
    exists: () => true,
    read: () => { throw new Error('EACCES'); }});
  assert.equal(plan.write, true);
});
