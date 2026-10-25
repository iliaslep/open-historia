import assert from 'node:assert/strict';
import test from 'node:test';
import { strategyRequest } from './strategyRequest.js';

test('loopback request/body failures differ from errors returned by the provider adapter', async () => {
  await assert.rejects(() => strategyRequest('/api/test', {}, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /local:request/);
  await assert.rejects(() => strategyRequest('/api/test', {}, { fetchImpl: async () => ({ json: async () => { throw new TypeError('Failed to fetch'); } }) }), /local:response/);
  await assert.rejects(() => strategyRequest('/api/test', {}, { fetchImpl: async () => Response.json({ error: 'Соединение оборвалось [network:connection] [stage:response-body]' }, { status: 400 }) }), error => error.message.includes('stage:response-body') && !error.message.includes('local:'));
});

test('a stalled fetch or refresh body cannot hold game controls forever', async () => {
  for (const fetchImpl of [() => new Promise(() => {}), async () => ({ json: () => new Promise(() => {}) })]) {
    const started = Date.now();
    await assert.rejects(() => strategyRequest('/api/test', undefined, { fetchImpl, timeoutMs: 30 }), /local:timeout/);
    assert.ok(Date.now() - started < 1000);
  }
});

test('successful responses retain the request payload and do not retry an expensive message', async () => {
  let count = 0;
  const result = await strategyRequest('/api/test', { prompt: 'Приказ' }, { fetchImpl: async (url, init) => {
    count++; assert.equal(url, '/api/test'); assert.equal(init.method, 'POST'); assert.equal(JSON.parse(init.body).prompt, 'Приказ');
    return Response.json({ completed: true });
  } });
  assert.deepEqual(result, { completed: true }); assert.equal(count, 1);
});
