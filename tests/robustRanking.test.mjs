// The market tier is what a player with no history gets, which since the Plugin Hub listing means
// every new user. It ranks on `latest`, where `high` is the last price ANYONE paid and `low` the last
// price anyone sold at, and its score is built on `high - low - tax`. Maximising the gap between two
// single prints is an argmax over outliers: the item whose last print was a fluke is exactly the one
// that wins.
//
// Measured live on 28 September 2026 -- an Ape atoll teleport (tablet) was ranked top of the whole
// catalogue on a `latest.high` of 28,756, while every hourly average that day sat between 6,000 and
// 6,300 and 1,115 buyers over twelve hours had paid an average of 6,379. The trade was worth 4,641,
// not the 92,356 it was ranked and headlined on.
//
// These tests pin the fix: rank on a steady price, quote the live one, and clear every bar on both.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {robustPrices, computeMarketSuggestion, ROBUST_PRICE_HOURS, MIN_ROBUST_HOURS} from '../bridge/suggestions.mjs';

// Archive buckets are {ts, d:{itemId:[avgHigh, highVol, avgLow, lowVol]}}.
const bucket = (ts, rows) => ({ts, d: rows});
const hours = (n, rows) => Array.from({length: n}, (_, i) => bucket(1000 * 3600 + i * 3600, rows(i)));

test('robustPrices takes a median per side, so one freak hour moves it by a rank not by its size', () => {
  // Twenty-three ordinary hours around 6,000/5,300 and one hour where a single buyer paid 28,756 --
  // the tablet's real shape. A mean would be dragged upward by roughly a thousand gp; the median must
  // not move at all beyond one position.
  const buckets = hours(24, i => ({'19631': i === 23 ? [28756, 1, 5092, 40] : [6000 + i, 100, 5300 + i, 90]}));
  const r = robustPrices(buckets);
  assert.ok(r, 'a full day of hours is a reading');
  assert.ok(r['19631'].high < 6100, `the outlier must not carry the estimate, got ${r['19631'].high}`);
  assert.ok(r['19631'].low > 5000 && r['19631'].low < 5400);
});

test('too few hours is one print wearing a median\'s clothes, and is left out', () => {
  // Left OUT rather than returned, so computeMarketSuggestion falls back to `latest` for that item and
  // ranks it exactly as it does today. Fail open: too little data must never invent a constraint.
  const thin = hours(MIN_ROBUST_HOURS - 1, () => ({'5': [100, 10, 60, 10]}));
  assert.equal(robustPrices(thin), null, `${MIN_ROBUST_HOURS - 1} hours is not a reading`);
  const enough = hours(MIN_ROBUST_HOURS, () => ({'5': [100, 10, 60, 10]}));
  assert.ok(robustPrices(enough)?.['5'], `${MIN_ROBUST_HOURS} hours is`);
});

test('no archive at all is not an opinion', () => {
  for (const nothing of [null, undefined, [], [{ts: 1, d: {}}]])
    assert.equal(robustPrices(nothing), null, JSON.stringify(nothing));
});

test('only hours inside the window count, however much older data is handed over', () => {
  // The window is measured back from the NEWEST bucket, not from wall-clock now, so a replay or a
  // backfill that lands a batch of old hours cannot silently widen it.
  const old = hours(200, () => ({'5': [999999, 10, 1, 10]}));
  const recent = Array.from({length: ROBUST_PRICE_HOURS}, (_, i) =>
    bucket(old[old.length - 1].ts + (i + 1) * 3600, {'5': [100, 10, 60, 10]}));
  const r = robustPrices([...old, ...recent]);
  assert.equal(r['5'].high, 100, 'the ancient 999,999 hours must be outside the window entirely');
});

