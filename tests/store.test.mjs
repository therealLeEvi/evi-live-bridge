import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store,validatePacket,computeAutoFlips,isMarginCheck,MARGIN_CHECK_TICKS} from '../bridge/store.mjs';
const now=1700000000000;
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evi-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {dir,store:new Store(dir)};}
function offer(o={}) {return {slot:0,offerId:'buy-1',state:'BUYING',itemId:1,name:'Test rune',price:100,total:10,filled:0,spent:0,knownStart:true,...o};}
function packet(seq,offers=[offer()],other={}) {const slots=Array.from({length:8},(_,slot)=>offer({slot,offerId:'empty-'+slot,state:'EMPTY',itemId:0,name:'',price:0,total:0,knownStart:false}));for(const o of offers)slots[o.slot]=o;return {version:1,session:'session-1',account:'account-1',seq,ts:now+seq*1000,loggedIn:true,offers:slots,...other};}
function ingest(store,p){return store.ingest(p,now+100000);}
test('duplicate, stale sequence and identical snapshots do not duplicate completed trades',t=>{
  const {store,dir}=setup(t);ingest(store,packet(1));const p=packet(2,[offer({state:'BOUGHT',filled:10,spent:990})]);
  ingest(store,p);assert.equal(ingest(store,p).duplicate,true);ingest(store,packet(1));
  assert.equal(store.state().completed.length,1);assert.equal(new Store(dir).state().completed.length,1);
  assert.equal(new Store(dir).state(now).sessions[0].live,false);
});
test('partial cancellation retains executed quantity and can be matched once after review',t=>{
  const {store,dir}=setup(t);
  ingest(store,packet(1));ingest(store,packet(2,[offer({state:'CANCELLED_BUY',filled:4,spent:396})]));
  ingest(store,packet(3,[offer({state:'CANCELLED_BUY',filled:4,spent:396}),offer({slot:1,offerId:'sell-1',state:'SELLING',price:120,total:4})]));
  ingest(store,packet(4,[offer({state:'CANCELLED_BUY',filled:4,spent:396}),offer({slot:1,offerId:'sell-1',state:'SOLD',price:120,total:4,filled:4,spent:480})]));
  const f=store.confirm({buyId:'buy-1',sellId:'sell-1',netProceeds:472});assert.equal(f.profit,76);
  assert.equal(store.confirm({buyId:'buy-1',sellId:'sell-1',netProceeds:472}).id,f.id);
  assert.equal(new Store(dir).flips.length,1);
});
test('baseline completions cannot silently become known-start trades',t=>{
  const {store}=setup(t);ingest(store,packet(1,[offer({state:'BOUGHT',filled:10,spent:1000,knownStart:false})]));
  ingest(store,packet(2,[offer({state:'BOUGHT',filled:10,spent:1000,knownStart:true})]));
  assert.equal(store.state().completed[0].knownStart,false);
  assert.throws(()=>store.confirm({buyId:'buy-1',sellId:'absent',netProceeds:1000}));
});
test('reject counter regression, identity reuse, malformed slot and duplicate slot',t=>{
  const {store}=setup(t);ingest(store,packet(1,[offer({filled:5,spent:500})]));
  assert.throws(()=>ingest(store,packet(2,[offer({filled:4,spent:400})])));
  assert.throws(()=>ingest(store,packet(2,[offer({filled:5,spent:500})],{account:'other'})));
  const p=packet(2);p.offers[1].slot=0;assert.throws(()=>validatePacket(p));
  assert.throws(()=>validatePacket({...packet(2),offers:[offer()]}));
});
test('logout and stale capture remove active live offers',t=>{
  const {store}=setup(t);store.ingest(packet(1),now+1000);assert.equal(store.state(now+2000).active.length,1);
  assert.equal(store.state(now+60000).active.length,0);
  store.ingest(packet(2,[],{loggedIn:false,offers:[]}),now+2000);assert.equal(store.state(now+3000).active.length,0);
});
test('interrupted final journal line is backed up and complete records replay',t=>{
  const {store,dir}=setup(t);ingest(store,packet(1));fs.appendFileSync(store.file,'{"unfinished":');
  const reopened=new Store(dir);assert.equal(reopened.offers.size,1);assert.ok(fs.readdirSync(dir).some(x=>x.startsWith('interrupted-tail')));
});
test('cancelling before any fill and relisting does not leave a ghost completed row, and the real sale still completes',t=>{
  const {store}=setup(t);
  ingest(store,packet(1,[offer({slot:1,offerId:'sell-old',state:'SELLING',price:100,total:10,filled:0,knownStart:false})]));
  ingest(store,packet(2,[offer({slot:1,offerId:'sell-old',state:'CANCELLED_SELL',price:100,total:10,filled:0,spent:0,knownStart:false})]));
  assert.equal(store.state().completed.length,0,'an empty cancellation must not appear as a completed trade');
  ingest(store,packet(3,[offer({slot:1,offerId:'sell-new',state:'SELLING',price:100,total:10,filled:0,knownStart:true})]));
  ingest(store,packet(4,[offer({slot:1,offerId:'sell-new',state:'SOLD',price:100,total:10,filled:10,spent:1000,knownStart:true})]));
  const completed=store.state().completed;
  assert.equal(completed.length,1,'the real sale on the re-listed offer must still show up once completed');
  assert.equal(completed[0].offerId,'sell-new');
});
test('a sale split across two separate offers closes into one automatic flip with no manual review needed',t=>{
  const {store}=setup(t),base=Date.UTC(2025,6,1); // after the tax-regime cutoff so saleProceeds can compute
  const at=p=>store.ingest(p,base+100000);
  at(packet(1,[offer()],{ts:base}));
  at(packet(2,[offer({state:'BOUGHT',filled:10,spent:990})],{ts:base+1000}));
  at(packet(3,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'SELLING',price:120,total:10})],{ts:base+2000}));
  at(packet(4,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'CANCELLED_SELL',price:120,total:10,filled:6,spent:720})],{ts:base+3000}));
  at(packet(5,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'CANCELLED_SELL',price:120,total:10,filled:6,spent:720}),offer({slot:2,offerId:'sell-2',state:'SELLING',price:120,total:4})],{ts:base+4000}));
  at(packet(6,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'CANCELLED_SELL',price:120,total:10,filled:6,spent:720}),offer({slot:2,offerId:'sell-2',state:'SOLD',price:120,total:4,filled:4,spent:480})],{ts:base+5000}));
  const state=store.state();
  assert.equal(state.flips.length,0,'no manual review was performed');
  assert.equal(state.autoFlips.length,1);
  assert.equal(state.autoFlips[0].sellIds.length,2);
  assert.equal(state.autoFlips[0].profit,190);
  assert.equal(state.netProfit,190);
  assert.equal(state.tradeCount,1);
});
test('a manually reviewed flip is excluded from automatic matching so it is never counted twice',t=>{
  const {store}=setup(t),base=Date.UTC(2025,6,1);
  const at=p=>store.ingest(p,base+100000);
  at(packet(1,[offer()],{ts:base}));
  at(packet(2,[offer({state:'BOUGHT',filled:10,spent:990})],{ts:base+1000}));
  at(packet(3,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'SELLING',price:120,total:10})],{ts:base+2000}));
  at(packet(4,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'SOLD',price:120,total:10,filled:10,spent:1200})],{ts:base+3000}));
  assert.equal(store.state().autoFlips.length,1,'matched automatically before any manual review');
  const f=store.confirm({buyId:'buy-1',sellId:'sell-1',netProceeds:1176});
  const state=store.state();
  assert.equal(state.flips.length,1);
  assert.equal(state.autoFlips.length,0,'now claimed by the manual flip, so it drops out of the automatic pool');
  assert.equal(state.netProfit,f.profit);
  assert.equal(state.tradeCount,1);
});
test('an unsold buy is reported as an open position, not counted as profit, and does not crash',t=>{
  const {store}=setup(t),base=Date.UTC(2025,6,1);
  const at=p=>store.ingest(p,base+100000);
  at(packet(1,[offer()],{ts:base}));
  at(packet(2,[offer({state:'BOUGHT',filled:10,spent:990})],{ts:base+1000}));
  const state=store.state();
  assert.equal(state.autoFlips.length,0);
  assert.equal(state.autoOpenPositions.length,1);
  assert.equal(state.autoOpenPositions[0].remaining,10);
  assert.equal(state.autoOpenPositions[0].partiallySold,false);
  assert.equal(state.netProfit,0);
  assert.equal(state.tradeCount,0);
});
test('a buy flagged personal use drops out of open positions and never counts toward profit even if later sold; unflagging restores it, and the flag survives a restart',t=>{
  const {store,dir}=setup(t),base=Date.UTC(2025,6,1);
  const at=p=>store.ingest(p,base+100000);
  at(packet(1,[offer()],{ts:base}));
  at(packet(2,[offer({state:'BOUGHT',filled:10,spent:990})],{ts:base+1000}));
  assert.equal(store.state().autoOpenPositions.length,1,'an ordinary unsold buy is an open position before any flag');
  assert.throws(()=>store.markPersonalUse({buyId:'no-such-offer',personal:true}),/Unknown or not-yet-observed buy/);
  assert.throws(()=>store.markPersonalUse({buyId:'buy-1',personal:'yes'}),/Missing personal flag/);
  store.markPersonalUse({buyId:'buy-1',personal:true});
  let state=store.state();
  assert.equal(state.autoOpenPositions.length,0,'flagged buy no longer surfaces as something to sell');
  assert.deepEqual(state.personalUseBuyIds,['buy-1']);
  assert.deepEqual(state.personalUseItemIds,[1],'the itemId behind the flagged buy must be derivable, for the inventory-scan blocklist');
  assert.deepEqual(new Store(dir).state().personalUseBuyIds,['buy-1'],'the flag itself must survive a bridge restart');
  at(packet(3,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'SELLING',price:120,total:10})],{ts:base+2000}));
  at(packet(4,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'sell-1',state:'SOLD',price:120,total:10,filled:10,spent:1200})],{ts:base+3000}));
  state=store.state();
  assert.equal(state.autoFlips.length,0,'the personal-use buy can never be matched into a flip, even once sold');
  assert.equal(state.netProfit,0,'a personal-use sale must never inflate or deflate the profit total');
  assert.equal(state.autoUnmatchedSells.length,1,'the sale itself still shows up, just as unmatched, not silently dropped');
  store.markPersonalUse({buyId:'buy-1',personal:false});
  assert.deepEqual(store.state().personalUseBuyIds,[]);
  assert.deepEqual(store.state().personalUseItemIds,[]);
});
test('personalUseItemIds only reflects currently-flagged buys, and never affects a separate, unflagged buy of the same item',t=>{
  const {store}=setup(t),base=Date.UTC(2025,6,1);
  const at=p=>store.ingest(p,base+100000);
  at(packet(1,[offer()],{ts:base}));
  at(packet(2,[offer({state:'BOUGHT',filled:10,spent:990})],{ts:base+1000}));
  at(packet(3,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'buy-2',state:'BUYING',itemId:1,name:'Test rune',price:100,total:5})],{ts:base+2000}));
  at(packet(4,[offer({state:'BOUGHT',filled:10,spent:990}),offer({slot:1,offerId:'buy-2',state:'BOUGHT',itemId:1,name:'Test rune',price:100,total:5,filled:5,spent:495})],{ts:base+3000}));
  store.markPersonalUse({buyId:'buy-1',personal:true});
  const state=store.state();
  assert.deepEqual(state.personalUseItemIds,[1]);
  // Even though item 1's ID is in personalUseItemIds, the OTHER buy of the same item (buy-2) is
  // untouched -- it's still a real open position, exactly as the flip-scoped (not item-scoped)
  // design intends. personalUseItemIds is only ever consulted by the caller's inventory-scan
  // blocklist, never by computeAutoFlips itself.
  assert.equal(state.autoOpenPositions.some(p=>p.buyId==='buy-2'),true);
});
test('computeAutoFlips is pure: a sell with no preceding buy is reported as unmatched, not silently dropped',()=>{
  const base=Date.UTC(2025,6,1);
  const lonelySell={offerId:'sell-1',account:'account-1',itemId:1,name:'Test rune',state:'SOLD',price:120,total:5,filled:5,spent:600,firstSeen:base,completedAt:base,knownStart:true};
  const result=computeAutoFlips([lonelySell]);
  assert.equal(result.flips.length,0);
  assert.equal(result.unmatchedSells.length,1);
  assert.equal(result.unmatchedSells[0].unmatchedQty,5);
});
// unitCost on an open (unsold) position: the real cost-basis figure a cross-restart "you're still
// holding this" reminder needs to say whether selling now would be a profit or a loss (see
// computeHoldingSuggestion in suggestions.mjs, and pickPersistentOpenPosition which passes an
// openPositions entry straight through unchanged). Must be the actual spent/filled from the real
// buy fill, never the offer's set/max price.
test('computeAutoFlips: an open position carries its real unitCost (spent/filled), not the offer\'s set price',()=>{
  const base=Date.UTC(2025,6,1);
  const buy={offerId:'buy-1',account:'account-1',itemId:1,name:'Test rune',state:'BOUGHT',price:105,total:1000,filled:1000,spent:98765,firstSeen:base,completedAt:base,knownStart:true};
  const result=computeAutoFlips([buy]);
  assert.equal(result.openPositions.length,1);
  assert.equal(result.openPositions[0].unitCost,98.765,'unitCost must be the real spent/filled average (98765/1000), not the offer\'s set price of 105');
});
test('computeAutoFlips: a fully-matched flip (no open position left) still computes correctly with unitCost tracked internally',()=>{
  const base=Date.UTC(2025,6,1);
  const buy={offerId:'buy-1',account:'account-1',itemId:1,name:'Test rune',state:'BOUGHT',price:100,total:10,filled:10,spent:1000,firstSeen:base,completedAt:base,knownStart:true};
  const sell={offerId:'sell-1',account:'account-1',itemId:1,name:'Test rune',state:'SOLD',price:120,total:10,filled:10,spent:1200,firstSeen:base+1000,completedAt:base+1000,knownStart:true};
  const result=computeAutoFlips([buy,sell]);
  assert.equal(result.openPositions.length,0,'a fully-sold lot must leave no open position at all');
  assert.equal(result.flips.length,1);
});

