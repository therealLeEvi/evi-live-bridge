import {test} from 'node:test';
import assert from 'node:assert/strict';
import {joinSuggestionOutcomes,summarizeOutcomes} from '../bridge/suggestionOutcomes.mjs';

const T=Date.UTC(2026,8,18,10);
const suggestion=(o={})=>({ts:T,itemId:1,name:'Rune nails',action:'buy',source:'personal',quantity:100,buyPrice:100,sellPrice:130,...o});
const offer=(o={})=>({offerId:'o1',itemId:1,state:'BUYING',price:100,total:100,filled:0,firstSeen:T+60000,completedAt:null,...o});

test('a suggestion followed by a matching offer counts as acted on, with what the player actually did',()=>{
  // The offer is placed a minute after the suggestion and finishes an hour after that.
  const rows=joinSuggestionOutcomes([suggestion()],[offer({state:'BOUGHT',filled:100,completedAt:T+60000+3600000,price:99,total:100})],[]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].taken,true);
  assert.equal(rows[0].filledFully,true);
  assert.equal(rows[0].actualPrice,99,'records the price actually used, not the suggested one');
  assert.equal(rows[0].minutesToComplete,60);
  assert.equal(rows[0].stillOpen,false);
});

test('an offer on the other side, a different item, or placed too late does not count',()=>{
  const late=offer({firstSeen:T+5*3600000});
  assert.equal(joinSuggestionOutcomes([suggestion()],[late],[]) [0].taken,false);
  assert.equal(joinSuggestionOutcomes([suggestion()],[offer({itemId:999})],[])[0].taken,false);
  assert.equal(joinSuggestionOutcomes([suggestion()],[offer({state:'SELLING'})],[])[0].taken,false,'a sell cannot be acting on a buy suggestion');
  assert.equal(joinSuggestionOutcomes([suggestion({action:'sell'})],[offer({state:'SELLING'})],[])[0].taken,true);
});

test('one offer is claimed by only one suggestion, so repeats are not all counted as taken',()=>{
  const rows=joinSuggestionOutcomes([suggestion(),suggestion({ts:T+120000})],[offer()],[]);
  assert.equal(rows[0].taken,true);
  assert.equal(rows[1].taken,false,'the same offer must not count twice');
});

test('realised profit is attached when the suggested buy closed into a flip',()=>{
  const rows=joinSuggestionOutcomes([suggestion()],[offer({state:'BOUGHT',filled:100,completedAt:T+600000})],
    [{buyId:'o1',profit:2500,firstBuy:T,lastSell:T+7200000}]);
  assert.equal(rows[0].profit,2500);
  assert.equal(rows[0].soldWithinHours,2);
});

test('the summary reports the misses as plainly as the hits',()=>{
  const rows=[
    {taken:false},
    {taken:true,stillOpen:true,filled:0,action:'buy',actualPrice:100,buyPrice:100},
    {taken:true,stillOpen:false,filled:10,filledFully:true,minutesToComplete:30,profit:500,action:'buy',actualPrice:100,buyPrice:100},
    {taken:true,stillOpen:false,filled:10,filledFully:true,minutesToComplete:90,profit:-200,action:'buy',actualPrice:95,buyPrice:100},
  ];
  const s=summarizeOutcomes(rows);
  assert.equal(s.shown,4);
  assert.equal(s.taken,3);
  assert.equal(s.takenShare,0.75);
  assert.equal(s.stillOpen,1);
  assert.equal(s.filledFully,2);
  assert.equal(s.closedFlips,2);
  assert.equal(s.realisedProfit,300);
  assert.equal(s.winners,1);
  assert.equal(s.losers,1);
  assert.equal(s.medianProfit,500);
  assert.equal(s.worstProfit,-200);
  assert.equal(Math.round(s.followedSuggestedPrice*100),67,'two of three used the exact suggested price');
  assert.equal(summarizeOutcomes([]).shown,0);
});