// One liquid item whose last print is a fluke, and one whose steady margin is real but smaller.
// Ranked on the last print the fluke wins; ranked on the median it must not.
const ITEMS = [
  {id: 19631, name: 'Ape atoll teleport (tablet)', limit: 10000, members: false},
  {id: 561, name: 'Nature rune', limit: 12000, members: false},
];
// The rune is the deeper market, which is what lets it win once the tablet stops being flattered: at
// equal quantity an item eight times the price wins on absolute margin whatever the ranking uses, so
// a fair test has to let the cheaper item buy the size its own liquidity supports.
const VOLUMES = {
  '19631': {highPriceVolume: 500, lowPriceVolume: 500},
  '561': {highPriceVolume: 5000, lowPriceVolume: 5000},
};
const now = Date.now();
const LATEST = {
  '19631': {high: 28756, low: 5092, highTime: now / 1000, lowTime: now / 1000}, // the freak print
  '561': {high: 700, low: 600, highTime: now / 1000, lowTime: now / 1000},      // steady and real
};
const OPTS = {maxSpend: 50_000_000, targetDurationMinutes: 720, now};

test('without a steady reading the freak print still wins -- which is the bug, pinned', () => {
  const pick = computeMarketSuggestion(ITEMS, LATEST, VOLUMES, OPTS);
  assert.equal(pick.itemId, 19631, 'this is what every market-tier user got before 28 Sept 2026');
});

test('ranked on the steady price, the item with a real margin wins instead', () => {
  // The tablet's true spread over the day is 5,600 vs 5,200, not the 28,756 vs 5,092 the freak print
  // implies -- a real edge, but one the rune's depth beats outright. Nothing about the rune changed;
  // the tablet simply stops being flattered by one print.
  const rankPrices = {'19631': {high: 5600, low: 5200}, '561': {high: 800, low: 600}};
  const pick = computeMarketSuggestion(ITEMS, LATEST, VOLUMES, {...OPTS, rankPrices});
  assert.equal(pick.itemId, 561, 'the steady margin must win');
});

test('the price quoted is still the live one, never the median nobody is paying', () => {
  // The median is a ranking signal. Quoting it would be a different change -- an unmeasured one --
  // and the player can only transact against the live market.
  const rankPrices = {'19631': {high: 6050, low: 5300}, '561': {high: 690, low: 610}};
  const pick = computeMarketSuggestion(ITEMS, LATEST, VOLUMES, {...OPTS, rankPrices});
  assert.equal(pick.buyPrice, LATEST[String(pick.itemId)].low, 'buy at the live price');
  assert.equal(pick.sellPrice, LATEST[String(pick.itemId)].high, 'sell at the live price');
});

test('an item has to clear the bar on BOTH views, not whichever one flatters it', () => {
  // Robust alone would let EVI offer a spread that has since closed. Here the day's median says there
  // is a healthy margin, but right now the live spread is inverted -- nothing to offer.
  const closed = {'561': {high: 601, low: 600, highTime: now / 1000, lowTime: now / 1000}};
  const stillGood = {'561': {high: 700, low: 600}};
  const pick = computeMarketSuggestion([ITEMS[1]], closed, VOLUMES, {...OPTS, rankPrices: stillGood});
  assert.equal(pick, null, 'a closed live spread is not offerable however good the median looks');

  // And the other way: the live print looks wonderful, the day says otherwise.
  const flukeOnly = {'19631': {high: 6050, low: 5300}};
  const tablet = computeMarketSuggestion([ITEMS[0]], LATEST, VOLUMES, {...OPTS, rankPrices: flukeOnly});
  if (tablet) assert.ok(tablet.expectedProfit === undefined, 'if offered at all it is on the steady margin');
});

test('an item with no archived reading is ranked exactly as it always was', () => {
  // A fresh install has no archive for days. Every item must behave identically to before, or the
  // change would make EVI go quiet for precisely the users it is meant to help.
  const partial = {'561': {high: 700, low: 600}};   // nothing at all for the tablet
  const withPartial = computeMarketSuggestion(ITEMS, LATEST, VOLUMES, {...OPTS, rankPrices: partial});
  const without = computeMarketSuggestion(ITEMS, LATEST, VOLUMES, OPTS);
  assert.equal(withPartial.itemId, without.itemId, 'an unlisted item falls back to the live reading');
  assert.equal(withPartial.itemId, 19631);
});