// ---- Login-time continuity, closing positions, proceeds messages (2026-09-17) ----
// Real dates (after the 2025-05-30 tax change) so sales get a usable tax calculation.
const T0=Date.UTC(2026,8,17,10);
function at(store,p){return store.ingest(p,p.ts+1000);}
function lines(dir){return fs.readFileSync(path.join(dir,'events.jsonl'),'utf8').split('\n').filter(Boolean).length;}
test('an offer first seen at login is linked to the same offer from an earlier session, so its sale matches its buy',t=>{
  const {store,dir}=setup(t);
  const buy=offer({offerId:'buy-1',state:'BOUGHT',filled:10,spent:1000});
  at(store,packet(1,[offer({offerId:'buy-1'})],{ts:T0}));
  at(store,packet(2,[buy],{ts:T0+1000}));
  // Buy collected (slot 0 empties), sale placed in slot 1 and still selling when the client restarts.
  at(store,packet(3,[offer({slot:1,offerId:'sell-1',state:'SELLING',price:120,total:10})],{ts:T0+2000}));
  // New session: the plugin re-IDs the now-completed sale at login with knownStart=false.
  const relog=offer({slot:1,offerId:'relogged-sell',state:'SOLD',price:120,total:10,filled:10,spent:1200,knownStart:false});
  at(store,packet(1,[relog],{session:'session-2',ts:T0+3600000}));
  let s=store.state(T0+3600000);
  assert.equal(s.linkedLoginOffers,1);
  assert.equal(s.completed.filter(o=>o.itemId===1&&o.state==='SOLD').length,1,'one real sale, not a separate baseline copy');
  assert.equal(s.completed.find(o=>o.state==='SOLD').offerId,'sell-1');
  assert.equal(s.completed.find(o=>o.state==='SOLD').knownStart,true,'keeps the coverage of the record EVI watched start');
  assert.equal(s.autoFlips.length,1);assert.equal(s.autoFlips[0].profit,1200-20-1000,'10 sold at 120 (tax rounds down to 2 GP each) against 10 x 100 cost');
  assert.equal(s.autoOpenPositions.length,0,'the sold buy must no longer look held');
  // Heartbeats of the linked offer must not be journaled as changes.
  const before=lines(dir);at(store,packet(2,[relog],{session:'session-2',ts:T0+3610000}));assert.equal(lines(dir),before);
  // Replaying the journal reproduces the same link.
  s=new Store(dir).state(T0+3700000);assert.equal(s.autoFlips.length,1);assert.equal(s.completed.filter(o=>o.state==='SOLD').length,1);
});
test('a login-time offer is NOT linked when the earlier offer was seen leaving its slot',t=>{
  const {store}=setup(t);
  at(store,packet(1,[offer({slot:1,offerId:'sell-1',state:'SOLD',price:120,total:10,filled:10,spent:1200})],{ts:T0}));
  at(store,packet(2,[],{ts:T0+1000})); // collected: slot 1 is empty again in the same session
  at(store,packet(1,[offer({slot:1,offerId:'other',state:'SOLD',price:120,total:10,filled:10,spent:1200,knownStart:false})],{session:'session-2',ts:T0+7200000}));
  const s=store.state(T0+7200000);
  assert.equal(s.linkedLoginOffers,0);
  assert.equal(s.completed.length,2,'a genuinely new identical sale stays its own record');
});
test('closing a partly sold position keeps the sold part as profit, stops the reminder, and can be undone',t=>{
  const {store,dir}=setup(t);
  at(store,packet(1,[offer({offerId:'buy-1',total:13})],{ts:T0}));
  at(store,packet(2,[offer({offerId:'buy-1',total:13,state:'BOUGHT',filled:13,spent:1300})],{ts:T0+1000}));
  at(store,packet(3,[offer({slot:1,offerId:'sell-1',state:'SELLING',price:150,total:11})],{ts:T0+2000}));
  at(store,packet(4,[offer({slot:1,offerId:'sell-1',state:'SOLD',price:150,total:11,filled:11,spent:1650})],{ts:T0+3000}));
  let s=store.state(T0+4000);
  assert.equal(s.autoOpenPositions.length,1);assert.equal(s.autoOpenPositions[0].remaining,2);
  assert.throws(()=>store.confirm({buyId:'buy-1',sellIds:['sell-1']}),/total 11 items but the purchase was 13/);
  assert.throws(()=>store.closePosition({buyId:'buy-1',reason:'lost'},T0+5000),/Choose why/);
  store.closePosition({buyId:'buy-1',reason:'used'},T0+5000);
  s=store.state(T0+6000);
  assert.equal(s.autoOpenPositions.length,0);
  assert.equal(s.autoFlips.length,1);
  assert.equal(s.autoFlips[0].quantity,11);assert.equal(s.autoFlips[0].partial,true);
  assert.equal(s.autoFlips[0].profit,1650-33-1100,'11 sold at 150 (3 GP tax each) against 11 x 100 cost; the 2 used are left out');
  assert.equal(new Store(dir).state(T0+7000).autoOpenPositions.length,0,'closing survives a bridge restart');
  store.closePosition({buyId:'buy-1',closed:false},T0+8000);
  s=store.state(T0+9000);assert.equal(s.autoOpenPositions.length,1);assert.equal(s.autoFlips.length,0);
  assert.throws(()=>store.closePosition({buyId:'sell-1',reason:'used'},T0+9000),/not an open position/);
});
test('proceeds override errors say what is actually wrong instead of "must be greater than zero"',t=>{
  const {store}=setup(t);
  at(store,packet(1,[offer({offerId:'buy-1'})],{ts:T0}));
  at(store,packet(2,[offer({offerId:'buy-1',state:'BOUGHT',filled:10,spent:1000})],{ts:T0+1000}));
  at(store,packet(3,[offer({slot:1,offerId:'sell-1',state:'SELLING',price:120,total:10})],{ts:T0+2000}));
  at(store,packet(4,[offer({slot:1,offerId:'sell-1',state:'SOLD',price:120,total:10,filled:10,spent:1200})],{ts:T0+3000}));
  assert.throws(()=>store.confirm({buyId:'buy-1',sellIds:['sell-1'],netProceeds:5000}),/more than the GE reported .*1,200 GP before tax/);
  assert.throws(()=>store.confirm({buyId:'buy-1',sellIds:['sell-1'],netProceeds:0}),/greater than zero/);
  assert.equal(store.confirm({buyId:'buy-1',sellIds:['sell-1'],netProceeds:1176}).profit,176);
});

