import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {createSuggestionLog} from '../bridge/suggestionLog.mjs';
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
});

function fakeWiki(calls){
  return async url=>{
    const ts=Number(new URL(url).searchParams.get('timestamp'));calls.push(ts);
    return JSON.stringify({timestamp:ts,data:{2:{avgHighPrice:249,highPriceVolume:1000,avgLowPrice:243,lowPriceVolume:900},4151:{avgHighPrice:null,highPriceVolume:0,avgLowPrice:1500000,lowPriceVolume:3}}});
  };
}

test('price archive: off by default, fetches nothing until switched on',async t=>{
  const dir=tempDir(t),calls=[];
  const a=createPriceArchive({dir,fetchText:fakeWiki(calls),now:()=>Date.UTC(2026,8,17,12,30)});
  assert.equal(a.status().enabled,false);
  assert.equal(await a.step(),null);assert.equal(calls.length,0);
});

test('price archive: newest complete hour first, then backfill, one request per step, nulls kept, survives restart',async t=>{
  const dir=tempDir(t),calls=[];let clock=Date.UTC(2026,8,17,12,30);
  const a=createPriceArchive({dir,fetchText:fakeWiki(calls),now:()=>clock});
  a.configure({enabled:true,backfillDays:1});
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

test('price archive: a failed request records the error and stores nothing',async t=>{
  const dir=tempDir(t);
  const a=createPriceArchive({dir,fetchText:async()=>{throw new Error('HTTP 503');},now:()=>Date.UTC(2026,8,17,12,30)});
  a.configure({enabled:true,backfillDays:0});
  await assert.rejects(a.step(),/503/);
  assert.equal(a.status().lastError,'HTTP 503');assert.equal(a.status().hoursStored,0);
  assert.deepEqual(compactBucket({timestamp:1,data:{}}),{ts:1,d:{}});
});