test('an Old School Bond is never suggested as a buy, by any tier', async () => {
  // A bond bought on the Grand Exchange arrives untradeable, and the fee to make it tradeable again
  // all but always exceeds the spread -- so the margin is real in the price data and uncollectable in
  // the game. It is also tax-free, which means marginClearsTax exempts it by construction and every
  // thin-margin safety net waves it through. And it is exactly what a large stack's ranking reaches
  // for: expensive, wide quoted spread, able to absorb tens of millions at once.
  const {computeSuggestion, computePushedSuggestion, UNFLIPPABLE_ITEM_IDS} = await import('../bridge/suggestions.mjs');
  assert.ok(UNFLIPPABLE_ITEM_IDS.has(13190));

  const bond = [{id: 13190, name: 'Old school bond', limit: 100, members: false}];
  const prices = {'13190': {high: 12_000_000, low: 11_000_000, highTime: now / 1000, lowTime: now / 1000}};
  const vols = {'13190': {highPriceVolume: 500, lowPriceVolume: 500}};

  // Market tier: the spread is a clean 1m a unit and tax-free, so nothing else would stop it.
  assert.equal(computeMarketSuggestion(bond, prices, vols, OPTS), null, 'market tier');

  // Scanner-pushed tier, same item handed straight to it.
  const pushed = computePushedSuggestion(
    [{itemId: 13190, name: 'Old school bond', buyPrice: 11_000_000, sellPrice: 12_000_000, limit: 100}],
    {maxSpend: 50_000_000, volumes: vols, targetDurationMinutes: 720});
  assert.equal(pushed, null, 'scanner-pushed tier');

  // Personal-history tier: even a player who really has flipped bonds before is not offered another.
  const flips = Array.from({length: 6}, (_, i) => ({
    itemId: 13190, name: 'Old school bond', quantity: 1, buyPrice: 11_000_000, sellPrice: 12_000_000,
    profit: 1_000_000, reviewed: true, completedAt: now - (i + 1) * 3600_000,
  }));
  const own = computeSuggestion(flips, prices, now, {maxSpend: 50_000_000, targetDurationMinutes: 720});
  assert.ok(own === null || own.itemId !== 13190, `personal tier offered a bond: ${JSON.stringify(own)}`);
});

test('the scanner-pushed tier ranks on the bridge\'s own measure, not the browser\'s score', async () => {
  // Until 28 Sept 2026 this tier sorted on the scanner's EVI Score V2 alone, which made the
  // least-evidenced ranking in the system the one that decided what a player saw -- and it takes
  // precedence over the market tier whenever the scanner is open. Measured live at an 85m stack, it
  // offered Teak logs worth 12,816 gp while the market tier on the same prices offered about ten
  // times that.
  const {computePushedSuggestion} = await import('../bridge/suggestions.mjs');
  const vols = {'1': {highPriceVolume: 500, lowPriceVolume: 500}, '2': {highPriceVolume: 500, lowPriceVolume: 500}};

  // Item 1 is what the scanner loves; item 2 is worth four times as much per unit at the same size.
  const shortlist = [
    {itemId: 1, name: 'Scanner favourite', buy: 100, sell: 120, net: 15, qty: 100, score: 99},
    {itemId: 2, name: 'Actually worth more', buy: 100, sell: 180, net: 60, qty: 100, score: 10},
  ];
  const pick = computePushedSuggestion(shortlist, {volumes: vols, targetDurationMinutes: 720});
  assert.equal(pick.itemId, 2, 'the bridge\'s own measure must decide, not the 99-vs-10 score');

  // The scanner's score is still the tie-break, so where the bridge genuinely cannot separate two
  // candidates the browser's richer view (price history, the player's record, news) still orders them.
  const tied = [
    {itemId: 1, name: 'A', buy: 100, sell: 180, net: 60, qty: 100, score: 40},
    {itemId: 2, name: 'B', buy: 100, sell: 180, net: 60, qty: 100, score: 90},
  ];
  assert.equal(computePushedSuggestion(tied, {volumes: vols, targetDurationMinutes: 720}).itemId, 2,
    'an exact tie falls back to the scanner');

  // A freak print cannot carry a pushed candidate either: the steady price caps what it is ranked on.
  const flattered = [
    {itemId: 1, name: 'One lucky print', buy: 100, sell: 900, net: 780, qty: 100, score: 99},
    {itemId: 2, name: 'Steady', buy: 100, sell: 180, net: 60, qty: 100, score: 10},
  ];
  const steady = computePushedSuggestion(flattered, {volumes: vols, targetDurationMinutes: 720,
    rankPrices: {'1': {high: 105, low: 100}, '2': {high: 180, low: 100}}});
  assert.equal(steady.itemId, 2, 'the robust reading must cap what a pushed candidate is ranked on');
});

