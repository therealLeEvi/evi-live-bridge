import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildFillModel,fillChance,fillChanceSentence,bandFor,MIN_SAMPLES} from '../bridge/fillModel.mjs';

const H=3600,T0=Math.floor(Date.UTC(2026,8,1)/1000);
// One archived hour where item 1 trades 1,000 per hour on both sides.
const archive=Array.from({length:72},(_,i)=>({ts:T0+i*H,d:{'1':[130,1000,100,1000]}}));
const offer=(o={})=>({itemId:1,state:'BOUGHT',total:100,filled:100,firstSeen:(T0+2*H)*1000,completedAt:(T0+2*H)*1000+600000,knownStart:true,...o});
const many=(n,o)=>Array.from({length:n},()=>offer(o));

test('offers that never filled are counted, not dropped',()=>{
  // 10 filled in 10 minutes, 10 cancelled without filling: the band is half successful, not 100%.
  const model=buildFillModel([...many(10),...many(10,{state:'CANCELLED_BUY',filled:0,completedAt:(T0+2*H)*1000+7200000})],archive);
  const band=model.bands[bandFor(100/1000)];
  assert.equal(band.count,20);
  assert.equal(band.filledCount,10);
  const chance=fillChance(model,100,{highPriceVolume:1000,lowPriceVolume:1000},60);
  assert.equal(chance.probability,0.5,'half of the offers of this size actually filled in an hour');
  assert.equal(chance.samples,20);
});

test('an offer still running says nothing about a window longer than it was up for',()=>{
  const open=many(20,{state:'BUYING',filled:0,completedAt:null,updated:(T0+2*H)*1000+1800000});
  const model=buildFillModel(open,archive,{now:(T0+2*H)*1000+1800000});
  // Asked about 15 minutes, a still-open 30-minute-old offer is evidence of failure.
  assert.equal(fillChance(model,100,{highPriceVolume:1000,lowPriceVolume:1000},15).probability,0);
  // Asked about 24 hours, it is not evidence either way, so there is nothing to report.
  assert.equal(fillChance(model,100,{highPriceVolume:1000,lowPriceVolume:1000},1440),null);
});

test('a thin band reports nothing rather than a confident number from a handful of offers',()=>{
  const model=buildFillModel(many(MIN_SAMPLES-1),archive);
  assert.equal(fillChance(model,100,{highPriceVolume:1000,lowPriceVolume:1000},60),null);
  assert.equal(fillChance(buildFillModel(many(MIN_SAMPLES),archive),100,{highPriceVolume:1000,lowPriceVolume:1000},60).samples,MIN_SAMPLES);
});

test('sizing uses the quantity offered, not the amount that happened to fill',()=>{
  // Offered 5,000 of an item trading 1,000/hour = the "large" band, even though only 10 filled.
  const model=buildFillModel(many(20,{total:5000,filled:10,state:'CANCELLED_BUY'}),archive);
  assert.equal(model.bands[bandFor(5)].count,20);
  assert.equal(model.bands[bandFor(0.01)].count,0);
});

test('no usable volume, no archived hour, or no quantity means no model entry and no claim',()=>{
  assert.equal(buildFillModel([offer({itemId:999})],archive).skipped,1);
  assert.equal(buildFillModel([offer({firstSeen:(T0-10*H)*1000})],archive).skipped,1);
  assert.equal(buildFillModel([offer({total:0,filled:0})],archive).skipped,1);
  const model=buildFillModel(many(MIN_SAMPLES),archive);
  assert.equal(fillChance(model,100,{highPriceVolume:0,lowPriceVolume:1000},60),null);
  assert.equal(fillChance(model,0,{highPriceVolume:1000,lowPriceVolume:1000},60),null);
  assert.equal(fillChance(null,100,{highPriceVolume:1000,lowPriceVolume:1000},60),null);
});

test('the sentence names the sample size and disclaims being a forecast, or says nothing at all',()=>{
  const chance=fillChance(buildFillModel(many(MIN_SAMPLES),archive),100,{highPriceVolume:1000,lowPriceVolume:1000},120);
  const sentence=fillChanceSentence(chance,120);
  assert.match(sentence,/100% finished within 2 hours/);
  assert.match(sentence,new RegExp(MIN_SAMPLES+' offers'));
  assert.match(sentence,/your own record, not a forecast/);
  assert.equal(fillChanceSentence(null,120),null);
});