test('buyLimitUsage counts only this account\'s observed buys of this item inside the 4-hour window',t=>{
  const {store}=setup(t);
  at(store,packet(1,[offer({offerId:'buy-1',state:'BOUGHT',total:600,filled:600,spent:60000})],{ts:T0}));
  at(store,packet(2,[offer({slot:1,offerId:'sell-1',state:'SOLD',price:120,total:100,filled:100,spent:12000})],{ts:T0+1000}));
  at(store,packet(3,[offer({slot:2,offerId:'buy-other-item',state:'BOUGHT',itemId:99,total:400,filled:400,spent:40000})],{ts:T0+2000}));
  const usage=store.buyLimitUsage('account-1',1,T0+3600000);
  assert.equal(usage.used,600,'sales and other items must not count toward this item\'s buy limit');
  assert.equal(store.buyLimitUsage('account-1',99,T0+3600000).used,400);
  assert.equal(store.buyLimitUsage('other-account',1,T0+3600000).used,0);
  assert.equal(store.buyLimitUsage('account-1',1,T0+5*3600000).used,0,'a buy older than four hours has left the window');
  assert.equal(usage.windowEndsAt,T0+4*3600000);
});

test('imported flips rank suggestions but never change the observed-profit total',t=>{
  const {store,dir}=setup(t);
  at(store,packet(1,[offer({offerId:'buy-1'})],{ts:T0}));
  at(store,packet(2,[offer({offerId:'buy-1',state:'BOUGHT',filled:10,spent:1000})],{ts:T0+1000}));
  const before=store.state(T0+2000);
  const flip=(o={})=>({fp:'copilot|whip|1',itemId:4151,item:'Abyssal whip',quantity:2,capital:2000000,profit:150000,firstBuy:T0-86400000,lastSell:T0-80000000,account:'le evi',...o});
  const r=store.importFlips({source:'copilot',flips:[flip(),flip({fp:'copilot|nails|1',itemId:1,item:'Rune nails',quantity:100,capital:10000,profit:2000})]});
  assert.equal(r.accepted,2);
  const s=store.state(T0+3000);
  assert.equal(s.importedFlips.length,2);
  assert.equal(s.netProfit,before.netProfit,'the observed-profit total must not move');
  assert.equal(s.tradeCount,before.tradeCount,'nor the observed trade count');
  assert.equal(s.importedSummary.count,2);
  assert.equal(s.importedSummary.profit,152000);
  assert.equal(s.importedSummary.items,2);
  // Re-importing the same file is a no-op, across a restart too.
  assert.deepEqual(store.importFlips({source:'copilot',flips:[flip()]}),{accepted:0,duplicates:1,total:2});
  const reopened=new Store(dir).state(T0+4000);
  assert.equal(reopened.importedFlips.length,2,'imports survive a bridge restart');
  assert.equal(reopened.importedFlips[0].netProceeds,2150000,'netProceeds is derived from capital + profit');
  assert.ok(reopened.importedFlips[0].hold>0);
  // Undo: an import the player regrets can be dropped by source, and survives a restart.
  assert.deepEqual(store.importFlips({source:'copilot',remove:true}),{removed:2,total:0});
  assert.equal(store.state(T0+5000).importedFlips.length,0);
  assert.equal(new Store(dir).state(T0+6000).importedFlips.length,0);
  assert.equal(store.importFlips({source:'copilot',flips:[flip()]}).accepted,1,'after an undo the same file can be imported again');
});
test('importFlips rejects malformed rows rather than storing half-understood trades',t=>{
  const {store}=setup(t);
  const good={fp:'a',itemId:1,item:'Rune nails',quantity:10,capital:100,profit:50,firstBuy:T0,lastSell:T0+1000};
  assert.throws(()=>store.importFlips({source:'',flips:[good]}),/Name the import source/);
  assert.throws(()=>store.importFlips({source:'copilot',flips:[]}),/between 1 and 500/);
  assert.throws(()=>store.importFlips({source:'copilot',flips:[{...good,itemId:0}]}),/resolved itemId/,'an unresolved item name must never be stored as item 0');
  assert.throws(()=>store.importFlips({source:'copilot',flips:[{...good,fp:''}]}),/fingerprint/);
  assert.throws(()=>store.importFlips({source:'copilot',flips:[{...good,profit:1.5}]}),/quantity, capital or profit/);
  assert.throws(()=>store.importFlips({source:'copilot',flips:[{...good,lastSell:0}]}),/timestamps/);
  assert.equal(store.state().importedFlips.length,0);
});

