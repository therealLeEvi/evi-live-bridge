// Links an Old School news post to the tradeable items an update actually touches, by following
// the chain of game mechanics rather than matching item names in the article.
//
// The motivating example, which no keyword matcher can solve: a post announces a new Agility
// course. The words "amylase crystal" appear nowhere in it. Getting there means knowing that an
// Agility course rewards marks of grace, and that marks of grace buy amylase crystals -- two hops
// through game knowledge. Probed against the real wiki, that exact path exists in its link graph:
//
//   "Agility course" -> "Rooftop Agility Courses" -> "Amylase crystal"
//
// So the chain is walked over the OSRS Wiki's own links, at most two hops, and what is reported is
// the PATH, not a prediction. EVI does not claim the price will move or in which direction -- it
// says "this update touches this item, here is how it connects", and the player judges. That is
// deliberate: an update's price effect depends on whether it adds supply or demand, how many players
// bother, and what was already priced in, none of which a link graph knows.
//
// Two hops is also where the noise lives, and the probes measured it. From "Agility course" a naive
// two-hop walk returns 50 items, including "Brimhaven -> Beer glass": a location page mentioning a
// tavern. Three controls, each justified by what the probing actually showed:
//
//  1. PAGE SPECIFICITY. "Rooftop Agility Courses" links to 2 tradeable items; "Mark of Grace" to 4;
//     a navigation box links to dozens. A page that mentions a handful of items is telling us
//     something, one that mentions forty is a table of contents. Pages above MAX_PAGE_ITEMS are
//     dropped, and specificity scores the rest.
//  2. SUBJECT RELEVANCE. An intermediate page sharing meaningful words with the news subject
//     ("Rooftop Agility Courses" for "Agility course") is on topic; "Creature of Fenkenstrain" is
//     not. Scored rather than filtered, so a genuine but differently-named link still surfaces.
//  3. IT HAS TO TRADE. A chain ending at an item nobody buys is a curiosity. Volume is supplied by
//     the caller, and an item with none is dropped.
//
// A filter that was tested and REJECTED: requiring the item's own page to link back to the subject.
// It sounds like stronger evidence and it discards the right answer -- "Amylase crystal" does not
// link back to "Agility", so mutual linking would have thrown out the one item this whole feature
// exists to find. Measured, not assumed.

export const MAX_PAGE_ITEMS = 12;     // above this, an intermediate page is a navigation box
export const MAX_HOPS = 2;
export const DEFAULT_MAX_RESULTS = 8;
// Every hop is a weaker inference, and without this the ranking gets it backwards. Measured on the
// live wiki with a "New Rooftop Agility Course" post: Amylase crystal, linked DIRECTLY from the
// subject's own page, was ranked fifth, below Regen bracelet and Summer pie -- items that merely
// happen to be the sole tradeable mention on a sibling course's page, which scores full specificity.
// An item the update's own page names outranks one reached by walking somewhere else first.
export const SECOND_HOP_PENALTY = 0.6;
// A long post can otherwise walk hundreds of pages. The walk stops here and returns what it found,
// which is honest -- a partial chain is still a real chain.
export const DEFAULT_MAX_LOOKUPS = 60;

// Words too common in page titles to count as evidence of relevance.
const STOPWORDS = new Set(['the', 'of', 'and', 'a', 'an', 'in', 'to', 'for', 'new', 'old', 'osrs',
  'update', 'updates', 'game', 'players', 'player', 'week', 'this', 'with', 'now', 'out', 'is', 'are',
  'we', 'you', 'your', 'our', 'more', 'all', 'from', 'on', 'at', 'by', 'it', 'be', 'has', 'have']);

