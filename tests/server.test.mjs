import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createBridge} from '../bridge/server.mjs';
test('loopback bridge protects personal scanner, API, origins, keys and static paths',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evi-http-'));
  const port=51749,app=createBridge({dir,port});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const get=(p,opts)=>fetch(app.origin+p,opts);
  assert.equal(app.server.address().address,'127.0.0.1');
  assert.equal((await get('/api/state')).status,401);
  assert.equal((await get('/live.js')).status,401);
  const lock=await (await get('/')).text();assert.ok(lock.includes('Scanner key'));assert.ok(!lock.includes('DEFAULT_HISTORY'));
  const badHost=await new Promise((resolve,reject)=>{http.get(app.origin+'/',{headers:{Host:'evil.example'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
  assert.equal(badHost,403);
  assert.equal((await get('/',{headers:{Origin:'https://evil.example'}})).status,403);
  const headers={'Content-Type':'application/json',Origin:app.origin};
  assert.equal((await get('/api/unlock',{method:'POST',headers,body:'{"token":"bad"}'})).status,401);
  const r=await get('/api/unlock',{method:'POST',headers,body:JSON.stringify({token:app.secrets.scanner})});assert.equal(r.status,200);
  const cookie=r.headers.get('set-cookie').split(';')[0];assert.ok(r.headers.get('set-cookie').includes('HttpOnly'));
  assert.equal((await get('/api/state',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await get('/api/flips',{method:'POST',headers:{...headers,Cookie:cookie},body:'{}'})).status,403);
  assert.equal((await get('/api/events',{method:'POST',headers:{...headers,Authorization:'Bearer '+app.secrets.scanner},body:'{}'})).status,401);
  assert.equal((await get('/api/events',{method:'POST',headers:{...headers,Authorization:'Bearer '+app.secrets.plugin},body:'{}'})).status,400);
  // A Content-Type may carry parameters, and an exact-match check rejected the plugin's own posts
  // with a 400 the moment it moved to RuneLite's OkHttpClient, which sends
  // "application/json; charset=utf-8" for a string body. The media type is what matters; a 400 here
  // must mean the BODY was bad (as above), never the header's charset.
  // Both cases answer 400, so the status alone proves nothing -- the error text is what says whether
  // the header or the body was the problem.
  const postEvents=async ct=>(await (await get('/api/events',{method:'POST',headers:{'Content-Type':ct,Origin:app.origin,Authorization:'Bearer '+app.secrets.plugin},body:'{}'})).json()).error;
  assert.notEqual(await postEvents('application/json; charset=utf-8'),'JSON required','a charset parameter must be accepted, leaving only the empty body to reject');
  assert.notEqual(await postEvents('APPLICATION/JSON'),'JSON required','the media type is case-insensitive per RFC 9110');
  assert.equal(await postEvents('text/plain'),'JSON required','a genuinely wrong media type is still refused');
  assert.equal((await get('/api/suggestion')).status,401);
  assert.equal((await get('/api/suggestion',{headers:{Authorization:'Bearer '+app.secrets.scanner}})).status,401);
  assert.equal((await get('/api/suggestion/personal-use',{method:'POST',headers,body:'{}'})).status,401);
  assert.equal((await get('/api/suggestion/personal-use',{method:'POST',headers:{...headers,Authorization:'Bearer '+app.secrets.scanner},body:'{}'})).status,401);
  assert.equal((await get('/api/suggestion/personal-use',{method:'POST',headers:{...headers,Authorization:'Bearer '+app.secrets.plugin},body:'{}'})).status,400,'a body with no real buyId must be rejected, not silently accepted');
  // The plugin's "I don't have this anymore" endpoint: plugin key only, and a body with no real
  // open position is rejected rather than silently accepted, exactly like personal-use above.
  assert.equal((await get('/api/suggestion/not-held',{method:'POST',headers,body:'{}'})).status,401);
  assert.equal((await get('/api/suggestion/not-held',{method:'POST',headers:{...headers,Authorization:'Bearer '+app.secrets.scanner},body:'{}'})).status,401);
  assert.equal((await get('/api/suggestion/not-held',{method:'POST',headers:{...headers,Authorization:'Bearer '+app.secrets.plugin},body:JSON.stringify({buyId:'no-such-buy'})})).status,400);
  // The scanner's own close endpoint stays scanner-gated (UI origin + unlocked cookie).
  assert.equal((await get('/api/positions/close',{method:'POST',headers,body:'{}'})).status,401);
  // EVI's own scorecard: scanner-gated like every other view of the player's data.
  assert.equal((await get('/api/suggestion-outcomes')).status,401);
  const scored=await get('/api/suggestion-outcomes',{headers:{Cookie:cookie}});
  assert.equal(scored.status,200);
  const scoredBody=await scored.json();
  assert.equal(scoredBody.summary.shown,0,'a fresh bridge has nothing to score yet');
  assert.deepEqual(scoredBody.recent,[]);
  assert.equal((await get('/data/keys.json',{headers:{Cookie:cookie}})).status,404);
  assert.equal((await get('/api/market/anything?url=https://evil.example',{headers:{Cookie:cookie}})).status,404);
  // The browser scanner is optional: the bridge is published and usable on its own (the RuneLite
  // plugin only needs the API), so an install without the scanner folder must answer with a plain
  // "not installed" 404 rather than an error, while a full install serves the dashboard.
  const html=await get('/',{headers:{Cookie:cookie}});
  if(html.status===200)assert.ok((await html.text()).includes('Live RuneLite'));
  else {assert.equal(html.status,404);assert.match((await html.json()).error,/scanner is not installed/);}
  assert.equal(html.headers.get('access-control-allow-origin'),null);
  const crossSite=(pathname,extra={})=>new Promise((resolve,reject)=>{
    http.get(app.origin+pathname,{headers:{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document',Cookie:cookie,...extra}},r=>{
      let body='';r.setEncoding('utf8');r.on('data',chunk=>body+=chunk);r.on('end',()=>resolve({status:r.statusCode,body}));
    }).on('error',reject);
  });
  const linked=await crossSite('/');assert.equal(linked.status,200);assert.ok(linked.body.includes('Scanner key'));assert.ok(!linked.body.includes('DEFAULT_HISTORY'));
  assert.equal((await crossSite('/api/state')).status,403);
  assert.equal((await crossSite('/live.js')).status,403);
  assert.equal((await crossSite('/',{'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'})).status,403);
  assert.equal((await crossSite('/',{'Sec-Fetch-Dest':'iframe'})).status,403);
  assert.equal((await crossSite('/',{Origin:'https://evil.example'})).status,403);
});

test('POST /api/scanner-suggestions requires the unlocked scanner cookie + UI origin, and validates its payload',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evi-http-'));
  const port=51750,app=createBridge({dir,port});await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>app.server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const get=(p,opts)=>fetch(app.origin+p,opts);
  const headers={'Content-Type':'application/json',Origin:app.origin};
  assert.equal((await get('/api/scanner-suggestions',{method:'POST',headers,body:'{}'})).status,401,'must be unlocked (scanner cookie) first, same as every other scanner POST');
  const r=await get('/api/unlock',{method:'POST',headers,body:JSON.stringify({token:app.secrets.scanner})});
  const cookie=r.headers.get('set-cookie').split(';')[0];
  const authed={...headers,Cookie:cookie};
  assert.equal((await get('/api/scanner-suggestions',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:'{}'})).status,403,'must carry the UI origin + X-EVI-UI header, same as every other scanner POST');
  const push=(items)=>get('/api/scanner-suggestions',{method:'POST',headers:{...authed,'X-EVI-UI':'1'},body:JSON.stringify({items})});
  const empty=await push(undefined);assert.equal(empty.status,200);assert.deepEqual(await empty.json(),{ok:true,accepted:0});
  const valid={itemId:4151,name:'Abyssal whip',buy:2000000,sell:2100000,net:79000,qty:1,score:88,mode:'Medium'};
  const invalidNoName={itemId:995,buy:1,sell:2,net:1,name:''};
  const invalidBadPrice={itemId:1,name:'Bad',buy:-5,sell:10,net:5};
  const mixed=await push([valid,invalidNoName,invalidBadPrice,{...valid,itemId:4152}]);
  assert.equal(mixed.status,200);
  assert.deepEqual(await mixed.json(),{ok:true,accepted:2},'only the two structurally valid items are accepted');
  const capped=await push(Array.from({length:80},(_,i)=>({...valid,itemId:i+1})));
  assert.equal((await capped.json()).accepted,50,'a push larger than the cap is truncated, not rejected outright');
});
