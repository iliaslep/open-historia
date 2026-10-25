import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createChatGPTPlan } from './chatgptPlan.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'unit-key', use: 'sig', alg: 'RS256' };
const jwt = (body, alg = 'RS256') => {
  const header = Buffer.from(JSON.stringify({ alg, kid: 'unit-key' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  const text = `${header}.${payload}`;
  return `${text}.${sign('RSA-SHA256', Buffer.from(text), privateKey).toString('base64url')}`;
};
const fixture = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-siwc-unit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = Date.now(), authorization, refreshCount = 0, terminal = 'response.completed';
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/keys', revocation_endpoint: 'https://auth.openai.com/revoke' });
    if (url.endsWith('/keys')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) {
      const form = options.body;
      assert.equal(form.get('resource'), 'https://api.openai.com/v1');
      const id = form.get('client_id');
      if (form.get('grant_type') === 'refresh_token') {
        refreshCount++;
        return Response.json({ access_token: `unit-new-access-${refreshCount}`, refresh_token: `unit-new-refresh-${refreshCount}`, token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email resource.invoke chatgpt.tokens.use.direct' });
      }
      assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:4000/auth/callback');
      assert.equal(createHash('sha256').update(form.get('code_verifier')).digest('base64url'), authorization.searchParams.get('code_challenge'));
      const claims = { iss: 'https://auth.openai.com', aud: id, sub: `subject-${id}`, email: 'unit@example.test',
        exp: Math.floor(time / 1000) + 3600, nonce: authorization.searchParams.get('nonce') };
      if (form.get('code') === 'bad-nonce') claims.nonce = 'wrong';
      return Response.json({ access_token: 'unit-access', refresh_token: 'unit-refresh', token_type: 'Bearer', expires_in: 3600,
        scope: 'openid profile email resource.invoke chatgpt.tokens.use.direct', id_token: jwt(claims, form.get('code') === 'bad-alg' ? 'none' : 'RS256') });
    }
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'allowed-model', display_name: 'Unit model', visibility: 'list' }, { slug: 'hidden-model', visibility: 'hidden' }] });
    if (url.endsWith('/responses')) {
      const body = JSON.parse(options.body);
      assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(Array.isArray(body.input));
      for (const forbidden of ['temperature', 'max_output_tokens', 'previous_response_id', 'metadata', 'conversation']) assert.equal(Object.hasOwn(body, forbidden), false);
      assert.ok(body.instructions.includes('русском'));
      const data = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Совет: проверьте бюджет.' })}\n\ndata: ${JSON.stringify({ type: terminal, response: { usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`;
      const encoded = new TextEncoder().encode(data);
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoded.slice(0, 13)); controller.enqueue(encoded.slice(13)); controller.close(); } }));
    }
    if (url.endsWith('/revoke')) return new Response(null, { status: 200 });
    throw new Error('Unexpected destination');
  };
  const options = { directory, callbackUrl: () => 'http://127.0.0.1:4000/auth/callback', fetchImpl, now: () => time };
  const manager = createChatGPTPlan(options);
  const begin = (id) => { authorization = new URL(manager.begin(id).url); return authorization; };
  const finish = (id = 'oaiapp_unit_1', code = 'valid') => manager.complete(new URLSearchParams({ state: authorization.searchParams.get('state'), code, client_id: id }));
  return { directory, manager, options, begin, finish, requests, advance: () => { time += 3600000; }, refreshes: () => refreshCount, failStream: () => { terminal = 'response.failed'; } };
};

