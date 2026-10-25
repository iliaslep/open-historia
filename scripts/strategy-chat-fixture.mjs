// Synthetic provider for the browser regression runner ONLY. It starts a fresh
// temporary game server and never reads credentials or profiles from a user.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { once } from 'node:events';
import { configureChatGPTTransport } from '../server/chatgptPlan.js';

export async function startChatFixture({authenticated=true}={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-chat-ui-fixture-'));
  process.env.OH_DATA_DIR = root; process.env.OH_HOST = '127.0.0.1'; process.env.PORT = '0'; process.env.OH_VISIT_COUNT = '0';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'chat-ui-key', alg: 'RS256', use: 'sig' };
  let authorization;
  configureChatGPTTransport(async (url, options = {}) => {
    assert.equal(options.credentials, 'omit');
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/ui-test-keys' });
    if (url.endsWith('/ui-test-keys')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) {
      const claims = { iss: 'https://auth.openai.com', aud: options.body.get('client_id'), sub: 'synthetic-chat-ui-account',
        exp: Math.floor(Date.now() / 1000) + 3600, nonce: authorization.searchParams.get('nonce') };
      const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const text = `${header}.${payload}`;
      const token = `${text}.${sign('RSA-SHA256', Buffer.from(text), privateKey).toString('base64url')}`;
      return Response.json({ access_token: 'synthetic-not-a-real-token', refresh_token: 'synthetic-refresh', id_token: token,
        token_type: 'Bearer', expires_in: 3600, scope: 'openid profile resource.invoke chatgpt.tokens.use.direct' });
    }
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'chat-fixture', display_name: 'Synthetic browser fixture', visibility: 'list' }] });
    if (url.endsWith('/responses')) {
      const body = JSON.parse(options.body);
      assert.equal(body.store, false); assert.equal(body.stream, true);
      assert.ok(body.instructions.includes('actions'));
      const content = body.input[0].content, at = content.lastIndexOf('\n\nВопрос: ');
      const context = JSON.parse(content.slice(0, at)), prompt = content.slice(at + 10);
      let reply = { reply: 'Уточним дальнейшие решения.', stance: 'discuss', actions: [] };
      if (prompt.includes('сломанный')) reply = { reply: 'Нельзя исполнять.', stance: 'accept', actions: [{ type: 'gdp', value: 999999 }] };
      else if (context.channel === 'decisions' && prompt.includes('альтернатив')) reply = {reply:'Сравним два направления.',stance:'discuss',actions:[],suggestions:[{title:'Интеграция',reason:'Увеличить фонд, уменьшив свободную казну.',actions:[{type:'migration_fund',value:2}]},{title:'Инфраструктура',reason:'Ускорить рост, выделив средства на 30 дней.',actions:[{type:'industry'}]}]};
      else if (context.channel === 'decisions' && prompt.includes('налог')) reply = { reply: 'Предлагаем налоговую нагрузку 40 % с рассмотрением семь дней.', stance: 'accept', actions: [{ type: 'tax', value: 40 }] };
      else if (context.channel === 'diplomacy') {
        assert.equal(context.ownCountry, undefined); assert.equal(context.reports, undefined);
        if (context.target === 'France') reply = { reply: 'Французская делегация готова принять помощь 500 млн евро.', stance: 'counter', actions: [{ type: 'aid', target: 'France', value: 500 }] };
        else {
          assert.equal(context.history.length, 0, 'another country must not see the French conversation');
          reply = { reply: 'Это отдельная беседа с российской делегацией.', stance: 'discuss', actions: [] };
        }
      }
      return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: JSON.stringify(reply) })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 30 } } })}\n\n`);
    }
    throw new Error('Unexpected destination in synthetic provider');
  });
  const { httpServer } = await import('../server/server.js');
  if (!httpServer.listening) await once(httpServer, 'listening');
  const origin = `http://127.0.0.1:${httpServer.address().port}`;
  if(authenticated) {
  const started = await fetch(origin + '/api/strategy/chatgpt/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(started.status, 200);
  authorization = new URL((await started.json()).url);
  const completed = await fetch(origin + '/auth/callback?' + new URLSearchParams({ state: authorization.searchParams.get('state'), client_id: 'oaiapp_native_chat_ui', code: 'synthetic-code' }), { redirect: 'manual' });
  assert.equal(completed.status, 303);
  }
  return { origin, close: async () => {
    configureChatGPTTransport(undefined);
    httpServer.closeAllConnections?.(); await new Promise(resolve => httpServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  } };
}