test('the pushed tier sizes from the item\'s buy limit, not from the browser\'s quantity', async () => {
  // The scanner works its quantity out from the bankroll typed into the page and its own liquidity
  // rule, and that number used to be the ceiling here -- every cap could only shrink it. So neither
  // the player's trade pace nor "Bigger positions" could move this tier at all.
  const {computePushedSuggestion} = await import('../bridge/suggestions.mjs');
  const vols = {'1': {highPriceVolume: 100000, lowPriceVolume: 100000}};
  const one = [{itemId: 1, name: 'Thing', buy: 100, sell: 180, net: 60, qty: 5, score: 50}];

  // With no limit reading, the scanner's own figure stands, exactly as before.
  const before = computePushedSuggestion(one, {volumes: vols, targetDurationMinutes: 720, maxSpend: 10_000_000});
  assert.equal(before.quantity, 5, 'no catalogue: fall back to the browser, changing nothing');

  // With one, EVI sizes from the buy limit across the windows the trade spans and can grow the order.
  const after = computePushedSuggestion(one, {volumes: vols, targetDurationMinutes: 720, maxSpend: 10_000_000,
    limitOf: () => 1000});
  assert.ok(after.quantity > 5, `EVI must be able to grow the order, got ${after.quantity}`);

  // And every existing cap still binds below it: cash is the obvious one.
  const poor = computePushedSuggestion(one, {volumes: vols, targetDurationMinutes: 720, maxSpend: 700,
    limitOf: () => 1000});
  assert.equal(poor.quantity, 7, 'the cash stack still caps it at what 700 gp can buy');
});

test('a pushed pick that IS cut by the volume cap still renders its note', async () => {
  // This exact path threw "pushedShare is not defined" on novi's live bridge on 28 Sept 2026: the
  // sizing rewrite removed the variable and left one reference behind in the notes, so every
  // market-block request 502'd and the plugin showed "Bridge unreachable". Nothing caught it because
  // no test had ever produced a share-limited PUSHED pick and then read the sentence. The note is the
  // only line that names which cap bound, so it has to be exercised, not just the quantity.
  const {computePushedSuggestion} = await import('../bridge/suggestions.mjs');
  const thin = {'1': {highPriceVolume: 10, lowPriceVolume: 10}};
  const one = [{itemId: 1, name: 'Thin thing', buy: 100, sell: 180, net: 60, qty: 5000, score: 50}];

  const perHour = computePushedSuggestion(one, {volumes: thin, targetDurationMinutes: 720, maxSpend: 10_000_000});
  assert.ok(perHour, 'a share-limited pushed pick must still be returned');
  assert.ok(perHour.quantity < 5000, 'the cap must actually have bitten');
  assert.match(perHour.reasoning, /recent hourly trading/, 'the per-hour rule names itself: ' + perHour.reasoning);

  // And the window-relative rule describes itself differently, because it is a different quantity in
  // different units -- quoting the per-hour wording there would misdescribe the order.
  const perWindow = computePushedSuggestion(one, {volumes: thin, targetDurationMinutes: 720,
    maxSpend: 10_000_000, volumeWindowShare: 0.10});
  assert.ok(perWindow.quantity < 5000);
  assert.match(perWindow.reasoning, /over your whole trade window/, 'the window rule names itself: ' + perWindow.reasoning);
});