const words = s => (s || '').toLowerCase().match(/[a-z']+/g)?.filter(w => w.length > 2 && !STOPWORDS.has(w)) ?? [];

// Candidate wiki subjects from a news title and body. Capitalised runs are the workable signal --
// OSRS content is named in title case ("Rooftop Agility Course", "Wilderness Boss Rework") -- plus
// any skill named anywhere, since a post often says "Agility" in passing while the mechanic it
// changes is the real subject. Deliberately generous: a subject that resolves to no wiki page costs
// one cached lookup and disappears, while a missed subject loses the chain entirely.
export const SKILLS = ['Agility', 'Attack', 'Construction', 'Cooking', 'Crafting', 'Defence',
  'Farming', 'Firemaking', 'Fishing', 'Fletching', 'Herblore', 'Hitpoints', 'Hunter', 'Magic',
  'Mining', 'Prayer', 'Ranged', 'Runecraft', 'Slayer', 'Smithing', 'Strength', 'Thieving', 'Woodcutting'];

export function extractSubjects(title, body = '', {maxSubjects = 12} = {}) {
  const text = `${title || ''}. ${body || ''}`.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
  const found = new Map(); // lowercase -> original, first spelling wins
  // Capitalised runs of 1-4 words, not at the very start of a sentence on their own (which is just
  // ordinary capitalisation).
  // The negative lookahead matters: without it, "RuneScape: Dragonwilds" yields the subject "Rune",
  // which the wiki happily resolves to the rune article and which then dragged Runite ore and every
  // rune type into an announcement about a different game entirely. A capitalised word only counts
  // when it actually ends, rather than running into another capital.
  for (const m of text.matchAll(/\b([A-Z][a-z']+(?![A-Za-z])(?:\s+(?:of|the|and)?\s*[A-Z][a-z']+(?![A-Za-z])){0,3})/g)) {
    const phrase = m[1].replace(/\s+/g, ' ').trim();
    if (words(phrase).length === 0) continue;
    if (!found.has(phrase.toLowerCase())) found.set(phrase.toLowerCase(), phrase);
  }
  for (const skill of SKILLS) {
    if (new RegExp(`\\b${skill}\\b`, 'i').test(text) && !found.has(skill.toLowerCase())) found.set(skill.toLowerCase(), skill);
  }
  // Longer phrases first: "Rooftop Agility Course" is a better seed than "Rooftop".
  return [...found.values()].sort((a, b) => b.length - a.length).slice(0, maxSubjects);
}

// How much an intermediate page looks like it belongs to this subject: the share of the subject's
// own meaningful words that appear in the page title. 1 when the page IS the subject.
export function relevanceOf(subject, pageTitle) {
  const want = words(subject), have = new Set(words(pageTitle));
  if (!want.length) return 0;
  return want.filter(w => have.has(w)).length / want.length;
}

// A page mentioning three items says more per item than one mentioning eleven.
const specificityOf = itemCount => itemCount > 0 ? 1 / Math.sqrt(itemCount) : 0;

// wiki.links(title) -> array of linked page titles (redirects resolved), or null when no such page.
// isTradeable(title) -> the item record for a tradeable item of exactly that name, else null.
// volumeOf(itemId) -> recent trading volume, or null/0 when it does not trade.
//
// Returns one entry per item with the path that reached it and why it scored as it did. Never
// throws on a lookup failure: a page that cannot be fetched is skipped, because a partial chain is
// still useful and an update the wiki has not documented yet is normal.
export async function chainsForSubject(subject, {wiki, isTradeable, volumeOf, maxPageItems = MAX_PAGE_ITEMS,
  maxResults = DEFAULT_MAX_RESULTS, budget} = {}) {
  const seedLinks = await wiki.links(subject).catch(() => null);
  if (!seedLinks) return [];
  const results = new Map();
  const consider = (item, path, pageItemCount, pageTitle, hops) => {
    const record = isTradeable(item);
    if (!record) return;
    const volume = volumeOf ? volumeOf(record.id) : null;
    // An item that does not trade cannot be traded on the news, whatever the wiki says. A volume of
    // null means the caller simply has no figure to hand, which must never be read as "it does not
    // trade" -- same fail-open rule as every other unknown in this project.
    if (volumeOf && volume != null && !(volume > 0)) return;
    const relevance = pageTitle === subject ? 1 : relevanceOf(subject, pageTitle);
    const score = specificityOf(pageItemCount) * (0.35 + 0.65 * relevance) * (hops > 1 ? SECOND_HOP_PENALTY : 1);
    const existing = results.get(record.id);
    if (!existing || existing.score < score)
      results.set(record.id, {itemId: record.id, name: record.name, path: [subject, ...path], score, relevance, hops, via: pageTitle, volume: volume ?? null});
  };

  // Hop 1: items the subject's own page links to. The subject page is never rejected for breadth --
  // it is what the news is about, so its own mentions count even if it mentions many.
  const direct = seedLinks.filter(t => isTradeable(t));
  for (const item of direct) consider(item, [item], Math.max(1, direct.length), subject, 1);

  // Hop 2: through each non-item page, subject to the specificity and relevance controls.
  if (MAX_HOPS >= 2) {
    const pages = seedLinks.filter(t => !isTradeable(t));
    // Most relevant-looking pages first, so a lookup budget spends itself on the likeliest chains
    // rather than on whatever the wiki happened to list alphabetically.
    pages.sort((a, b) => relevanceOf(subject, b) - relevanceOf(subject, a));
    for (const page of pages) {
      if (budget && budget.spent >= budget.max) break;
      if (budget) budget.spent++;
      const links = await wiki.links(page).catch(() => null);
      if (!links) continue;
      const items = links.filter(t => isTradeable(t));
      // A navigation box, not a statement about this update.
      if (!items.length || items.length > maxPageItems) continue;
      // A second hop through a page with NOTHING in common with the subject is where the real feed
      // fell apart: "The Graveyard" reached Raw beef via the Druidic Ritual quest page, and every
      // such page scores full specificity because it happens to mention three items. One hop from
      // the subject is evidence on its own; two hops need the middle page to be on topic.
      if (relevanceOf(subject, page) <= 0) continue;
      for (const item of items) consider(item, [page, item], items.length, page, 2);
    }
  }
  return [...results.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
}

// One plain sentence naming the path, which is the entire point: the player can see the reasoning
// and dismiss it. Never states a direction or a size of move, because nothing here knows either.
export function chainSentence(chain, headline) {
  if (!chain) return null;
  const path = chain.path.join(' -> ');
  return `${chain.name} is connected to "${headline}" through ${path}. That is a link in the game's own wiki, not a prediction -- EVI has no view on whether this moves the price, or which way.`;
}

// Whole-post convenience: subjects, then chains, merged and ranked. Subjects are tried in order and
// the walk stops once maxResults distinct items have been found, which keeps a long post from
// costing hundreds of wiki lookups.
export async function chainsForPost({title, body}, {wiki, isTradeable, volumeOf, maxResults = DEFAULT_MAX_RESULTS,
  maxSubjects = 6, maxLookups = DEFAULT_MAX_LOOKUPS} = {}) {
  const subjects = extractSubjects(title, body, {maxSubjects});
  const budget = {spent: 0, max: maxLookups};
  const byItem = new Map();
  for (const subject of subjects) {
    if (byItem.size >= maxResults || budget.spent >= budget.max) break;
    for (const chain of await chainsForSubject(subject, {wiki, isTradeable, volumeOf, maxResults, budget})) {
      const existing = byItem.get(chain.itemId);
      if (!existing || existing.score < chain.score) byItem.set(chain.itemId, chain);
    }
  }
  return [...byItem.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
}
