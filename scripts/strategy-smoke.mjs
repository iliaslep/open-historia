// Requires a running development server or built local app. Creates a new party.
// Usage: node scripts/strategy-smoke.mjs http://127.0.0.1:5173/?strategy=1
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const chatMode = process.argv.includes('--chats');
const chatFixture = chatMode ? await (await import('./strategy-chat-fixture.mjs')).startChatFixture() : null;
const pageUrl = new URL(chatFixture ? `${chatFixture.origin}/?strategy=1` : process.argv[2] || 'http://127.0.0.1:5173/?strategy=1');
pageUrl.searchParams.set('mapFillProbe', '1');
const origin = pageUrl.href;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-strategy-ui-'));
const downloads = path.join(profile, 'downloads'); fs.mkdirSync(downloads);
const browser = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
  '--headless', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
const pending = new Map(); let sequence = 0, buffer = '', stderr = '';
browser.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });
let aiCalls = 0;
let pageLoaded;
browser.stdio[4].on('data', (data) => {
  buffer += data;
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (message.method === 'Page.loadEventFired' && pageLoaded) { pageLoaded(); pageLoaded = null; }
    if (message.method === 'Network.requestWillBeSent' && /\/api\/ai\/|api\.openai|generativelanguage|api\.anthropic/.test(message.params.request.url)) aiCalls++;
    const item = pending.get(message.id);
    if (item) { pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result); }
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timeout: ${stderr}`)); }, 20000);
  pending.set(id, { resolve, reject, timer });
  browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
});
let session;
const evaluate = async (expression) => {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
};
const wait = async (expression) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if (await evaluate(`Promise.resolve(${expression}).then(Boolean)`)) return; } catch { /* navigation replaces the execution context */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`UI readiness failed: ${expression}\n${await evaluate('document.body.innerText')}`);
};
const click = async (text) => {
  await wait(`(()=>{const b=Array.from(document.querySelectorAll('.strategy button')).find(b=>b.textContent.startsWith(${JSON.stringify(text)}));if(!b||b.disabled)return false;b.click();return true;})()`);
};
const saved = () => evaluate(`(async()=>{const c=await(await fetch('/api/games')).json();const d=await(await fetch('/api/games/'+encodeURIComponent(c.activeGameId))).json();return {id:c.activeGameId,...d};})()`);
try {
  const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
  session = (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
  await cdp('Page.enable', {}, session);
  await cdp('Network.enable', {}, session);
  // Exercise the local game/map with all remote HTTPS providers unavailable.
  await cdp('Network.setBlockedURLs', { urls: ['https://*'] }, session);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, session);
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  await cdp('Page.navigate', { url: origin }, session);
  await wait(`document.querySelector('.strategy')`);
  const previousId = await evaluate(`fetch('/api/games').then(r=>r.json()).then(c=>c.activeGameId)`);
  await click('Новая партия');
  await click('Создать партию');
  await wait(`fetch('/api/games').then(r=>r.json()).then(c=>c.activeGameId!==${JSON.stringify(previousId)}&&document.querySelector('.strategy')?.dataset.gameId===c.activeGameId)`);
  if (chatMode) {
    const write = async text => {
      await wait(`document.querySelector('.strategy-conversation textarea')&&!document.querySelector('.strategy-conversation textarea').disabled`);
      await evaluate(`(()=>{const t=document.querySelector('.strategy-conversation textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,${JSON.stringify(text)});t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await click('Отправить ·');
    };
    await click('Чат решений');
    const initial = await saved();
    await write('Предлагаю повысить налоговую нагрузку до 40 %');
    await wait(`document.querySelector('.strategy-proposal')?.textContent.includes('ещё не исполнено')`);
    assert.equal((await saved()).data.world.strategy.countries.Germany.tax, 3800);
    assert.equal((await saved()).data.world.strategy.countries.Germany.capital, initial.data.world.strategy.countries.Germany.capital);
    await click('Принять и выполнить');
    await wait(`document.querySelector('.strategy-proposal')?.textContent.includes('Исполнено движком')`);
    await click('▶ 7 дней');
    await wait(`document.querySelector('.strategy time')?.textContent.includes('15 декабря')`);
    assert.equal((await saved()).data.world.strategy.countries.Germany.tax, 4000);
    await click('Дипломатия');
    await write('Предлагаем помощь Франции 500 млн евро');
    await wait(`document.querySelector('.strategy-proposal')?.textContent.includes('500')`);
    const offered = await saved();
    await click('Принять условия');
    await wait(`document.querySelector('.strategy-proposal')?.textContent.includes('Исполнено движком')`);
    const applied = await saved();
    assert.equal(applied.data.world.strategy.countries.Germany.treasury, offered.data.world.strategy.countries.Germany.treasury - 500);
    assert.equal(applied.data.world.strategy.countries.France.treasury, offered.data.world.strategy.countries.France.treasury + 500);
    await evaluate(`(()=>{const s=Array.from(document.querySelectorAll('.strategy section label select')).find(s=>Array.from(s.options).some(o=>o.value==='Russia'));s.value='Russia';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await wait(`document.querySelector('.strategy-conversation h2')?.textContent.includes('Россия')`);
    await write('Начнём отдельные переговоры');
    await wait(`document.querySelector('.strategy-transcript')?.textContent.includes('российской делегацией')`);
    await click('Чат решений');
    await write('Верни сломанный формат');
    await wait(`document.querySelector('.strategy-conversation [role=alert]')?.textContent.includes('неподдерживаемое')`);
    const bad = await saved();
    assert.deepEqual(bad.data.world.strategy, applied.data.world.strategy);
    await write('Обсудим дальнейшие решения');
    await wait(`document.querySelector('.strategy-transcript')?.textContent.includes('Уточним дальнейшие')`);
    const progressed = await saved();
    await click('Экспорт партии');
    const exported = path.join(downloads, 'strategy-2016-12-15.json');
    for (let i = 0; i < 100 && !fs.existsSync(exported); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(exported));
    assert.deepEqual(JSON.parse(fs.readFileSync(exported, 'utf8')).data.chat, progressed.data.chat);
    const document = await cdp('DOM.getDocument', {}, session);
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '.strategy input[type=file]' }, session);
    await cdp('DOM.setFileInputFiles', { nodeId, files: [exported] }, session);
    await wait(`document.querySelector('.strategy')?.dataset.gameId && document.querySelector('.strategy').dataset.gameId!==${JSON.stringify(progressed.id)}`);
    const reloaded = new Promise(resolve => { pageLoaded = resolve; }); await cdp('Page.reload', {}, session); await reloaded;
    await wait(`document.querySelector('.strategy time')?.textContent.includes('15 декабря')`);
    assert.deepEqual((await saved()).data.chat, progressed.data.chat);
    await click('Дипломатия');
    await wait(`document.querySelector('.strategy-transcript')?.textContent.includes('Французская делегация')`);
    await wait(`window.__OH_MAP_READINESS__?.polities && !window.__OH_MAP_READINESS__.polities.failed && window.__OH_MAP_READINESS__.idleAt>=window.__OH_MAP_READINESS__.polities.at`);
    const screenshot = await cdp('Page.captureScreenshot', { format: 'png' }, session);
    fs.writeFileSync('/tmp/strategy-chat-smoke.png', Buffer.from(screenshot.data, 'base64'));
    assert.equal(aiCalls, 0, 'the provider is a synthetic fixture, never an external service');
    console.log('PASS (synthetic OAuth/Responses provider): decisions chat, real seven-day tax reform, diplomatic aid both balances, isolated country threads, invalid response, UI export/import/reload, persisted receipts. Live account not tested.');
  } else {
  await click('Экономика');
  await click('Инфраструктура');
  await wait(`Array.from(document.querySelectorAll('.strategy button')).some(b=>b.textContent.startsWith('▶ 7 дней')&&!b.disabled)`);
  const initial = await saved();
  assert.equal(initial.data.world.strategy.projects[0].kind, 'industry');
  await click('▶ 7 дней');
  await wait(`document.querySelector('.strategy time')?.textContent.includes('15 декабря')`);
  await click('Дипломатия');
  await click('Предложить торговое');
  await wait(`Array.from(document.querySelectorAll('.strategy button')).some(b=>b.textContent.startsWith('▶ Месяц')&&!b.disabled)`);
  assert.equal((await saved()).data.world.strategy.treaties.length, 1);
  await click('▶ Месяц');
  await wait(`document.querySelector('.strategy time')?.textContent.includes('15 января')`);
  await wait(`window.__OH_MAP_READINESS__?.polities && !window.__OH_MAP_READINESS__.polities.failed && window.__OH_MAP_READINESS__.idleAt >= window.__OH_MAP_READINESS__.polities.at`);
  const progressed = await saved();
  assert.equal(progressed.data.world.strategy.countries.Germany.industry, 55);
  assert.ok(progressed.data.world.strategy.history.some((e) => e.country !== 'Germany'));
  await click('Экспорт партии');
  for (let i = 0; i < 100 && !fs.existsSync(path.join(downloads, 'strategy-2017-01-15.json')); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  const exported = path.join(downloads, 'strategy-2017-01-15.json');
  assert.ok(fs.existsSync(exported), 'UI export must produce a file');
  const bundle = JSON.parse(fs.readFileSync(exported, 'utf8'));
  assert.deepEqual(bundle.data.world.strategy, progressed.data.world.strategy);
  const document = await cdp('DOM.getDocument', {}, session);
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: document.root.nodeId, selector: '.strategy input[type=file]' }, session);
  await cdp('DOM.setFileInputFiles', { nodeId, files: [exported] }, session);
  await wait(`document.querySelector('.strategy h1')?.textContent==='Германия'&&!document.querySelector('.strategy button:disabled')`);
  let restored;
  for (let i = 0; i < 50; i++) { restored = await saved(); if (restored.id !== progressed.id) break; await new Promise((resolve) => setTimeout(resolve, 100)); }
  assert.notEqual(restored.id, progressed.id);
  assert.deepEqual(restored.data.world.strategy, progressed.data.world.strategy);
  const reloaded = new Promise((resolve) => { pageLoaded = resolve; });
  await cdp('Page.reload', {}, session);
  await reloaded;
  await wait(`document.querySelector('.strategy time')?.textContent.includes('15 января')`);
  await wait(`window.__OH_MAP_READINESS__?.polities && !window.__OH_MAP_READINESS__.polities.failed && window.__OH_MAP_READINESS__.idleAt >= window.__OH_MAP_READINESS__.polities.at`);
  assert.equal(aiCalls, 0, 'native gameplay must never request an AI provider');
  await click('ChatGPT');
  await wait(`document.querySelector('.strategy-chatgpt')?.textContent.includes('ChatGPT не подключён')`);
  // Reproduce the reported UI bug: after showing "finish in your browser", a
  // subsequent transport error must replace that message, rather than be hidden.
  // Only HTTP auth responses are stubbed; the rendered React panel is real.
  await evaluate(`(() => {
    window.__authProbe = { started: false, failed: false, fetch: window.fetch };
    window.__authProbe.blockLink = e => { if (e.target.closest('a')?.href.startsWith('https://auth.openai.com/')) e.preventDefault(); };
    document.addEventListener('click', window.__authProbe.blockLink, true);
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/api/strategy/chatgpt/start')) { window.__authProbe.started = true; return Promise.resolve(Response.json({url:'https://auth.openai.com/unit-test'})); }
      if (url.endsWith('/api/strategy/chatgpt/status')) return Promise.resolve(Response.json({connected:false,canInfer:false,active:null,accounts:[],error:window.__authProbe.failed?'Не удалось подключиться через системный прокси. [network:proxy]':''}));
      return window.__authProbe.fetch(input, init);
    };
  })()`);
  await click('Continue with ChatGPT');
  await wait(`document.querySelector('.strategy-chatgpt [role=status]')?.textContent.includes('Завершите вход')`);
  await evaluate('window.__authProbe.failed = true');
  await wait(`document.querySelector('.strategy-chatgpt [role=alert]')?.textContent.includes('network:proxy')`);
  assert.equal(await evaluate(`document.querySelector('.strategy-chatgpt [role=status]')?.textContent.includes('Завершите вход')||false`), false);
  await evaluate(`(() => {window.fetch = window.__authProbe.fetch; document.removeEventListener('click', window.__authProbe.blockLink, true); delete window.__authProbe;})()`);
  await wait(`!document.querySelector('.strategy-chatgpt [role=alert]')`);
  // Reach war through actual resource-limited UI commands, then check the
  // feature-state that the live MapLibre political fill expression renders.
  const action = async (text) => {
    const revision = (await saved()).data.world.simulation.revision;
    await click(text);
    await wait(`fetch('/api/games/'+encodeURIComponent(document.querySelector('.strategy').dataset.gameId)).then(r=>r.json()).then(d=>d.data.world.simulation.revision>${revision})`);
    await wait(`!document.querySelector('.strategy button:disabled')`);
  };
  await click('Безопасность');
  await action('Подготовить резервы');
  await action('Сбор разведывательных');
  await action('▶ 7 дней');
  await action('▶ 7 дней');
  await click('Дипломатия');
  await action('Ввести санкции');
  await action('Ввести санкции');
  await click('Безопасность');
  await action('Начать военную операцию');
  const beforeBattle = await saved();
  assert.equal(beforeBattle.data.world.strategy.wars.length, 1);
  await wait(`window.__OH_MAP__?.getSource('custom-regions-source')`);
  await action('▶ 7 дней');
  const battled = await saved();
  const changed = Object.keys(battled.data.world.strategy.regions).filter((id) => battled.data.world.strategy.regions[id].owner !== beforeBattle.data.world.strategy.regions[id].owner);
  assert.equal(changed.length, 1);
  const captured = changed[0], winner = battled.data.world.strategy.regions[captured].owner;
  const reference = Object.keys(battled.data.world.strategy.regions).find((id) => id !== captured && battled.data.world.strategy.regions[id].owner === winner);
  const fillState = (id) => `window.__OH_MAP__.getFeatureState({source:'custom-regions-source',id:${JSON.stringify(id)}}).fillColor`;
  await wait(`${fillState(captured)} && ${fillState(captured)}===${fillState(reference)}`);
  assert.equal(battled.data.world.strategy.reports.length, 1);
  assert.equal(battled.data.world.regionSovereigntyOverrides[captured], beforeBattle.data.world.strategy.regions[captured].sovereign);
  await click('Дипломатия');
  await action('Предложить перемирие');
  assert.equal((await saved()).data.world.strategy.wars.length, 0);
  await click('Кабинет');
  assert.equal(await evaluate(`document.querySelector('.strategy [role=alert]')?.textContent||''`), '');
  assert.equal(await evaluate(`document.body.innerText.includes('Count your visit?')`), false, 'strategy must not show the upstream analytics prompt');
  await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' }, session);
  fs.writeFileSync('/tmp/strategy-smoke.png', Buffer.from(screenshot.data, 'base64'));
  console.log('PASS (remote HTTPS blocked): create, investment, week, treaty, calendar month, NPCs, UI export/import, reload, ChatGPT fallback/error visibility, intelligence, mobilization, sanctions, war, rendered territory color, sovereignty, peace; AI calls:', aiCalls);
  console.log('Screenshot: /tmp/strategy-smoke.png');
  }
} finally {
  if (browser.exitCode === null && browser.signalCode === null) {
    const exited = once(browser, 'exit'); browser.kill('SIGTERM'); await exited;
  }
  fs.rmSync(profile, { recursive: true, force: true });
  await chatFixture?.close();
}