test('a buy price that disagrees with its own hour is a print, not a price', async () => {
  // Found live on 29 Sept 2026: EVI offered 2,000 Divine super defence potion(4) at 299 to sell at
  // 5,177 -- a headline of nearly 10m gp. The item trades around 5,000-5,500, and its own hour
  // averaged 2,984 across 1,898 real trades. The 299 was one print at a tenth of what everyone else
  // in that hour got, and every check downstream took it on trust: the robust gate judged the ITEM
  // and rightly passed it, implausibleSpread needs an empty hour and this was the busiest in a
  // fortnight, and headlineProfit's two inputs both subtracted the same bogus 299.
  const {implausibleBuyPrint, BUY_PRINT_MULTIPLE} = await import('../bridge/suggestions.mjs');
  assert.equal(BUY_PRINT_MULTIPLE, 0.5);

  // The case itself: 299 against an hour that averaged 2,984 over 1,898 trades.
  assert.equal(implausibleBuyPrint(299, {avgLowPrice: 2984, lowPriceVolume: 1898}), true);

  // An ordinary print is at or near its hour's average -- the median across 2,496 items was 1.000x,
  // and the 10th percentile 0.954x, so normal trading must never trip this.
  assert.equal(implausibleBuyPrint(2984, {avgLowPrice: 2984, lowPriceVolume: 1898}), false);
  assert.equal(implausibleBuyPrint(2847, {avgLowPrice: 2984, lowPriceVolume: 1898}), false, '0.954x, the 10th pct');
  assert.equal(implausibleBuyPrint(1510, {avgLowPrice: 2984, lowPriceVolume: 1898}), false, '0.506x, the 1st pct, still allowed');

  // Nothing to judge against is not evidence. No average, or an hour with no trades on that side,
  // must fail OPEN -- the same rule every other check here follows.
  assert.equal(implausibleBuyPrint(299, {avgLowPrice: 0, lowPriceVolume: 1898}), false, 'no average');
  assert.equal(implausibleBuyPrint(299, {avgLowPrice: 2984, lowPriceVolume: 0}), false, 'nothing traded to average');
  assert.equal(implausibleBuyPrint(299, undefined), false, 'no reading at all');
  assert.equal(implausibleBuyPrint(0, {avgLowPrice: 2984, lowPriceVolume: 1898}), false, 'no price');

  // A genuine sustained decline must survive. This is why the test is against the SAME HOUR rather
  // than the 14-day median: an item that crashed a week ago sits far below its fortnight median quite
  // legitimately, and dropping it for that would be wrong.
  assert.equal(implausibleBuyPrint(1000, {avgLowPrice: 1010, lowPriceVolume: 400}), false,
    'down 80% from its fortnight median, but trading consistently at the new level');

  // And end to end: the market tier must not offer it.
  const {computeMarketSuggestion} = await import('../bridge/suggestions.mjs');
  const items = [{id: 23721, name: 'Divine super defence potion(4)', limit: 2000, members: true}];
  const now = Date.now();
  const prices = {'23721': {high: 5177, low: 299, highTime: now / 1000, lowTime: now / 1000}};
  const vols = {'23721': {highPriceVolume: 1604, lowPriceVolume: 1898, avgHighPrice: 6266, avgLowPrice: 2984}};
  assert.equal(computeMarketSuggestion(items, prices, vols, {maxSpend: 50_000_000, targetDurationMinutes: 720, now}),
    null, 'the market tier must refuse a candidate whose buy price is a print');
});
