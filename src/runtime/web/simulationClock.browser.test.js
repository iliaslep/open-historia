// Real IndexedDB regression tests. Run with Chromium installed, or set CHROMIUM_BIN.
// Uses CDP over anonymous pipes; no browser driver package or exposed debug port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const chromium = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
const root = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
// Only generated scenario content is replaced. Storage, IDB transactions and
// the clock handler below are the actual application modules.
const generated = {
  'countryNames.js': 'export default {};',
  'fallbackColors.js': 'export default {};',
  'defaultScenario.js': 'export default {meta:{},data:{}};',
  'defaultScenarioMeta.js': 'export const builtInMap="test",builtInRevision=1,earlierMaps={},regionsUrl="";',
};

test('web clock commits across two Chromium tabs and rolls back failed IndexedDB writes', {
  skip: fs.existsSync(chromium) ? false : 'Chromium unavailable; set CHROMIUM_BIN to run real IndexedDB checks',
  timeout: 60000,
}, async (t) => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-clock-browser-'));
  let server;
  let browser;
  t.after(async () => {
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      const timer = setTimeout(() => browser.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    // Chromium helper processes may finish flushing just after the parent exits.
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><script type="importmap">{"imports":{"@noble/hashes/sha2.js":"/node_modules/@noble/hashes/sha2.js"}}</script>');
      return;
    }
    const name = pathname.split('/').at(-1);
    res.setHeader('Content-Type', 'text/javascript');
    if (pathname.includes('/web/generated/') && generated[name]) { res.end(generated[name]); return; }
    const file = path.resolve(root, '.' + pathname);
    if (!file.startsWith(root + path.sep) || !file.endsWith('.js') || !fs.existsSync(file)) {
      res.writeHead(404).end(); return;
    }
    res.end(fs.readFileSync(file));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(chromium, [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--no-first-run', '--disable-background-networking', '--remote-debugging-pipe',
    `--user-data-dir=${profile}`, `--disk-cache-dir=${path.join(profile, 'cache')}`,
  ], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
  let stderr = '';
  browser.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  const pending = new Map();
  const events = new EventEmitter();
  let sequence = 0;
  let buffered = '';
  browser.stdio[4].on('data', (chunk) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (message.id) {
        const request = pending.get(message.id);
        if (request) {
          pending.delete(message.id);
          clearTimeout(request.timer);
          if (message.error) request.reject(new Error(JSON.stringify(message.error)));
          else request.resolve(message.result);
        }
      } else if (message.method) events.emit(`${message.sessionId}:${message.method}`, message.params);
    }
  });
  const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}\n${stderr}`)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  const evaluate = async (session, expression) => {
    const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (reply.exceptionDetails) throw new Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  };
  const navigate = async (session) => {
    const loaded = once(events, `${session}:Page.loadEventFired`);
    await cdp('Page.navigate', { url: origin }, session);
    await loaded;
    await evaluate(session, `(async()=>{
      window.idb=await import('/src/runtime/web/idb.js');
      window.library=await import('/src/runtime/web/libraryStore.js');
      window.advance=async(body,id='clock')=>{
        const response=await library.handleGames({method:'POST',segments:[id,'simulation','advance'],body});
        return {status:response.status,data:await response.json()};
      };
    })()`);
  };
  const tab = async () => {
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Page.enable', {}, sessionId);
    await navigate(sessionId);
    return sessionId;
  };
  const first = await tab();
  const second = await tab();
  await evaluate(first, `(async()=>{
    const {createSimulationState}=await import('/server/simulation/state.js');
    const record={id:'clock',meta:{id:'clock',scenarioId:'scenario',updatedAt:'2026-01-01T00:00:00.000Z'},
      json:{game:{gameDate:'2016-01-31',round:1},world:{ownerSchema:4,simulation:createSimulationState({scenarioId:'scenario',date:'2016-01-31',seed:7})},events:[{id:'keep'}]},
      snapshots:[{id:'restore-point'}],cover:{contentType:'image/png',bytes:new Uint8Array([1,2,3])}};
    await idb.idbPutPair(idb.STORES.games,record,idb.STORES.gameMeta,{id:'clock',currentDate:'2016-01-31'});
  })()`);

  await t.test('separate tabs share one revision check and commit the record and catalog together', async () => {
    const replies = await Promise.all([
      evaluate(first, `advance({step:'month',expectedRevision:0})`),
      evaluate(second, `advance({step:'month',expectedRevision:0})`),
    ]);
    assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 409]);
    const success = replies.find((reply) => reply.status === 200).data;
    assert.equal(success.days, 29);
    assert.equal(success.game.gameDate, '2016-02-29');
    assert.equal(success.world.simulation.revision, 29);
    assert.equal(success.world.simulation.rng.draws, 0);
    const saved = await evaluate(second, `(async()=>({record:await idb.idbGet(idb.STORES.games,'clock'),index:await idb.idbGet(idb.STORES.gameMeta,'clock')}))()`);
    assert.equal(saved.record.json.world.simulation.date, saved.index.currentDate);
    assert.equal(saved.index.meta.updatedAt, saved.record.meta.updatedAt);
    assert.deepEqual(saved.record.snapshots, [{ id: 'restore-point' }]);
    assert.deepEqual(saved.record.json.events, [{ id: 'keep' }]);
    assert.deepEqual(Object.values(saved.record.cover.bytes), [1, 2, 3]);
  });

  await t.test('a failed index write rolls back the first put before reporting failure, and the queue recovers', async () => {
    const result = await evaluate(first, `(async()=>{
      const before=await idb.idbGet(idb.STORES.games,'clock');
      const indexBefore=await idb.idbGet(idb.STORES.gameMeta,'clock');
      const put=IDBObjectStore.prototype.put, transaction=IDBDatabase.prototype.transaction;
      let aborted=false, reply;
      IDBDatabase.prototype.transaction=function(...args){const tx=transaction.apply(this,args);tx.addEventListener('abort',()=>{aborted=true});return tx;};
      IDBObjectStore.prototype.put=function(...args){if(this.name===idb.STORES.gameMeta)throw new DOMException('Injected quota failure','QuotaExceededError');return put.apply(this,args);};
      try{reply=await advance({step:'day',expectedRevision:29});}
      finally{IDBObjectStore.prototype.put=put;IDBDatabase.prototype.transaction=transaction;}
      const rolledBackBeforeReply=aborted;
      const after=await idb.idbGet(idb.STORES.games,'clock');
      const indexAfter=await idb.idbGet(idb.STORES.gameMeta,'clock');
      const retry=await advance({step:'day',expectedRevision:29});
      return {before,after,indexBefore,indexAfter,reply,rolledBackBeforeReply,retry};
    })()`);
    assert.equal(result.reply.status, 500);
    assert.equal(result.rolledBackBeforeReply, true);
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.indexAfter, result.indexBefore);
    assert.equal(result.retry.status, 200);
    assert.equal(result.retry.data.world.simulation.revision, 30);
  });

  await t.test('fresh page context reads the committed pair, and stale requests retain status 409', async () => {
    await navigate(first);
    const saved = await evaluate(first, `(async()=>({record:await idb.idbGet(idb.STORES.games,'clock'),reply:await advance({step:'day',expectedRevision:29})}))()`);
    assert.equal(saved.record.json.game.gameDate, '2016-03-01');
    assert.equal(saved.record.json.world.simulation.date, '2016-03-01');
    assert.equal(saved.record.json.world.simulation.revision, 30);
    assert.equal(saved.reply.status, 409);
  });

  await t.test('successful put requests followed by transaction abort never report a committed turn', async () => {
    const result = await evaluate(first, `(async()=>{
      const before=await idb.idbGet(idb.STORES.games,'clock');
      const indexBefore=await idb.idbGet(idb.STORES.gameMeta,'clock');
      const put=IDBObjectStore.prototype.put;
      let indexRequestSucceeded=false,reply;
      IDBObjectStore.prototype.put=function(...args){
        const request=put.apply(this,args);
        if(this.name===idb.STORES.gameMeta)request.addEventListener('success',()=>{indexRequestSucceeded=true;this.transaction.abort();});
        return request;
      };
      try{reply=await advance({step:'day',expectedRevision:30});}
      finally{IDBObjectStore.prototype.put=put;}
      return {before,indexBefore,reply,indexRequestSucceeded,
        after:await idb.idbGet(idb.STORES.games,'clock'),indexAfter:await idb.idbGet(idb.STORES.gameMeta,'clock')};
    })()`);
    assert.equal(result.indexRequestSucceeded, true);
    assert.equal(result.reply.status, 500);
    assert.deepEqual(result.after, result.before);
    assert.deepEqual(result.indexAfter, result.indexBefore);
  });

  await t.test('a native game starts, applies policy, advances and blocks legacy writers in real IndexedDB', async () => {
    const result = await evaluate(first, `(async()=>{
      const record={id:'native',meta:{id:'native',scenarioId:'scenario',updatedAt:'2026-01-01T00:00:00.000Z'},json:{game:{country:'Germany',gameDate:'2016-12-08'},world:{ownerSchema:4,polityOverrides:{Germany:{},France:{},Russia:{}}}}};
      await idb.idbPutPair(idb.STORES.games,record,idb.STORES.gameMeta,{id:'native',meta:record.meta});
      await idb.kvPut('game-manifest',{activeGameId:'native',order:['native','clock']});
      const call=async(op,body)=>{const r=await library.handleGames({method:'POST',segments:['native','simulation',op],body});return {status:r.status,data:await r.json()};};
      const started=await call('start',{seed:7});
      const policy=await call('decision',{type:'tax',value:45,expectedRevision:0});
      const advanced=await call('advance',{step:'week',expectedRevision:1});
      const raw=await library.handleRuntimeJson({method:'PUT',segments:['json','world'],body:started.data.world});
      const patch=await library.handleGames({method:'PUT',segments:['native'],body:{gamePatch:{gameDate:'2020-01-01'}}});
      const saved=await idb.idbGet(idb.STORES.games,'native');
      return {started:started.status,policy:policy.status,advanced:advanced.status,raw:raw.status,patch:patch.status,saved};
    })()`);
    assert.equal(result.started, 200);
    assert.equal(result.policy, 200);
    assert.equal(result.advanced, 200);
    assert.equal(result.raw, 409);
    assert.equal(result.patch, 409);
    assert.equal(result.saved.json.world.strategy.countries.Germany.tax, 4500);
    assert.equal(result.saved.json.game.gameDate, '2016-12-15');
  });
});
