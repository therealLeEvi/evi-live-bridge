// Which suggestions the player actually took, observed rather than guessed.
//
// Why this exists. EVI's track record was assembled by INFERENCE: an offer for the same item
// appearing within two hours of a suggestion counted as "you followed EVI". The tool that does it
// says so itself -- an item the player was going to trade anyway counts as following EVI. That is
// fine for a rough read and useless as evidence, because it cannot separate "EVI made this profit"
// from "this profit happened while EVI was running". Measured on 29 Sept 2026 the difference is not
// academic: 302 of 1,659 suggestions looked "acted on", and nobody could say how many really were.
//
// novi's goal for EVI is that a user can trust a suggestion without checking it first, and a claim
// like "of the suggestions taken, X% profited, the worst was Y" is the only form of that trust which
// survives contact with someone else's GP. It cannot be made honestly from an inference.
//
// The record is append-only and reversible, like blocking an item or marking one personal use: a
// mistaken tap must be undoable, or the player learns not to use the button. The newest record for
// an id wins, so undoing is just another append and nothing is ever rewritten in place.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 8 * 1024 * 1024;

export function createAcceptances(dir) {
  const file = path.join(dir, 'suggestion-accepted.jsonl');
  // id -> the newest record for it. Loaded once; the file is small (one line per button press).
  const byId = new Map();
  try {
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        try { const r = JSON.parse(line); if (r && r.id) byId.set(r.id, r); } catch {}
      }
    }
  } catch {}

  // `accepted:false` is a real record, not a deletion: knowing a player took a suggestion and then
  // took it back is worth more than the row quietly disappearing.
  function accept({id, account, itemId, accepted = true, now = Date.now()}) {
    if (!id || typeof id !== 'string') return {ok: false, error: 'A suggestion id is required'};
    const record = {id, account: account || null, itemId: Number.isFinite(itemId) ? itemId : null,
      accepted: !!accepted, at: now};
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
      fs.appendFileSync(file, JSON.stringify(record) + '\n');
    } catch { return {ok: false, error: 'Could not record it'}; }
    byId.set(id, record);
    return {ok: true, id, accepted: record.accepted};
  }

  const wasAccepted = id => !!(id && byId.get(id)?.accepted);
  const acceptedAt = id => (id && byId.get(id)?.accepted) ? byId.get(id).at : null;
  const count = () => [...byId.values()].filter(r => r.accepted).length;

  return {accept, wasAccepted, acceptedAt, count, file};
}
