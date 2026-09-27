// "I already have a trade history, it is just in another plugin's log file."
//
// Exchange Logger has been on the Plugin Hub since 2021 writing every Grand Exchange transaction to
// a file. Anyone who has run it is carrying exactly the history EVI needs to be useful on day one:
// the personal-history suggestion tier, the fill measurements and every "how have you been trading"
// view are all quiet until trades exist. This panel finds those files and reads them.
//
// Nothing is imported without being previewed first. The preview says what it found AND what it
// could not account for -- purchases whose placement was never logged, sales with no purchase behind
// them, stock still held -- because an import that quietly rounds those away would put numbers in
// EVI's records that EVI cannot stand behind. The parsing, matching and tax all happen in the
// bridge, on this machine, using EVI's own FIFO matcher (see bridge/exchangeLog.mjs).
(function () {
  const $ = id => document.getElementById(id);
  const gp = n => Number.isFinite(n) ? Math.round(n).toLocaleString('en-GB') : '—';
  const when = ms => Number.isFinite(ms) ? new Date(ms).toLocaleDateString() : '—';
  let found = [];

  async function api(path, body) {
    const res = await fetch(path, body === undefined ? {} : {
      method: 'POST', headers: {'Content-Type': 'application/json', 'X-EVI-UI': '1'}, body: JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || ('the bridge answered ' + res.status));
    return j;
  }

  const chosen = () => Array.from(document.querySelectorAll('#xlogFiles input:checked')).map(i => i.value);

  async function scan() {
    const status = $('xlogStatus');
    status.textContent = 'Looking in your .runelite folder…';
    $('xlogPreview').disabled = true;
    $('xlogCommit').disabled = true;
    $('xlogResult').textContent = '';
    try {
      const j = await api('/api/exchange-log/scan');
      found = j.files || [];
      if (!j.installed) {
        $('xlogFiles').innerHTML = '';
        status.textContent = 'No Exchange Logger folder on this computer. If you have never run that plugin there is nothing to import, and nothing is wrong.';
        return;
      }
      if (!found.length) {
        $('xlogFiles').innerHTML = '';
        status.textContent = 'The folder is there but holds no log files yet: ' + (j.folders || []).join(', ');
        return;
      }
      $('xlogFiles').innerHTML = found.map((f, i) =>
        '<label class="detail" style="display:block"><input type="checkbox" value="' + f.name.replace(/"/g, '&quot;') + '"' +
        (i < 20 ? ' checked' : '') + '> ' + f.name + ' &middot; ' + Math.round(f.bytes / 1024) + ' KB &middot; ' +
        new Date(f.modified).toLocaleDateString() + '</label>').join('');
      status.textContent = found.length + ' log file' + (found.length === 1 ? '' : 's') + ' found in ' + (j.folders || []).join(', ') + '. Nothing is read until you preview.';
      $('xlogPreview').disabled = false;
    } catch (e) {
      status.textContent = 'Could not look: ' + e.message;
    }
  }

  function describe(j) {
    const lines = [];
    lines.push('<b>' + gp(j.flips) + '</b> completed trade' + (j.flips === 1 ? '' : 's') +
      ' across ' + gp(j.items) + ' item' + (j.items === 1 ? '' : 's') +
      ', worth <b class="' + (j.profit >= 0 ? 'good' : 'bad') + '">' + (j.profit >= 0 ? '+' : '') + gp(j.profit) + ' gp</b>' +
      ' (' + gp(j.winners) + ' up, ' + gp(j.losers) + ' down), between ' + when(j.firstTrade) + ' and ' + when(j.lastTrade) + '.');
    // Said as plainly as the total itself. These are the records EVI will not pretend to understand.
    const left = [];
    if (j.stillHeld) left.push(gp(j.stillHeld) + ' purchase' + (j.stillHeld === 1 ? '' : 's') + ' never sold in the log');
    if (j.unmatchedSales) left.push(gp(j.unmatchedSales) + ' sale' + (j.unmatchedSales === 1 ? '' : 's') + ' with no purchase behind them');
    if (j.offersWithoutAStart) left.push(gp(j.offersWithoutAStart) + ' offer' + (j.offersWithoutAStart === 1 ? '' : 's') + ' whose placement the log never recorded');
    if (j.unreadable) left.push(gp(j.unreadable) + ' line' + (j.unreadable === 1 ? '' : 's') + ' this reader did not understand');
    if (left.length) lines.push('<span class="warn">Not counted:</span> ' + left.join('; ') + '. These are left out rather than guessed at.');
    if (j.filesSkipped && j.filesSkipped.length) lines.push('<span class="warn">Skipped:</span> ' + j.filesSkipped.join(', '));
    lines.push('<span class="detail">Imported trades count towards EVI\'s ranking history and your own reports. They are kept separate from the profit EVI measured itself, and the whole import can be undone.</span>');
    return lines.map(l => '<p>' + l + '</p>').join('');
  }

  async function preview() {
    const files = chosen();
    if (!files.length) { $('xlogStatus').textContent = 'Tick at least one file.'; return; }
    $('xlogStatus').textContent = 'Reading ' + files.length + ' file' + (files.length === 1 ? '' : 's') + '…';
    try {
      const j = await api('/api/exchange-log/import', {files, preview: true});
      $('xlogResult').innerHTML = describe(j);
      $('xlogStatus').textContent = 'Preview only — nothing has been added yet.';
      $('xlogCommit').disabled = j.flips < 1;
    } catch (e) {
      $('xlogStatus').textContent = 'Could not read those files: ' + e.message;
    }
  }

  async function commit() {
    const files = chosen();
    if (!files.length) return;
    $('xlogCommit').disabled = true;
    $('xlogStatus').textContent = 'Adding…';
    try {
      const j = await api('/api/exchange-log/import', {files, preview: false});
      $('xlogResult').innerHTML = describe(j);
      $('xlogStatus').textContent = 'Added ' + gp(j.accepted) + ' trade' + (j.accepted === 1 ? '' : 's') +
        (j.duplicates ? ', and skipped ' + gp(j.duplicates) + ' already imported' : '') +
        '. Use "Undo this import" to take them out again.';
      $('xlogUndo').disabled = false;
    } catch (e) {
      $('xlogStatus').textContent = 'Could not add them: ' + e.message;
      $('xlogCommit').disabled = false;
    }
  }

  async function undo() {
    $('xlogUndo').disabled = true;
    try {
      const j = await api('/api/flips/import', {source: 'exchange-logger', remove: true});
      $('xlogStatus').textContent = 'Removed ' + gp(j.removed) + ' imported trade' + (j.removed === 1 ? '' : 's') + '.';
      $('xlogResult').textContent = '';
    } catch (e) {
      $('xlogStatus').textContent = 'Could not undo: ' + e.message;
      $('xlogUndo').disabled = false;
    }
  }

  if ($('xlogScan')) {
    $('xlogScan').onclick = scan;
    $('xlogPreview').onclick = preview;
    $('xlogCommit').onclick = commit;
    $('xlogUndo').onclick = undo;
  }
})();