test('official PKCE registration validates signature/nonce and keeps credentials out of public status', async (t) => {
  const f = fixture(t);
  const url = f.begin();
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('agent_name_hint'), 'Open Historia Strategy');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const host = url.searchParams.get('ext_agent_host_id');
  const status = await f.finish();
  assert.equal(status.connected, true); assert.equal(status.canInfer, true);
  assert.equal(JSON.stringify(status).includes('unit-access'), false);
  const file = path.join(f.directory, 'chatgpt-plan.json');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const restarted = createChatGPTPlan(f.options);
  const next = new URL(restarted.begin('oaiapp_unit_1').url);
  assert.equal(next.searchParams.get('client_id'), 'oaiapp_unit_1');
  assert.equal(next.searchParams.get('ext_agent_host_id'), host);
  assert.notEqual(next.searchParams.get('state'), url.searchParams.get('state'));
  assert.equal(next.searchParams.has('id_token_hint'), false);
});

test('wrong state, replay, nonce and unsigned-token algorithms cannot replace the active account', async (t) => {
  const f = fixture(t); f.begin(); await f.finish();
  const before = fs.readFileSync(path.join(f.directory, 'chatgpt-plan.json'), 'utf8');
  await assert.rejects(() => f.finish());
  await assert.rejects(() => f.manager.complete(new URLSearchParams({ state: 'forged', code: 'x', client_id: 'oaiapp_bad' })));
  for (const code of ['bad-nonce', 'bad-alg']) { f.begin(); await assert.rejects(() => f.finish('oaiapp_other', code)); }
  // begin persists only the same registration store and host ID; failed identity checks add no token set.
  assert.equal(fs.readFileSync(path.join(f.directory, 'chatgpt-plan.json'), 'utf8'), before);
  assert.equal(f.manager.status().active, 'oaiapp_unit_1');
});

test('refresh is serialized, rotating credentials survive restart, and logout revokes without mixing accounts', async (t) => {
  const f = fixture(t); f.begin(); await f.finish(); f.advance();
  const models = await Promise.all([f.manager.models(), f.manager.models()]);
  assert.equal(f.refreshes(), 1); assert.deepEqual(models[0], [{ id: 'allowed-model', name: 'Unit model' }]);
  f.begin(); await f.finish('oaiapp_unit_2');
  assert.equal(f.manager.status().accounts.length, 2);
  f.manager.select('oaiapp_unit_1');
  assert.equal((await f.manager.logout()).revoked, true);
  assert.equal(f.manager.status().connected, false);
  assert.equal(f.manager.status().accounts.length, 2);
  f.manager.select('oaiapp_unit_2');
  assert.equal(f.manager.status().connected, true);
});

test('inference follows the restricted Responses contract and only accepts completed streams', async (t) => {
  const f = fixture(t); f.begin(); await f.finish();
  const response = await f.manager.ask({ model: 'allowed-model', prompt: 'Оцените бюджет', context: 'Германия, игровая оценка.' });
  assert.match(response.text, /бюджет/); assert.equal(response.usage.output_tokens, 5);
  f.failStream();
  await assert.rejects(() => f.manager.ask({ model: 'allowed-model', prompt: 'Совет', context: 'Сводка' }));
  await assert.rejects(() => f.manager.ask({ model: 'invented-model', prompt: 'Совет', context: 'Сводка' }));
});

test('desktop protection seals the full store and requires the same OS protector on restart', async (t) => {
  const f = fixture(t);
  f.begin(); await f.finish();
  // Use authenticated encryption to exercise the codec contract without claiming
  // Linux unit tests verify Windows DPAPI itself.
  const key = randomBytes(32);
  const protection = {
    seal(text) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const bytes = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    open(bytes) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
    },
  };
  const protectedManager = createChatGPTPlan({ ...f.options, protection });
  protectedManager.select('oaiapp_unit_1');
  const stored = fs.readFileSync(path.join(f.directory, 'chatgpt-plan.json'), 'utf8');
  for (const value of ['unit-access', 'unit-refresh', 'unit@example.test']) assert.equal(stored.includes(value), false);
  assert.equal(createChatGPTPlan({ ...f.options, protection }).status().connected, true);
  assert.throws(() => createChatGPTPlan(f.options));
});
