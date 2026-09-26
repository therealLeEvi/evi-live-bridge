// Small standalone cached-fetch helper for public OSRS Wiki endpoints, used internally
// by the suggestion engine. Same allowlisted-upstream, no-redirect, size-capped posture
// as the /api/market/* proxy in server.mjs; kept separate so it can't regress that path.
import {userAgent} from './userAgent.mjs';

export function createMarketCache() {
  const cache = new Map();
  async function get(url, ttl) {
    let hit = cache.get(url);
    if (!hit || hit.until < Date.now()) {
      const pending = (async () => {
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
