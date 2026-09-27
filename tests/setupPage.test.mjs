// The setup page is the only interface that ships WITH the bridge rather than with the browser
// scanner, which is in neither published repository. Without it a plugin-only user had no way to
// import the trade history they already have, and no way to switch on the price archive -- so the
// fill-history and sell-support checks had nothing to read and quietly stayed silent. See the
// 2026-09-27 README entry.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createBridge} from '../bridge/server.mjs';

test('setup page: served to an unlocked browser, gated like every other private view', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-setup-'));
  const port = 51761, app = createBridge({dir, port});
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dir, {recursive: true, force: true}); });
  const get = (p, opts) => fetch(app.origin + p, opts);

  // Locked: the setup page is as private as the scanner, because it can read the player's own logs.
  assert.equal((await get('/setup')).status, 401);
  // The plugin's key is not a browser session and must not open it either.
  assert.equal((await get('/setup', {headers: {Authorization: 'Bearer ' + app.secrets.plugin}})).status, 401);

  const headers = {'Content-Type': 'application/json', Origin: app.origin};
  const unlock = await get('/api/unlock', {method: 'POST', headers, body: JSON.stringify({token: app.secrets.scanner})});
  assert.equal(unlock.status, 200);
  const cookie = unlock.headers.get('set-cookie').split(';')[0];

  const page = await get('/setup', {headers: {Cookie: cookie}});
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  // The page must not leak either key into its own markup.
  assert.ok(!html.includes(app.secrets.scanner), 'the scanner key is never written into the page');
  assert.ok(!html.includes(app.secrets.plugin), 'the plugin key is never written into the page');
  // It has to reach the routes it drives, so a rename on either side should fail this test.
  for (const route of ['/api/exchange-log/scan', '/api/exchange-log/import', '/api/price-archive'])
    assert.ok(html.includes(route), 'the page drives ' + route);
});

test('setup page: the archive can be switched on and off without the scanner', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-setup-arch-'));
  const port = 51762, app = createBridge({dir, port});
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dir, {recursive: true, force: true}); });
  const get = (p, opts) => fetch(app.origin + p, opts);
  const headers = {'Content-Type': 'application/json', Origin: app.origin};
  const unlock = await get('/api/unlock', {method: 'POST', headers, body: JSON.stringify({token: app.secrets.scanner})});
  const cookie = unlock.headers.get('set-cookie').split(';')[0];
  const ui = {...headers, Cookie: cookie, 'X-EVI-UI': '1'};

  // On is the shipped default since 27 Sept, because three checks read this archive and nothing
  // published could switch it on. The page's job is now to let someone turn it OFF, and to say how
  // much has been recorded.
  const before = await (await get('/api/price-archive', {headers: {Cookie: cookie}})).json();
  assert.equal(before.enabled, true);
  assert.equal(typeof before.hoursStored, 'number', 'the page reports this field, so it must exist');

  const on = await (await get('/api/price-archive', {method: 'POST', headers: ui,
    body: JSON.stringify({enabled: true, fiveMinute: {enabled: true}})})).json();
  assert.equal(on.enabled, true);
  // Persisted, so it survives the bridge restarting rather than needing switching on every session.
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).priceArchive.enabled, true);

  const off = await (await get('/api/price-archive', {method: 'POST', headers: ui,
    body: JSON.stringify({enabled: false, fiveMinute: {enabled: false}})})).json();
  assert.equal(off.enabled, false);
});

test('setup page: a scan reports the shape the page reads, with no logs present', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evi-setup-scan-'));
  const port = 51763, app = createBridge({dir, port});
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(dir, {recursive: true, force: true}); });
  const get = (p, opts) => fetch(app.origin + p, opts);
  const headers = {'Content-Type': 'application/json', Origin: app.origin};
  const unlock = await get('/api/unlock', {method: 'POST', headers, body: JSON.stringify({token: app.secrets.scanner})});
  const cookie = unlock.headers.get('set-cookie').split(';')[0];

  const scan = await (await get('/api/exchange-log/scan', {headers: {Cookie: cookie}})).json();
  assert.ok(Array.isArray(scan.files), 'the page maps over files');
  assert.equal(typeof scan.installed, 'boolean', 'the page words its message from this');
  for (const f of scan.files) assert.equal(typeof f.name, 'string', 'the page sends names back, never paths');

  // Naming no file is refused rather than silently importing nothing, which is what the page would
  // do if it ever forgot to pass the list back.
  const empty = await get('/api/exchange-log/import', {method: 'POST',
    headers: {...headers, Cookie: cookie, 'X-EVI-UI': '1'}, body: JSON.stringify({preview: true})});
  assert.equal(empty.status, 400);
});
