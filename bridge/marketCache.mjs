// Small standalone cached-fetch helper for public OSRS Wiki endpoints, used internally
// by the suggestion engine. Same allowlisted-upstream, no-redirect, size-capped posture
// as the /api/market/* proxy in server.mjs; kept separate so it can't regress that path.
import {userAgent} from './userAgent.mjs';

// fetchText(url) overrides the upstream read, exactly as createPriceArchive's own fetchText does and
// for the same reason: a test must be able to drive the suggestion engine from fixed prices rather
// than from whatever the live market happens to be doing. It defaults to the real fetch, so no caller
// that does not pass one behaves any differently, and nothing reads it from a request.
export function createMarketCache({fetchText = null} = {}) {
  const cache = new Map();
  async function get(url, ttl) {
    let hit = cache.get(url);
    if (!hit || hit.until < Date.now()) {
      const pending = fetchText ? Promise.resolve(fetchText(url)) : (async () => {
        const r = await fetch(url, {
          headers: {'User-Agent': userAgent('live prices')},
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        if (!r.ok) throw new Error('Public source returned HTTP ' + r.status);
        const text = await r.text();
        if (text.length > 10000000) throw new Error('Public response too large');
        return text;
      })();
      hit = {until: Date.now() + ttl, pending};
      cache.set(url, hit);
      pending.catch(() => cache.delete(url));
    }
    return hit.pending;
  }
  return {get};
}
