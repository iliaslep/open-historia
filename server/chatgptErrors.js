// Public diagnostics are fixed strings, never transport URLs or provider bodies.
export class ChatGPTNetworkError extends Error {
  constructor(error, stage = 'request') {
    const detail = `${error?.cause?.code || ''} ${error?.code || ''} ${error?.name || ''} ${error?.message || ''}`;
    const reasons = [
      ['proxy', /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES/, 'Не удалось подключиться через системный прокси. Проверьте настройки прокси Windows.'],
      ['certificate', /ERR_CERT_|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT/, 'Не удалось проверить сертификат OpenAI. Проверьте дату Windows и доверенные сертификаты.'],
      ['dns', /ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/, 'Не удалось определить сетевой адрес OpenAI. Проверьте подключение и DNS.'],
      ['timeout', /TIMEOUT|TIMED_OUT|ETIMEDOUT|TimeoutError/, 'OpenAI не ответил вовремя.'],
      ['cancelled', /AbortError|ABORT_ERR/, 'Запрос к OpenAI отменён.'],
    ];
    const found = reasons.find(([, pattern]) => pattern.test(detail));
    const code = found?.[0] || 'connection';
    const safeStage = ['request', 'models', 'identity', 'token', 'response-start', 'response-body'].includes(stage) ? stage : 'request';
    super(`${found?.[2] || 'Соединение игры с OpenAI прервалось.'} [network:${code}] [stage:${safeStage}]`);
    this.code = code; this.stage = safeStage;
  }
}

export class ChatGPTProtocolError extends Error {
  constructor(code) {
    const messages = {
      json: 'OpenAI вернул ответ в неизвестном формате.',
      event: 'Поток ответа ChatGPT повреждён.',
      failed: 'ChatGPT не завершил ответ: отказ, лимит или ошибка сервера.',
      incomplete: 'Ответ ChatGPT оборвался до подтверждения завершения. Предложение не сохранено.',
      empty: 'ChatGPT завершил запрос без текстового ответа.',
      limit: 'Ответ ChatGPT превысил допустимый размер.',
    };
    super(`${messages[code] || messages.event} [stream:${Object.hasOwn(messages, code) ? code : 'event'}]`);
    this.code = code;
  }
}
