import {test} from 'node:test';
import assert from 'node:assert/strict';
import {predictedFillMinutes,bucketAt,calibrationSamples,summarizeCalibration,calibrationByBand} from '../bridge/fillCalibration.mjs';

const H=3600,B0=Math.floor(Date.UTC(2026,7,1)/1000);
const bucket=(i,d)=>({ts:B0+i*H,d});
const archive=Array.from({length:48},(_,i)=>bucket(i,{'1':[130,600,100,600]})); // 600/h both sides

test('predictedFillMinutes uses the thinner side and refuses to guess without volume',()=>{
  assert.equal(predictedFillMinutes(300,{highPriceVolume:600,lowPriceVolume:600}),30); // 300 / (600/60)
  assert.equal(predictedFillMinutes(300,{highPriceVolume:6000,lowPriceVolume:600}),30,'the thinner side decides');
  assert.equal(predictedFillMinutes(300,{highPriceVolume:600,lowPriceVolume:0}),null);
  assert.equal(predictedFillMinutes(300,undefined),null);
  assert.equal(predictedFillMinutes(0,{highPriceVolume:600,lowPriceVolume:600}),null);
});

test('bucketAt finds the archived hour containing a moment, or nothing',()=>{
  assert.equal(bucketAt(archive,(B0+5*H+1800)*1000).ts,B0+5*H);
  assert.equal(bucketAt(archive,(B0-H)*1000),null,'before the archive starts');
  assert.equal(bucketAt([],Date.now()),null);
});

test('calibrationSamples pairs real timings with what the estimate would have said, and counts what it skipped',()=>{
  const trades=[
    {itemId:1,item:'A',quantity:300,startedAt:(B0+2*H)*1000,finishedAt:(B0+2*H)*1000+60*60000}, // predicted 30 min, took 60
    {itemId:1,item:'A',quantity:300,startedAt:(B0-5*H)*1000,finishedAt:(B0-4*H)*1000},           // outside the archive
    {itemId:999,item:'B',quantity:10,startedAt:(B0+2*H)*1000,finishedAt:(B0+3*H)*1000},          // item has no volume data
    {itemId:1,item:'A',quantity:0,startedAt:(B0+2*H)*1000,finishedAt:(B0+3*H)*1000},             // no quantity
  ];
  const {samples,skipped}=calibrationSamples(trades,archive);
  assert.equal(samples.length,1);
  assert.equal(samples[0].predicted,30);
  assert.equal(samples[0].realised,60);
  assert.equal(samples[0].ratio,2);
  assert.deepEqual(skipped,{noArchive:1,noVolume:1,badTiming:1});
  // A round trip is compared against two fills, not one.
  const round=calibrationSamples([trades[0]],archive,{sides:2});
  assert.equal(round.samples[0].predicted,60);
  assert.equal(round.samples[0].ratio,1);
});

test('summarizeCalibration refuses to calibrate from a handful of samples',()=>{
  const few=Array.from({length:19},()=>({ratio:2}));
  const s=summarizeCalibration(few);
  assert.equal(s.enough,false);
  assert.match(s.note,/not enough/i);
});

test('summarizeCalibration reports the median, the spread and how often reality beat the estimate',()=>{
  const ratios=[...Array(25).fill(0.5),...Array(25).fill(2)];
  const s=summarizeCalibration(ratios.map(r=>({ratio:r})));
  assert.equal(s.enough,true);
  assert.equal(s.samples,50);
  assert.equal(s.medianRatio,2);
  assert.equal(s.p25,0.5);
  assert.equal(s.fasterThanPredicted,0.5,'half the trades beat the estimate');
  assert.equal(s.spread,4);
  assert.equal(s.suggestedFactor,s.medianRatio);
  assert.equal(calibrationByBand([]).length,4);
});
