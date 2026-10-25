import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeChatGPTResponse, readChatGPTJson } from './chatgptResponse.js';
import { ChatGPTNetworkError, ChatGPTProtocolError } from './chatgptErrors.js';

const event = data => `data: ${JSON.stringify(data)}\n\n`;
test('a truncated or failed body never becomes a successful partial command', async () => {
  const prefix = event({ type: 'response.output_text.delta', delta: '{"actions":[{"type":"war"}]}' });
  await assert.rejects(() => consumeChatGPTResponse(new Response(prefix)), e => e instanceof ChatGPTProtocolError && e.code === 'incomplete');
  let sent = false;
  const body = new ReadableStream({ pull(controller) {
    if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode(prefix)); }
    else controller.error(new TypeError('Failed to fetch sensitive-body'));
  } });
  await assert.rejects(() => consumeChatGPTResponse(new Response(body)), e => e instanceof ChatGPTNetworkError && e.stage === 'response-body' && !e.message.includes('sensitive-body'));
});

test('a terminal response can supply canonical text even when deltas are absent', async () => {
  const result = await consumeChatGPTResponse(new Response(event({ type: 'response.completed', response: {
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'Полный ответ.' }] }], usage: { output_tokens: 5 },
  } })));
  assert.equal(result.text, 'Полный ответ.'); assert.equal(result.usage.output_tokens, 5);
});

test('an abort releases a stalled body even if its underlying transport ignores abort', async () => {
  const controller = new AbortController();
  const promise = consumeChatGPTResponse(new Response(new ReadableStream({})), { signal: controller.signal });
  controller.abort(new DOMException('Timed out', 'TimeoutError'));
  await assert.rejects(() => promise, e => e instanceof ChatGPTNetworkError && e.code === 'timeout');
});

test('metadata body errors identify their phase and never echo invalid provider bodies', async () => {
  await assert.rejects(() => readChatGPTJson({ json: async () => { throw new TypeError('Failed to fetch'); } }, 'models'), e => e instanceof ChatGPTNetworkError && e.stage === 'models');
  await assert.rejects(() => readChatGPTJson(new Response('sensitive-invalid-json'), 'models'), e => e instanceof ChatGPTProtocolError && !e.message.includes('sensitive-invalid-json'));
});
