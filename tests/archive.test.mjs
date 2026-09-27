import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {createSuggestionLog,checksOf} from '../bridge/suggestionLog.mjs';
import {createPriceArchive,readArchive,compactBucket} from '../bridge/priceArchive.mjs';

function tempDir(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evi-archive-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
const HOUR=3600;

test('suggestion log: records a suggestion once, repeats only after 30 minutes or when it changes, ignores null',t=>{
  const dir=tempDir(t),log=createSuggestionLog(dir),T=Date.UTC(2026,8,17);
  const s={itemId:2,name:'Steel cannonball',action:'buy',source:'personal',quantity:100,buyPrice:243,sellPrice:249};
  assert.equal(log.record({account:'a',suggestion:s,now:T}),true);
  assert.equal(log.record({account:'a',suggestion:{...s},now:T+2000}),false,'the 2-second poll must not flood the log');
  assert.equal(log.record({account:'b',suggestion:s,now:T+2000}),true,'per account');
  assert.equal(log.record({account:'a',suggestion:{...s,sellPrice:250},now:T+4000}),true,'a changed price is a new suggestion');
  assert.equal(log.record({account:'a',suggestion:{...s,sellPrice:250},now:T+4000+30*60000}),true);
  assert.equal(log.record({account:'a',suggestion:null,now:T+5000}),false);
  const lines=fs.readFileSync(log.file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length,4);assert.equal(lines[0].itemId,2);assert.equal(lines[0].breakEvenPrice,null);
  assert.deepEqual(lines[0].checks,{demoted:false,sellSupport:null,exitRisk:null},'a check that did not run is null, never a pass');
});

test('suggestion log: records what each safety check concluded, so its calls can be judged later',t=>{
  const dir=tempDir(t),log=createSuggestionLog(dir);
  const s={itemId:29049,name:'Eclipse Moon chestplate (broken)',action:'buy',source:'personal',quantity:1,buyPrice:595350,sellPrice:618004,
    demoted:true,sellSupport:{supported:false,units:48,hours:12,averagePaid:587104.4,netAtAverage:-19988.2},
    fillOutlook:{buy:0.912,sell:0.744,worst:'sell',notable:true,samples:15137}};
  log.record({account:'a',suggestion:s,context:{risk:'low',heldBack:[{itemId:1,reason:'moves with X'}],buysHeldForExits:false}});
  const e=JSON.parse(fs.readFileSync(log.file,'utf8').trim());
  assert.equal(e.checks.demoted,true);
  assert.deepEqual(e.checks.sellSupport,{supported:false,buyers:48,hours:12,averagePaid:587104,netAtAverage:-19988});
  assert.deepEqual(e.checks.exitRisk,{buy:0.912,sell:0.744,worst:'sell',notable:true});
  assert.equal(e.heldBack[0].reason,'moves with X','the correlation check\'s call is kept too');
  assert.equal(e.risk,'low');
  assert.equal(checksOf(null),null);
});

test('suggestion log: the same pick is logged again when a different item was demoted behind it',t=>{
  const dir=tempDir(t),log=createSuggestionLog(dir),T=Date.UTC(2026,8,19);
  const s={itemId:2,name:'Steel cannonball',action:'buy',source:'personal',quantity:100,buyPrice:243,sellPrice:249};
  const demoted=id=>({demotedPicks:[{itemId:id,name:'x'}]});
  assert.equal(log.record({account:'a',suggestion:s,now:T,context:demoted(7)}),true);
  assert.equal(log.record({account:'a',suggestion:s,now:T+2000,context:demoted(7)}),false,'same call, same poll flood guard');
  assert.equal(log.record({account:'a',suggestion:s,now:T+4000,context:demoted(8)}),true,'a different demotion is a different call');
  const lines=fs.readFileSync(log.file,'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l=>l.demotedPicks[0].itemId),[7,8]);
});

function fakeWiki(calls){
  return async url=>{
    const ts=Number(new URL(url).searchParams.get('timestamp'));calls.push(ts);
    return JSON.stringify({timestamp:ts,data:{2:{avgHighPrice:249,highPriceVolume:1000,avgLowPrice:243,lowPriceVolume:900},4151:{avgHighPrice:null,highPriceVolume:0,avgLowPrice:1500000,lowPriceVolume:3}}});
  };
}

test('price archive: on by default, but a stored choice to switch it off still wins',async t=>{
  // It was off by default until 27 Sept 2026, and the only switch was behind the browser scanner's
  // cookie -- which is in neither published repository, so no Plugin Hub user ever had an archive and
  // the three checks that read one silently did nothing. See the comment on `settings` in
  // priceArchive.mjs. The windows are asserted because they are sized for those checks, not research.
  const dir=tempDir(t),calls=[];
  const a=createPriceArchive({dir,fetchText:fakeWiki(calls),now:()=>Date.UTC(2026,8,17,12,30)});
  assert.equal(a.status().enabled,true);
  // 4 days = 96 hourly requests, one every GAP_MS, which clears thinMarket's 72-hour bar in a single
  // pass. The five-minute stream tracks forward with no backfill at all: the crash watch only looks at
  // the last 45 minutes, so history would be requests spent on nothing.
  assert.equal(a.status().backfillDays,4,'the smallest window that clears the 72-hour bar');
  assert.equal(a.status().steps['5m'].enabled,true,'the crash watch reads this stream and nothing else feeds it');
  assert.equal(a.status().steps['5m'].backfillDays,0,'forward only -- history buys the crash watch nothing');
  assert.equal(typeof await a.step(),'number','it fetches without being asked twice');
  assert.ok(calls.length>0);

  // The half that matters for anyone who turned it off on purpose: a stored false is not overridden by
  // the new default, because saved settings are spread over the defaults rather than under them.
  const off=tempDir(t);
  fs.writeFileSync(path.join(off,'settings.json'),JSON.stringify({priceArchive:{enabled:false,fiveMinute:{enabled:false}}}));
  const b=createPriceArchive({dir:off,fetchText:fakeWiki([]),now:()=>Date.UTC(2026,8,17,12,30)});
  assert.equal(b.status().enabled,false,'a deliberate off is never quietly flipped back on');
  assert.equal(await b.step(),null);
});

test('price archive: newest complete hour first, then backfill, one request per step, nulls kept, survives restart',async t=>{
  const dir=tempDir(t),calls=[];let clock=Date.UTC(2026,8,17,12,30);
  const a=createPriceArchive({dir,fetchText:fakeWiki(calls),now:()=>clock});
  // The five-minute stream is on by default now, and it would otherwise be served after the hourly
  // one and inflate every count below. This test is about the hourly stream, so it says so.
  a.configure({enabled:true,backfillDays:1,fiveMinute:{enabled:false}});
  const newest=Date.UTC(2026,8,17,11)/1000; // 12:30 -> the 11:00-12:00 hour is the newest complete one
  assert.equal(await a.step(),newest);assert.deepEqual(calls,[newest]);
  assert.equal(await a.step(),newest-HOUR);
  while(await a.step()!==null);
  assert.equal(calls.length,25,'newest hour plus 24 hours of backfill, each fetched exactly once');
  assert.equal(a.status().catchingUp,false);
  const buckets=readArchive(dir);
  assert.equal(buckets.length,25);assert.equal(buckets[0].ts,newest-24*HOUR);
  assert.deepEqual(buckets.at(-1).d['4151'],[null,0,1500000,3],'a missing price stays null, never filled in');
  // Restart: the index is reloaded, nothing is fetched again until a new hour completes.
  const b=createPriceArchive({dir,fetchText:fakeWiki(calls),now:()=>clock});
  assert.equal(b.status().enabled,true,'the switch is remembered');assert.equal(b.status().hoursStored,25);
  assert.equal(await b.step(),null);
  clock+=HOUR*1000;assert.equal(await b.step(),newest+HOUR);
  assert.throws(()=>b.configure({backfillDays:400}),/0-90/);
  assert.equal(zlib.gunzipSync(fs.readFileSync(path.join(dir,'price-archive','1h-2026-09.jsonl.gz'))).toString().trim().split('\n').length,26);
});

// The 5m stream costs over four times what the hourly one does (~95 MB a month against ~22 MB), so
// it is switched on separately and must never quietly follow the hourly switch.
function fakeWikiSteps(calls){
  return async url=>{
    const u=new URL(url);const ts=Number(u.searchParams.get('timestamp'));
    calls.push({step:u.pathname.endsWith('/5m')?'5m':'1h',ts});
    return JSON.stringify({timestamp:ts,data:{2:{avgHighPrice:249,highPriceVolume:1000,avgLowPrice:243,lowPriceVolume:900}}});
  };
}

test('price archive: five-minute data is a separate switch, independently controllable',async t=>{
  // Both streams are on by default since 27 Sept, but they remain two switches rather than one: the
  // five-minute stream can be turned off while the hourly one keeps running, which is what this asserts
  // now that "on by default" has replaced the old "switching hourly on must not start 5m".
  const dir=tempDir(t),calls=[];
  const a=createPriceArchive({dir,fetchText:fakeWikiSteps(calls),now:()=>Date.UTC(2026,8,17,12,30)});
  a.configure({enabled:true,backfillDays:0,fiveMinute:{enabled:false}});
  while(await a.step()!==null);
  assert.ok(calls.length>0,'the hourly stream still runs');
  assert.equal(calls.filter(c=>c.step==='5m').length,0,'the five-minute stream stays off when told to');
  assert.equal(a.status().steps['5m'].enabled,false);
  assert.equal(a.status().steps['5m'].stored,0);
  // And back on again, without disturbing the hourly one.
  a.configure({fiveMinute:{enabled:true,backfillDays:0}});
  assert.equal(a.status().enabled,true,'the hourly stream is untouched by a five-minute change');
  assert.equal(a.status().steps['5m'].enabled,true);
  while(await a.step()!==null);
  assert.ok(calls.filter(c=>c.step==='5m').length>0,'now it fetches');
});

test('price archive: the hourly stream is served before the five-minute one, each into its own files',async t=>{
  const dir=tempDir(t),calls=[];
  const clock=Date.UTC(2026,8,17,12,30);
  const a=createPriceArchive({dir,fetchText:fakeWikiSteps(calls),now:()=>clock});
  // A day of each: 25 hourly buckets, 289 five-minute ones.
  a.configure({enabled:true,backfillDays:1,fiveMinute:{enabled:true,backfillDays:1}});
  while(await a.step()!==null);
  const firstFive=calls.findIndex(c=>c.step==='5m');
  const lastHour=calls.map(c=>c.step).lastIndexOf('1h');
  assert.ok(firstFive>lastHour,'every hourly request must come before the first 5m one, so a long 5m backfill cannot starve it');
  const hourly=readArchive(dir),five=readArchive(dir,0,Infinity,'5m');
  assert.ok(hourly.length>0&&five.length>0);
  assert.equal(readArchive(dir).length,hourly.length,'reading without a step must still mean hourly, exactly as before');
  assert.ok(five.every(b=>b.ts%300===0),'5m buckets are aligned to five minutes');
  assert.ok(fs.existsSync(path.join(dir,'price-archive','5m-2026-09.jsonl.gz')),'its own file, never mixed into the hourly one');
  // Each read returns exactly what that stream fetched and nothing from the other one. A timestamp
  // can legitimately appear in both (the 11:00 hour and the 11:00-11:05 bucket are different rows),
  // so keeping the two sets apart is what this proves.
  const fetched=step=>calls.filter(c=>c.step===step).map(c=>c.ts).sort((x,y)=>x-y);
  assert.deepEqual(hourly.map(b=>b.ts),fetched('1h'));
  assert.deepEqual(five.map(b=>b.ts),fetched('5m'));
  assert.equal(hourly.length,25);assert.equal(five.length,289);
  assert.equal(a.status().steps['1h'].catchingUp,false);
  assert.equal(a.status().steps['5m'].catchingUp,false);
  // Restart: both indexes reload, neither refetches.
  const before=calls.length;
  const b=createPriceArchive({dir,fetchText:fakeWikiSteps(calls),now:()=>clock});
  assert.equal(b.status().steps['5m'].enabled,true,'the separate switch is remembered');
  assert.equal(b.status().steps['5m'].stored,five.length);
  assert.equal(await b.step(),null);
  assert.equal(calls.length,before,'nothing refetched after a restart');
});

test('price archive: the five-minute backfill reports how many requests are left, and validates its own settings',async t=>{
  const dir=tempDir(t),calls=[];
  const a=createPriceArchive({dir,fetchText:fakeWikiSteps(calls),now:()=>Date.UTC(2026,8,17,12,30)});
  const s=a.configure({enabled:false,fiveMinute:{enabled:true,backfillDays:1}});
  // A day of five-minute buckets is 288 of them, plus the newest complete one.
  assert.equal(s.steps['5m'].remaining,289,'a user switching this on can see the size of what they started');
  assert.equal(s.steps['1h'].remaining,0,'a disabled stream has nothing outstanding');
  assert.throws(()=>a.configure({fiveMinute:{backfillDays:91}}),/0-90/);
  assert.throws(()=>a.configure({fiveMinute:{backfillDays:-1}}),/0-90/);
  assert.throws(()=>a.configure({fiveMinute:{enabled:'yes'}}),/true or false/);
  assert.throws(()=>a.configure({fiveMinute:'on'}),/must be an object/);
  assert.equal(a.status().steps['5m'].backfillDays,1,'a rejected change leaves the stored setting alone');
  assert.throws(()=>readArchive(dir,0,Infinity,'1d'),/Unknown archive step/);
});

test('price archive: switching a stream on starts it now, not at the next hour boundary',async t=>{
  const dir=tempDir(t),calls=[];
  const a=createPriceArchive({dir,fetchText:fakeWikiSteps(calls),now:()=>Date.UTC(2026,8,17,12,30),gapMs:1});
  a.configure({enabled:true,backfillDays:0});
  a.start();
  // Let the hourly stream finish and settle into its long wait for the next hour.
  await new Promise(r=>setTimeout(r,60));
  const afterHourly=calls.length;
  assert.ok(afterHourly>0,'the hourly stream ran');
  // Enabling 5m while that long wait is pending must cancel it. Without the cancel, the pending
  // timer is up to an hour away and nothing at all happens in the meantime.
  a.configure({fiveMinute:{enabled:true,backfillDays:0}});
  await new Promise(r=>setTimeout(r,60));
  a.stop();
  assert.ok(calls.some(c=>c.step==='5m'),'the newly enabled stream must start fetching without waiting for the next hour');
});

test('price archive: a failed request records the error and stores nothing',async t=>{
  const dir=tempDir(t);
  const a=createPriceArchive({dir,fetchText:async()=>{throw new Error('HTTP 503');},now:()=>Date.UTC(2026,8,17,12,30)});
  a.configure({enabled:true,backfillDays:0});
  await assert.rejects(a.step(),/503/);
  assert.equal(a.status().lastError,'HTTP 503');assert.equal(a.status().hoursStored,0);
  assert.deepEqual(compactBucket({timestamp:1,data:{}}),{ts:1,d:{}});
});

test('price archive: recent hours are served from memory and kept current as new hours arrive',async t=>{
  const dir=tempDir(t),calls=[];let clock=Date.UTC(2026,8,17,12,30);
  const a=createPriceArchive({dir,fetchText:fakeWiki(calls),now:()=>clock});
  a.configure({enabled:true,backfillDays:2});
  while(await a.step()!==null);
  const newest=Date.UTC(2026,8,17,11)/1000;
  const got=a.recentHourly(newest-11*HOUR);
  assert.equal(got.length,12);assert.equal(got.at(-1).ts,newest);
  assert.ok(a.recentHourly(0).length<=27,'only about a day is kept in memory, never the whole archive');
  clock+=HOUR*1000;await a.step();
  assert.equal(a.recentHourly(newest).at(-1).ts,newest+HOUR,'a newly stored hour is visible without rereading disk');
  const off=createPriceArchive({dir:tempDir(t),fetchText:fakeWiki([]),now:()=>clock});
  assert.deepEqual(off.recentHourly(0),[],'no archive means an empty answer, not an error');
});

test('price archive: reading from a recent time skips earlier months but returns the same rows',t=>{
  const dir=tempDir(t);fs.mkdirSync(path.join(dir,'price-archive'));
  const put=(month,ts)=>fs.appendFileSync(path.join(dir,'price-archive',`1h-${month}.jsonl.gz`),zlib.gzipSync(JSON.stringify({ts,d:{}})+'\n'));
  const aug=Date.UTC(2026,7,31,23)/1000,sep=Date.UTC(2026,8,1,0)/1000;
  put('2026-08',aug);put('2026-09',sep);
  assert.deepEqual(readArchive(dir,sep).map(b=>b.ts),[sep]);
  assert.deepEqual(readArchive(dir,aug).map(b=>b.ts),[aug,sep],'a start inside a month still reads that month');
  assert.deepEqual(readArchive(dir).map(b=>b.ts),[aug,sep]);
});
