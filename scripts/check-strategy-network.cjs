// Runs under a real Electron main process, including on the Windows CI runner.
// Every HTTP request is synthetic and loopback-only; no real account is used.
const { app, session } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { generateKeyPairSync, sign } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { createStrategyNetwork } = require('../electron/strategyNetwork.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-electron-network-'));
fs.mkdirSync(path.join(directory, 'electron-profile'), { recursive: true });
app.setPath('userData', path.join(directory, 'electron-profile'));
const resultFile = path.join(process.cwd(), 'release', 'native-network-check.json');
fs.mkdirSync(path.dirname(resultFile), { recursive: true });
fs.writeFileSync(resultFile, JSON.stringify({ passed: false }));

app.whenReady().then(async () => {
  const { createChatGPTPlan, ChatGPTNetworkError } = await import(pathToFileURL(path.join(__dirname, '../server/chatgptPlan.js')).href);
  const { ChatGPTProtocolError } = await import(pathToFileURL(path.join(__dirname, '../server/chatgptErrors.js')).href);
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'native-network-fixture', alg: 'RS256' };
  let mode = 'normal', authorization, proxyHits = 0;
  const delta = 'Проверенный ответ через Electron.';
  const api = http.createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the synthetic request body */ }
    const json = data => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.url === '/health') return json({ ok: true });
    if (req.url === '/.well-known/openid-configuration') return json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/native-keys' });
    if (req.url === '/native-keys') return json({ keys: [jwk] });
    if (req.url === '/api/accounts/oauth/token') {
      const h = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
      const p = Buffer.from(JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_native_network', sub: 'synthetic',
        nonce: authorization.searchParams.get('nonce'), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      const value = `${h}.${p}`;
      return json({ access_token: 'not-a-real-token', refresh_token: 'not-a-real-refresh', token_type: 'Bearer', expires_in: 3600,
        id_token: `${value}.${sign('RSA-SHA256', Buffer.from(value), privateKey).toString('base64url')}`, scope: 'openid resource.invoke chatgpt.tokens.use.direct' });
    }
    if (req.url === '/v1/models') return json({ models: [{ slug: 'native-test', visibility: 'list' }] });
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`);
      if (mode !== 'partial') res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3 } } })}\n\n`);
      if (mode === 'normal') res.end();
      if (mode === 'partial' || mode === 'broken-close') setTimeout(() => res.destroy(), 50);
      return;
    }
    res.writeHead(404).end();
  });
  const proxy = http.createServer((req, res) => {
    proxyHits++;
    const url = new URL(req.url);
    assert.equal(url.hostname, '127.0.0.1', 'test proxy may only contact loopback');
    const outgoing = http.request(url, { method: req.method, headers: req.headers }, incoming => {
      res.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(res);
      incoming.on('error', () => res.destroy());
    });
    outgoing.on('error', () => res.destroy()); res.on('close', () => outgoing.destroy()); req.pipe(outgoing);
  });
  try {
    api.listen(0, '127.0.0.1'); proxy.listen(0, '127.0.0.1');
    await Promise.all([once(api, 'listening'), once(proxy, 'listening')]);
    const origin = `http://127.0.0.1:${api.address().port}`;
    const network = await createStrategyNetwork(session);
    // A synthetic proxy deliberately includes loopback. Local UI must bypass it;
    // the isolated model session must use it, exercising real Chromium streams.
    await network.remote.setProxy({ mode: 'fixed_servers', proxyRules: `http://127.0.0.1:${proxy.address().port}`, proxyBypassRules: '<-loopback>' });
    const before = proxyHits;
    assert.equal((await network.local.fetch(origin + '/health')).status, 200);
    assert.equal(proxyHits, before);
    const manager = createChatGPTPlan({ directory: path.join(directory, 'credentials'), callbackUrl: () => origin + '/auth/callback',
      fetchImpl: (url, options) => network.fetch(origin + new URL(url).pathname, options) });
    authorization = new URL(manager.begin().url);
    await manager.complete(new URLSearchParams({ state: authorization.searchParams.get('state'), code: 'synthetic', client_id: 'oaiapp_native_network' }));
    assert.ok(proxyHits > before, 'OpenAI transport must use the separate proxy session');
    const ask = () => manager.ask({ model: 'native-test', prompt: 'Проверка', context: 'Синтетический тест.' });
    for (mode of ['normal', 'hold', 'broken-close']) {
      const deadline = new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Native stream did not finish at response.completed')), 2500); timer.unref(); });
      const answer = await Promise.race([ask(), deadline]);
      assert.equal(answer.text, delta);
    }
    mode = 'partial';
    await assert.rejects(ask, error => (error instanceof ChatGPTNetworkError && error.stage === 'response-body')
      || (error instanceof ChatGPTProtocolError && error.code === 'incomplete'));
    assert.equal((await network.local.fetch(origin + '/health')).status, 200, 'game loopback remains reachable after model failure');
    fs.writeFileSync(resultFile, JSON.stringify({ passed: true, platform: process.platform, electron: process.versions.electron,
      cases: ['direct-loopback', 'isolated-proxy', 'normal-stream', 'completed-kept-open', 'completed-broken-close', 'partial-rejected', 'loopback-after-failure'] }, null, 2));
    console.log('PASS: real Electron transport, isolated proxy, terminal SSE and loopback after failure');
  } finally {
    api.closeAllConnections?.(); proxy.closeAllConnections?.();
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
