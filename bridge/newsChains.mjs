import fs from 'node:fs';
import path from 'node:path';
import {chainsForPost} from './newsChain.mjs';

// The service around bridge/newsChain.mjs: fetches the official Old School news feed, walks the
// wiki for each post, and keeps the answers on disk.
//
// Caching is the whole reason this file exists. One post costs dozens of wiki lookups (62 in the
// live run), which is fine once a day and absurd on every scanner refresh. So: results are stored
// per post and never recomputed, the wiki link cache is shared across posts within a run, and the
// walk happens in the BACKGROUND -- a request returns whatever is already known immediately rather
// than blocking for half a minute on someone else's HTTP.
//
// Deliberately light, in the same way the price archive is: one wiki request at a time, GAP_MS
// apart, a per-post lookup budget, and only the newest few posts ever considered. A news post is
// not time-critical -- if the chains for today's update land an hour from now, nothing is lost.

const FEED = 'https://secure.runescape.com/m=news/latest_news.rss?oldschool=true';
const WIKI_API = 'https://oldschool.runescape.wiki/api.php';
const UA = 'EVI-Live/3.6 (personal local OSRS market scanner; news-to-item linkage)';
const GAP_MS = 400;
const MAX_POSTS = 5;            // newest few; older news is not actionable
const STALE_MS = 12 * 3600 * 1000;
const CACHE_VERSION = 1;

async function httpText(url) {
  const r = await fetch(url, {headers: {'User-Agent': UA}, signal: AbortSignal.timeout(20000), redirect: 'error'});
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const text = await r.text();
  if (text.length > 5000000) throw new Error('Response too large');
  return text;
}

const strip = s => (s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&(?:amp|apos|quot|lt|gt|#39);/g, m => ({'&amp;': '&', '&apos;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&#39;': "'"}[m] || ' '))
  .replace(/\s+/g, ' ').trim();

// The feed is small and fixed-shape; a regex parse avoids a dependency for four fields.
export function parseFeed(xml, {max = MAX_POSTS} = {}) {
  return [...(xml || '').matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, max).map(m => {
    const block = m[1];
    const field = name => {
      const hit = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
      return hit ? strip(hit[1]) : '';
    };
    const link = field('link');
    return {id: field('guid') || link || field('title'), title: field('title'), body: field('description'),
      link, date: field('pubDate')};
  }).filter(p => p.title);
}

export function createNewsChains({dir, fetchText = httpText, itemIndexByName, volumeOf, now = () => Date.now(), log = () => {}, gapMs = GAP_MS} = {}) {
  const file = path.join(dir, 'news-chains.json');
  let cache = {version: CACHE_VERSION, posts: {}, lastRun: null, lastError: null};
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved && saved.version === CACHE_VERSION) cache = saved;
  } catch {}
  let running = false;

  const save = () => { try { fs.writeFileSync(file, JSON.stringify(cache)); } catch (e) { log('News chains: ' + e.message); } };

  // One wiki client per run, so pages shared between posts (very common -- every Agility post walks
  // the same course pages) are fetched once.
  function wikiClient() {
    const seen = new Map();
    return {
      async links(title) {
        if (seen.has(title)) return seen.get(title);
        await new Promise(r => setTimeout(r, gapMs));
        const out = [];
        let cont;
        do {
          const url = WIKI_API + '?' + new URLSearchParams({format: 'json', formatversion: '2', action: 'query',
            prop: 'links', titles: title, plnamespace: '0', pllimit: '500', redirects: '1', ...(cont ? {plcontinue: cont} : {})});
          const json = JSON.parse(await fetchText(url));
          const page = json.query?.pages?.[0];
          if (!page || page.missing) { seen.set(title, null); return null; }
          for (const l of page.links || []) out.push(l.title);
          cont = json.continue?.plcontinue;
        } while (cont);
        seen.set(title, out);
        return out;
      },
    };
  }

  // Walks any posts not already cached. Never throws: a wiki or feed failure is recorded and the
  // previously computed chains stay exactly as they were.
  async function refresh({force = false} = {}) {
    if (running) return status();
    running = true;
    try {
      const posts = parseFeed(await fetchText(FEED));
      const wiki = wikiClient();
      const isTradeable = title => itemIndexByName(String(title)) || null;
      for (const post of posts) {
        if (!force && cache.posts[post.id]) continue;
        const chains = await chainsForPost(post, {wiki, isTradeable, volumeOf});
        cache.posts[post.id] = {title: post.title, link: post.link, date: post.date,
          computedAt: now(), chains};
        save();
      }
      // Forget anything no longer in the feed, so this cannot grow without bound.
      const live = new Set(posts.map(p => p.id));
      for (const id of Object.keys(cache.posts)) if (!live.has(id)) delete cache.posts[id];
      cache.lastRun = now();
      cache.lastError = null;
      save();
    } catch (e) {
      cache.lastError = e.message;
      log('News chains: ' + e.message);
      save();
    } finally { running = false; }
    return status();
  }

  function status() {
    const posts = Object.values(cache.posts).sort((a, b) => (b.computedAt || 0) - (a.computedAt || 0));
    return {posts, lastRun: cache.lastRun, lastError: cache.lastError, running,
      stale: !cache.lastRun || (now() - cache.lastRun) > STALE_MS};
  }

  // What a request calls: answers from cache at once, and kicks off a walk in the background when
  // the cache is stale. Never makes the caller wait on the wiki.
  function get() {
    const s = status();
    if (s.stale && !running) refresh().catch(() => {});
    return s;
  }

  return {get, refresh, status, file};
}