// ---- Margin checks: the one-item probe used to discover a real spread. Not a trade. ----
const probe=(o={})=>({slot:0,offerId:'probe-1',state:'BOUGHT',itemId:1,name:'Test rune',price:200,total:1,filled:1,spent:200,knownStart:true,ticksToFill:1,...o});
test('a one-item offer that filled within a couple of ticks is a margin check; anything else is not',()=>{
  assert.equal(isMarginCheck(probe()),true);
  assert.equal(isMarginCheck(probe({ticksToFill:0})),true);
  assert.equal(isMarginCheck(probe({ticksToFill:MARGIN_CHECK_TICKS})),true);
  assert.equal(isMarginCheck(probe({ticksToFill:MARGIN_CHECK_TICKS+1})),false,'a slower fill is a real trade');
  assert.equal(isMarginCheck(probe({ticksToFill:-1})),false,'unknown must never be treated as a probe');
  assert.equal(isMarginCheck(probe({ticksToFill:undefined})),false,'an older plugin that sends nothing must not have its trades deleted');
  assert.equal(isMarginCheck(probe({total:2,filled:2})),false,'two items is a trade, however fast');
  assert.equal(isMarginCheck(probe({filled:0})),false);
  assert.equal(isMarginCheck(null),false);
});
test('margin checks never become flips or open positions, and the real trade around them still matches',t=>{
  const {store}=setup(t);
  // A probe: buy 1 high, sell 1 low, both instant. Then a real 10-item flip of the same item.
  at(store,packet(1,[probe({offerId:'probe-buy',state:'BUYING',filled:0,spent:0,ticksToFill:-1})],{ts:T0}));
  at(store,packet(2,[probe({offerId:'probe-buy',price:200,spent:200})],{ts:T0+1000}));
  at(store,packet(3,[probe({offerId:'probe-buy',price:200,spent:200}),probe({slot:1,offerId:'probe-sell',state:'SOLD',price:100,spent:100})],{ts:T0+2000}));
  at(store,packet(4,[offer({offerId:'real-buy',state:'BOUGHT',total:10,filled:10,spent:1000,ticksToFill:50})],{ts:T0+3000}));
  at(store,packet(5,[offer({offerId:'real-buy',state:'BOUGHT',total:10,filled:10,spent:1000,ticksToFill:50}),
    offer({slot:1,offerId:'real-sell',state:'SOLD',price:130,total:10,filled:10,spent:1300,ticksToFill:80})],{ts:T0+4000}));
  const s=store.state(T0+5000);
  assert.equal(s.autoFlips.length,1,'only the real 10-item flip counts');
  assert.equal(s.autoFlips[0].quantity,10);
  assert.equal(s.autoOpenPositions.length,0,'the probe must not leave a phantom open position');
  const probes=s.completed.filter(o=>o.marginCheck);
  assert.equal(probes.length,2,'both sides of the probe are still visible, just labelled');
  assert.ok(s.completed.some(o=>o.offerId==='real-buy'&&!o.marginCheck));
});
test('an offer with no tick information is still matched exactly as before',t=>{
  const {store}=setup(t);
  at(store,packet(1,[offer({offerId:'b',state:'BOUGHT',total:1,filled:1,spent:100})],{ts:T0}));
  at(store,packet(2,[offer({offerId:'b',state:'BOUGHT',total:1,filled:1,spent:100}),
    offer({slot:1,offerId:'s',state:'SOLD',price:130,total:1,filled:1,spent:130})],{ts:T0+1000}));
  const s=store.state(T0+2000);
  assert.equal(s.autoFlips.length,1,'without ticks, a one-item flip is a normal trade');
  assert.equal(s.completed.every(o=>o.marginCheck===false),true);
});
test('validatePacket accepts the optional tick field, rejects nonsense, and defaults it to unknown',()=>{
  const withTicks=validatePacket(packet(1,[offer({ticksToFill:7})]));
  assert.equal(withTicks.offers.find(o=>o.offerId==='buy-1').ticksToFill,7);
  const without=validatePacket(packet(1,[offer()]));
  assert.equal(without.offers.find(o=>o.offerId==='buy-1').ticksToFill,-1,'older plugins simply do not send it');
  assert.throws(()=>validatePacket(packet(1,[offer({ticksToFill:1.5})])),/ticksToFill/);
  assert.throws(()=>validatePacket(packet(1,[offer({ticksToFill:-5})])),/ticksToFill/);
});
