import {test} from 'node:test';
import assert from 'node:assert/strict';
import {relistAdvice,RELIST_AFTER_SHARE,MIN_WAIT_MINUTES} from '../bridge/relist.mjs';

const NOW=Date.UTC(2026,8,18,12);
const hoursAgo=h=>NOW-h*3600000;
// Item 1 is taxed; 12,000 gp paid means break-even is a little above 12,000 after tax.
const offer=(o={})=>({itemId:1,name:'Test item',price:13000,remaining:5,firstSeen:hoursAgo(8),...o});
const prices=(sell=12500)=>({'1':{itemId:1,buyPrice:sell-500,sellPrice:sell}});
const cost=(paid=12000)=>new Map([[1,paid]]);

test('an offer that has not waited long enough is left alone',()=>{
  const fresh=relistAdvice({offers:[offer({firstSeen:hoursAgo(1)})],prices:prices(),costBasis:cost(),targetDurationMinutes:1440,now:NOW});
  assert.equal(fresh.length,0,'1 hour into a 24-hour target is far too early');
  const waited=relistAdvice({offers:[offer({firstSeen:hoursAgo(7)})],prices:prices(),costBasis:cost(),targetDurationMinutes:1440,now:NOW});
  assert.equal(waited.length,1,'past a quarter of the window it speaks');
});

test('the wait scales with the player\'s own trade duration, with a floor',()=>{
  const o=[offer({firstSeen:hoursAgo(1)})];
  // A 2-hour trader hears after 30 minutes; a 24-hour trader does not.
  assert.equal(relistAdvice({offers:o,prices:prices(),costBasis:cost(),targetDurationMinutes:120,now:NOW}).length,1);
  assert.equal(relistAdvice({offers:o,prices:prices(),costBasis:cost(),targetDurationMinutes:1440,now:NOW}).length,0);
  // Never sooner than the minimum wait, however short the target.
  assert.equal(relistAdvice({offers:[offer({firstSeen:NOW-10*60000})],prices:prices(),costBasis:cost(),targetDurationMinutes:5,now:NOW}).length,0);
  assert.ok(MIN_WAIT_MINUTES>0&&RELIST_AFTER_SHARE>0);
});

test('an offer already at or below the market is not nagged about',()=>{
  assert.equal(relistAdvice({offers:[offer({price:12000})],prices:prices(12500),costBasis:cost(),now:NOW}).length,0,'priced under the market: it is just queueing');
  assert.equal(relistAdvice({offers:[offer({price:12530})],prices:prices(12500),costBasis:cost(),now:NOW}).length,0,'a 0.2% gap is noise, not an improvement');
});

test('when the market still clears break-even it says so, and never tells you to relist',()=>{
  const [advice]=relistAdvice({offers:[offer()],prices:prices(12500),costBasis:cost(12000),now:NOW});
  assert.match(advice.message,/8 hours/);
  assert.match(advice.message,/market is around 12,500/);
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
