// Item pictures, fetched once and then served from this machine.
//
// The scanner page is served under a strict Content-Security-Policy whose img-src is 'self' -- the
// page may not load anything from another host, which is the rule that keeps EVI free of hidden
// outbound requests. So the icons cannot be hotlinked from the wiki, however convenient that would
// be. The bridge fetches each one the first time it is asked for, writes it into data/icons, and
// serves it from there forever after: one request per item for the life of the install, nothing
// leaves the machine afterwards, and the list keeps working with no connection at all.
//
// Nothing here is allowed to be fatal. A picture that cannot be fetched is simply absent -- the
// scanner's <img> removes itself -- and the row reads exactly as it did before icons existed.
import fs from 'node:fs';
import path from 'node:path';

const WIKI = 'https://oldschool.runescape.wiki/images/';
// The wiki serves these; anything else is not something we are willing to write to disk.
const TYPES = {'.png': 'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'};
const MAX_BYTES = 512 * 1024;

/** The wiki's file name for an item, from the mapping the bridge already holds. */
export function iconFileFor(mapping, itemId) {
  if (!Number.isSafeInteger(itemId) || itemId <= 0) return null;
  const rows = Array.isArray(mapping) ? mapping : Object.values(mapping || {});
  const row = rows.find(r => r && r.id === itemId);
  const icon = row && typeof row.icon === 'string' ? row.icon.trim() : '';
  if (!icon) return null;
  // The name comes from a fetched catalogue, so it is treated as untrusted: no separators, no
  // traversal, and an extension we recognise. Anything else is refused rather than sanitised.
  if (icon.includes('/') || icon.includes('\\') || icon.includes('..')) return null;
  const ext = path.extname(icon).toLowerCase();
  if (!TYPES[ext]) return null;
  return icon;
}

/** The URL the wiki serves that file at. Spaces are underscores; quotes are encoded (Verac's helm). */
export function iconUrlFor(iconFile) {
  if (!iconFile) return null;
  return WIKI + encodeURIComponent(iconFile.replace(/ /g, '_')).replace(/'/g, '%27').replace(/"/g, '%22');
}

export function createIconCache({dir, mapping, fetchBuffer, log = () => {}, maxConcurrent = 3} = {}) {
  const iconDir = path.join(dir, 'icons');
  // One promise per item while a fetch is in flight, so a list of 350 rows asking at once produces
  // one request per item rather than 350 for the same picture.
  const inFlight = new Map();
  let running = 0;
  const queue = [];
  const pump = () => {
    while (running < maxConcurrent && queue.length) { running++; queue.shift()(); }
  };
  const schedule = fn => new Promise((resolve, reject) => {
    queue.push(() => fn().then(resolve, reject).finally(() => { running--; pump(); }));
    pump();
  });

  async function get(itemId) {
    const file = iconFileFor(mapping(), itemId);
    if (!file) return null;
    const ext = path.extname(file).toLowerCase();
    const onDisk = path.join(iconDir, itemId + ext);
    try {
      const body = fs.readFileSync(onDisk);
      if (body.length) return {body, contentType: TYPES[ext]};
    } catch {}
    if (inFlight.has(itemId)) return inFlight.get(itemId);
    const job = schedule(async () => {
      const url = iconUrlFor(file);
      const body = await fetchBuffer(url);
      if (!body || !body.length || body.length > MAX_BYTES) return null;
      try {
        fs.mkdirSync(iconDir, {recursive: true});
        fs.writeFileSync(onDisk, body);
      } catch (e) { log('Icon cache could not be written: ' + e.message); }
      return {body, contentType: TYPES[ext]};
    }).catch(e => { log('Icon fetch failed for ' + itemId + ': ' + e.message); return null; })
      .finally(() => inFlight.delete(itemId));
    inFlight.set(itemId, job);
    return job;
  }

  return {get, dir: iconDir};
}
