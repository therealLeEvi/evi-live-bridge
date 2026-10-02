import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relistAdvice,RELIST_AFTER_SHARE,MIN_WAIT_MINUTES} from '../bridge/relist.mjs';

const NOW=Date.UTC(2026,8,18,12);
const hoursAgo=h=>NOW-h*3600000;
// Item 1 is taxed; 12,000 gp paid means break-even is a little above 12,000 after tax.
const offer=(o={})=>({itemId:1,name:'Test item',price:13000,remaining:5,firstSeen:hoursAgo(8),...o});
const prices=(sell=12500)=>({'1':{itemId:1,buyPrice:sell-500,sellPrice:sell}});
const cost=(paid=12000)=>new Map([[1,paid]]);

// A gap under DRIFT_SPEAKS_NOW, so only the clock can make it speak. 13,000 against 12,900 is 0.77%:
// above MIN_GAP, so it is worth saying eventually, but not far enough to bypass the wait.
const nearMarket=()=>prices(12900);

test('an offer that has not waited long enough is left alone',()=>{
  const fresh=relistAdvice({offers:[offer({firstSeen:hoursAgo(1)})],prices:nearMarket(),costBasis:cost(),targetDurationMinutes:1440,now:NOW});
  assert.equal(fresh.length,0,'1 hour into a 24-hour target is far too early');
  const waited=relistAdvice({offers:[offer({firstSeen:hoursAgo(7)})],prices:nearMarket(),costBasis:cost(),targetDurationMinutes:1440,now:NOW});
  assert.equal(waited.length,1,'past a quarter of the window it speaks');
});

test('a market that has moved away speaks without waiting out the clock',()=>{
  // The gap this closes: the wait is a share of the player's pace, so on Slow (~2 days) a quarter of
  // it is twelve hours of silence however far the price runs. Measured over 316 sell offers from one
  // player's own journal -- not a market-wide figure -- an ask more than 1% over the going rate took six to seven hours to sell and a third to a
  // half never sold at all -- so at that point waiting is the wrong advice, not the cautious one.
  const drifted=[offer({firstSeen:hoursAgo(1)})];            // 13,000 against 12,500 is 3.85%
  const out=relistAdvice({offers:drifted,prices:prices(),costBasis:cost(),targetDurationMinutes:2880,now:NOW});
  assert.equal(out.length,1,'2 days of pace would otherwise mean 12 hours of silence');
  // Shortened 1 Oct 2026: "the market has moved away" is the card's LABEL now, and both prices are
  // in its figures row, so the sentence carries only what the card cannot show.
  assert.equal(out[0].label,'Market moved away');
  assert.match(out[0].figures,/13,000 asked/);
  assert.match(out[0].message,/3\.8% over the going rate/);
  assert.match(out[0].message,/6-7h/,'the measured consequence is the reason to act, and stays');
  assert.ok(out[0].message.length<240,'short enough to read: '+out[0].message.length);
  assert.ok(!/after 1 hour/.test(out[0].message),'it leads with the market, not with impatience');

  // Still not instantly: placing an offer must not be second-guessed on the spot. An ask within 1% of
  // the market typically fills in 6 to 24 minutes, so fifteen is where standing still becomes news.
  assert.equal(relistAdvice({offers:[offer({firstSeen:NOW-5*60000})],prices:prices(),costBasis:cost(),targetDurationMinutes:2880,now:NOW}).length,0);
  assert.equal(relistAdvice({offers:[offer({firstSeen:NOW-20*60000})],prices:prices(),costBasis:cost(),targetDurationMinutes:2880,now:NOW}).length,1);

  // Above 5% the plugin's own offerDriftHint says it, so the early path stays quiet rather than
  // putting two sentences about one offer in the sidebar. The clock still applies to it as before.
  const wide=[offer({price:14000,firstSeen:hoursAgo(1)})];   // 14,000 against 12,500 is 10.7%
  assert.equal(relistAdvice({offers:wide,prices:prices(),costBasis:cost(),targetDurationMinutes:2880,now:NOW}).length,0,
    'the plugin is already speaking at this drift');
  assert.equal(relistAdvice({offers:[offer({price:14000,firstSeen:hoursAgo(13)})],prices:prices(),costBasis:cost(),targetDurationMinutes:2880,now:NOW}).length,1,
    'once the ordinary wait elapses it speaks as it always did');
});

test('the wait scales with the player\'s own trade duration, with a floor',()=>{
  // Measured against a near-market ask, so the drift path cannot fire and only the clock is on test.
  const o=[offer({firstSeen:hoursAgo(1)})];
  // A 2-hour trader hears after 30 minutes; a 24-hour trader does not.
  assert.equal(relistAdvice({offers:o,prices:nearMarket(),costBasis:cost(),targetDurationMinutes:120,now:NOW}).length,1);
  assert.equal(relistAdvice({offers:o,prices:nearMarket(),costBasis:cost(),targetDurationMinutes:1440,now:NOW}).length,0);
  // Never sooner than the minimum wait, however short the target.
  assert.equal(relistAdvice({offers:[offer({firstSeen:NOW-10*60000})],prices:nearMarket(),costBasis:cost(),targetDurationMinutes:5,now:NOW}).length,0);
  assert.ok(MIN_WAIT_MINUTES>0&&RELIST_AFTER_SHARE>0);
});

