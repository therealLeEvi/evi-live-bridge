// Hand the plugin its key instead of asking a person to copy one.
//
// WHY THIS EXISTS. Setup was seven steps, and two of them were the only ones anybody got wrong:
// find the right key in the console window, and paste it into the sidebar. The companion app prints
// TWO keys on adjacent lines -- a Scanner key and a RuneLite plugin key -- and taking the wrong one
// produces a 401 that used to be reported as "Bridge unreachable", pointing the player at the one
// thing that was not broken. That single confusion produced two separate user bug reports and a
// whole section of KNOWN-ISSUES.md.
//
// None of it is necessary. The plugin can only ever talk to 127.0.0.1, so the bridge and the plugin
// are on the same machine BY DEFINITION, and the plugin's key lives in a known file:
// `.runelite/plugin-data/evi-live/plugin-key.txt`. The bridge already locates `.runelite` for the
// Exchange Logger import. So it can simply write the key there and let the plugin pick it up.
//
// THE 127.0.0.1 RULE IS UNTOUCHED, and that is worth being explicit about because it is the rule
// this project values above any feature. This is a LOCAL FILE WRITE between two halves of the same
// installation. No request is made, no port is opened, nothing is sent anywhere. The plugin's own
// network behaviour does not change at all.
//
// THE DECISION IS PURE AND THE I/O IS THE CALLER'S, following resolveLogFile in exchangeLog.mjs:
// the rules below are the part worth testing, and they can be tested without a disk.
//
// CONSERVATIVE BY DESIGN -- it never creates `.runelite` itself. If that folder is absent, RuneLite
// is not installed for this user and the bridge has no business inventing its layout. It will create
// `plugin-data/evi-live/` inside an existing `.runelite`, because that merely anticipates a plugin
// the player is being told to install, and a stray folder is inert if they never do.

/** `.runelite/plugin-data/evi-live/plugin-key.txt` -- internalName is "evi-live", set in @PluginDescriptor. */
export function pluginKeyPath(home, sep = '/') {
  return [home, '.runelite', 'plugin-data', 'evi-live', 'plugin-key.txt'].join(sep);
}

/** The directory that file sits in, which the caller may have to create. */
export function pluginKeyDir(home, sep = '/') {
  return [home, '.runelite', 'plugin-data', 'evi-live'].join(sep);
}

/**
 * What the bridge should do about the plugin's key file, decided without touching a disk.
 *
 * `exists(path)` and `read(path)` are injected so the rules can be tested directly; the caller
 * supplies real fs calls. Returns `{write, path, reason}` -- `write` false means leave it alone, and
 * `reason` is phrased for the console line the player actually reads.
 *
 * A key that is present but DIFFERENT is replaced, not left. The bridge issues the key, so the
 * plugin's copy is a cache of it; a mismatch means the cached one is stale or was mistyped, which is
 * precisely the failure this exists to end. There is no legitimate way for a player to hold a
 * different valid key, because only one bridge can hold 127.0.0.1:51743 on a machine.
 */
export function pairingPlan({home, key, exists, read, sep = '/'}) {
  if (!home) return {write: false, path: null, reason: 'no home directory, so no .runelite to look in'};
  if (!/^[a-f0-9]{64}$/.test(String(key || ''))) return {write: false, path: null, reason: 'the key is not a 64-character hex string'};
  const runelite = [home, '.runelite'].join(sep);
  const path = pluginKeyPath(home, sep);
  // Never invent RuneLite's folder: its absence means RuneLite is not installed for this user.
  if (!exists(runelite)) return {write: false, path, reason: 'RuneLite is not installed for this user'};
  if (!exists(path)) return {write: true, path, reason: 'paired the RuneLite plugin automatically'};
  let current = null;
  try { current = String(read(path) || '').replace(/^﻿/, '').trim().toLowerCase(); } catch { current = null; }
  if (current === key) return {write: false, path, reason: 'the RuneLite plugin is already paired'};
  return {write: true, path, reason: 'replaced a stale or mistyped key in the RuneLite plugin'};
}
