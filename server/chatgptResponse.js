import { ChatGPTNetworkError, ChatGPTProtocolError } from './chatgptErrors.js';

export async function readChatGPTJson(response, stage) {
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ChatGPTProtocolError('json');
    throw new ChatGPTNetworkError(error, stage);
  }
}

const read = (reader, signal) => new Promise((resolve, reject) => {
  const abort = () => reject(signal.reason || new DOMException('Aborted', 'AbortError'));
  if (signal?.aborted) { abort(); return; }
  signal?.addEventListener('abort', abort, { once: true });
  reader.read().then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
});

export async function consumeChatGPTResponse(response, { signal } = {}) {
  if (!response.body) throw new ChatGPTProtocolError('empty');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '';
  try {
    while (true) {
      const chunk = await read(reader, signal);
      if (chunk.done) throw new ChatGPTProtocolError('incomplete');
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n');
      if (buffer.length > 1000000) throw new ChatGPTProtocolError('limit');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        let event;
        try { event = JSON.parse(data); } catch { throw new ChatGPTProtocolError('event'); }
        if (event.type === 'response.output_text.delta') {
          if (typeof event.delta !== 'string') throw new ChatGPTProtocolError('event');
          text += event.delta;
        }
        if (event.type === 'response.output_text.done' && !text && typeof event.text === 'string') text = event.text;
        if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new ChatGPTProtocolError('failed');
        if (text.length > 30000) throw new ChatGPTProtocolError('limit');
        if (event.type === 'response.completed') {
          const output = event.response?.output;
          const canonical = Array.isArray(output) ? output.flatMap(item => Array.isArray(item.content) ? item.content : [])
            .filter(item => item.type === 'output_text' && typeof item.text === 'string').map(item => item.text).join('\n') : '';
          const answer = canonical || text;
          if (!answer) throw new ChatGPTProtocolError('empty');
          if (answer.length > 30000) throw new ChatGPTProtocolError('limit');
          // The protocol's terminal event is success. Waiting for TCP/HTTP EOF
          // can hang behind a proxy or turn a complete answer into "Failed to fetch".
          return { text: answer, usage: event.response?.usage || null };
        }
      }
    }
  } catch (error) {
    if (error instanceof ChatGPTProtocolError) throw error;
    throw new ChatGPTNetworkError(error, 'response-body');
  } finally {
    // Cancellation is best-effort; a stalled native stream must not block UI.
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* cancellation can still be pending */ }
  }
}
