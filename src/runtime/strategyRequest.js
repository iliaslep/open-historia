// Keep loopback failures distinct from a JSON error returned by OpenAI's adapter.
// The deadline also covers reading the response body, even if fetch ignores abort.
export async function strategyRequest(url, body, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Локальный сервер игры не ответил вовремя. Проверьте историю перед повторной отправкой; если остальные кнопки не работают, перезапустите игру. [local:timeout]'));
    }, timeoutMs);
  });
  const operation = async () => {
    let response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, ...(body === undefined ? { cache: 'no-store' } : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }) });
    } catch { throw new Error('Не удалось связаться с локальным сервером игры. Проверьте историю перед повторной отправкой; если остальные кнопки не работают, перезапустите игру. [local:request]'); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Локальный сервер игры не передал полный ответ. Проверьте историю перед повторной отправкой. [local:response]'); }
    if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : `Ошибка сервера игры: HTTP ${response.status}.`);
    return data;
  };
  try { return await Promise.race([operation(), timeout]); }
  finally { clearTimeout(timer); }
}