test('an offer already at or below the market is not nagged about',()=>{
  assert.equal(relistAdvice({offers:[offer({price:12000})],prices:prices(12500),costBasis:cost(),now:NOW}).length,0,'priced under the market: it is just queueing');
  assert.equal(relistAdvice({offers:[offer({price:12530})],prices:prices(12500),costBasis:cost(),now:NOW}).length,0,'a 0.2% gap is noise, not an improvement');
});

test('when the market still clears break-even it says so, and never tells you to relist',()=>{
  const [advice]=relistAdvice({offers:[offer()],prices:prices(12500),costBasis:cost(12000),now:NOW});
  assert.match(advice.message,/8 hours/);
  assert.match(advice.figures,/12,500 market/,'the market price is on the card, not repeated in the sentence');
  assert.match(advice.message,/still clears your break-even/);
  assert.match(advice.message,/Your call/);
  assert.equal(advice.belowBreakEven,false);
  assert.equal(advice.suggestedPrice,12500);
});

test('when the market is under break-even it warns and refuses to push a loss',()=>{
  const [advice]=relistAdvice({offers:[offer()],prices:prices(11000),costBasis:cost(12000),now:NOW});
  assert.equal(advice.belowBreakEven,true);
  assert.match(advice.message,/BELOW your break-even/);
  assert.match(advice.message,/lock in a loss/);
  assert.match(advice.message,/won't choose for you/);
  assert.ok(advice.suggestedPrice>advice.marketPrice,'it never suggests the losing price as the thing to do');
});

test('with no cost basis it stays quiet about break-even instead of guessing',()=>{
  const [advice]=relistAdvice({offers:[offer()],prices:prices(12500),costBasis:new Map(),now:NOW});
  assert.match(advice.message,/doesn't know what you paid/);
  assert.equal(advice.breakEven,null);
});

test('missing prices, missing timing or a zero price produce nothing at all',()=>{
  assert.equal(relistAdvice({offers:[offer()],prices:{},costBasis:cost(),now:NOW}).length,0);
  assert.equal(relistAdvice({offers:[offer({price:0})],prices:prices(),costBasis:cost(),now:NOW}).length,0);
  assert.equal(relistAdvice({offers:[offer({firstSeen:null})],prices:prices(),costBasis:cost(),now:NOW}).length,0);
  assert.equal(relistAdvice({offers:[],prices:prices(),costBasis:cost(),now:NOW}).length,0);
  assert.equal(relistAdvice({offers:null,prices:prices(),now:NOW}).length,0);
});

test('a market under break-even speaks however wide the gap, overlapping the plugin on purpose', () => {
  // FROM A LIVE CASE, 2 Oct 2026, reproduced here with round figures. A standing ask sat about 32%
  // above a market that had slipped just under the holder's own break-even. The early path was
  // suppressed by PLUGIN_SPEAKS_ABOVE, so the ONLY thing speaking was the plugin's offerDriftHint --
  // which knows nothing about cost basis and ends "Relist nearer the market, or take the current
  // price". Taking the current price would have locked in a loss.
  //
  // The hole was widest exactly when it was most expensive: the bigger the gap, the likelier the
  // market has fallen through the cost basis.
  //
  // Cost basis 4,000 -> break-even 4,081 after tax; the market sits at 4,065, just below it.
  const offer = {itemId: 19625, name: 'Harmony island teleport', price: 6000, remaining: 500,
    firstSeen: Date.now() - 30 * 60000};
  const prices = {'19625': {sellPrice: 4065}};
  const under = relistAdvice({offers: [offer], prices, costBasis: new Map([[19625, 4000]]),
    targetDurationMinutes: 720});
  assert.equal(under.length, 1, 'a 32% gap under break-even must still speak');
  assert.equal(under[0].belowBreakEven, true);
  assert.equal(under[0].breakEven, 4081);
  assert.equal(under[0].level, 'warn', 'the one case the player can lose GP on reads as a warning');
  assert.match(under[0].message, /BELOW your break-even/);
  assert.match(under[0].message, /lock in a loss/);
  assert.equal(under[0].suggestedPrice, 4081, 'never a price under break-even');

  // ABOVE break-even the hand-off is unchanged: a wide gap stays silent on the early path, because
  // the plugin already says it and two sentences about one offer is the thing being avoided.
  const clears = relistAdvice({offers: [offer], prices, costBasis: new Map([[19625, 2000]]),
    targetDurationMinutes: 720});
  assert.equal(clears.length, 0, 'a 32% gap that still clears break-even is left to the plugin');

  // And the ordinary band is untouched in both directions.
  const narrow = {...offer, price: 4140};               // 1.8% over market, inside the early band
  assert.equal(relistAdvice({offers: [narrow], prices, costBasis: new Map([[19625, 2000]]),
    targetDurationMinutes: 720}).length, 1, 'the early band still speaks when the gap is modest');

  // No cost basis: nothing is claimed about break-even, and the wide gap stays with the plugin.
  assert.equal(relistAdvice({offers: [offer], prices, costBasis: new Map(), targetDurationMinutes: 720}).length, 0,
    'EVI must not invent a cost basis to justify speaking');

  // Still floored by DRIFT_MIN_WAIT_MINUTES, so a freshly placed offer is not instantly second-guessed.
  const fresh = {...offer, firstSeen: Date.now() - 60000};
  assert.equal(relistAdvice({offers: [fresh], prices, costBasis: new Map([[19625, 4031]]),
    targetDurationMinutes: 720}).length, 0, 'one minute old: too early to speak, below break-even or not');
});
