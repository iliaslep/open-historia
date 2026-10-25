// Official SIWC OSS flow, documented at developers.openai.com/siwc/token-sharing-open-source.
// Credentials stay on the local machine and never become game assets or browser storage.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash, createPublicKey, verify } from 'node:crypto';

const AUTH = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
let desktopProtection;
// The desktop entry supplies the OS-backed Electron safeStorage after app.ready.
export function configureChatGPTProtection(protection) { desktopProtection = protection; }
const nonce = () => randomBytes(32).toString('base64url');
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const hasPlan = (record) => record?.scopes?.includes('chatgpt.tokens.use.direct') && record.scopes.includes('resource.invoke');
const authUrl = (value) => {
  const url = new URL(value);
  if (url.origin !== AUTH) throw new Error('Invalid OpenAI discovery endpoint.');
  return url.href;
};

export function createChatGPTPlan({ directory, callbackUrl, fetchImpl = fetch, now = Date.now, protection = desktopProtection }) {
  const file = path.join(directory, 'chatgpt-plan.json');
  let store;
  if (fs.existsSync(file)) {
    try {
      store = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (store.encrypted) {
        if (!protection) throw new Error('OS credential protection unavailable.');
        store = JSON.parse(protection.open(Buffer.from(store.encrypted, 'base64')));
      }
    }
    catch { throw new Error('Повреждено защищённое хранилище ChatGPT. Файл не изменён.'); }
    if (store.version !== 1 || typeof store.hostId !== 'string' || !store.accounts) throw new Error('Unsupported ChatGPT credential store.');
  } else store = { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: {}, active: null };
  const pending = new Map();
  const refreshes = new Map();
  const requests = new Map();
  let lastError = '';
  let metadata;
  const persist = () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    const serialized = JSON.stringify(store);
    const payload = protection ? JSON.stringify({ version: 1, encrypted: protection.seal(serialized).toString('base64') }) : serialized;
    fs.writeFileSync(tmp, payload, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  };
  const get = async (url, options = {}) => fetchImpl(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(30000) });
  const discovery = async () => {
    if (!metadata) {
      const r = await get(`${AUTH}/.well-known/openid-configuration`);
      if (!r.ok) throw new Error(`Не удалось получить конфигурацию OpenAI (${r.status}).`);
      const value = await r.json();
      if (value.issuer !== AUTH) throw new Error('OpenAI issuer mismatch.');
      authUrl(value.jwks_uri);
      if (value.revocation_endpoint) authUrl(value.revocation_endpoint);
      metadata = value;
    }
    return metadata;
  };
  const verifyIdentity = async (jwt, clientId, expectedNonce, expectedSubject) => {
    if (typeof jwt !== 'string' || jwt.split('.').length !== 3) throw new Error('Missing OpenAI ID token.');
    const [encodedHeader, encodedBody, signature] = jwt.split('.');
    let header, claims;
    try { header = decode(encodedHeader); claims = decode(encodedBody); }
    catch { throw new Error('Invalid OpenAI ID token encoding.'); }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported ID token signature.');
    const md = await discovery();
    const keysResponse = await get(md.jwks_uri);
    if (!keysResponse.ok) throw new Error('OpenAI signing keys unavailable.');
    const keys = await keysResponse.json();
    const key = keys.keys?.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA' && (!candidate.use || candidate.use === 'sig') && (!candidate.alg || candidate.alg === 'RS256'));
    if (!key || !verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedBody}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error('Invalid OpenAI ID token signature.');
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== AUTH || !audience.includes(clientId) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()
      || (claims.azp && claims.azp !== clientId) || (audience.length > 1 && claims.azp !== clientId)
      || (claims.nbf && claims.nbf * 1000 > now() + 60000) || typeof claims.sub !== 'string' || !claims.sub
      || (expectedNonce && claims.nonce !== expectedNonce) || (expectedSubject && claims.sub !== expectedSubject)) throw new Error('OpenAI ID token identity, expiry, audience or nonce mismatch.');
    return claims;
  };
  const exchange = async (parameters) => {
    const response = await get(`${AUTH}/api/accounts/oauth/token`, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...parameters, resource: RESOURCE }) });
    if (!response.ok) throw new Error(`Авторизация OpenAI не завершена (${response.status}). Повторите вход.`);
    return response.json();
  };
  const credentials = (response, previous = {}) => {
    if (typeof response.access_token !== 'string' || !response.access_token || response.token_type?.toLowerCase() !== 'bearer'
      || !Number.isFinite(response.expires_in) || response.expires_in <= 0 || response.expires_in > 86400) throw new Error('Invalid OAuth token response.');
    const earliest = typeof response.earliest_refresh_at === 'number' ? response.earliest_refresh_at * 1000 : Date.parse(response.earliest_refresh_at);
    return { ...previous, access_token: response.access_token, refresh_token: response.refresh_token || previous.refresh_token,
      id_token: response.id_token || previous.id_token, expires_at: now() + response.expires_in * 1000,
      earliest_refresh_at: Number.isFinite(earliest) ? earliest : 0,
      scopes: typeof response.scope === 'string' ? response.scope.split(/\s+/).filter(Boolean) : previous.scopes || [] };
  };
  const selected = () => store.accounts[store.active];
  const token = async () => {
    const account = selected();
    if (!account?.access_token || !hasPlan(account)) throw new Error('Подключите ChatGPT и разрешите использование подписки.');
    if (account.expires_at > now() + 60000) return account;
    const id = store.active;
    if (!refreshes.has(id)) {
      const operation = (async () => {
        if (!account.refresh_token || (account.earliest_refresh_at && account.earliest_refresh_at > now())) throw new Error('Сеанс нужно обновить через повторный вход ChatGPT.');
        const originalRefresh = account.refresh_token;
        const response = await exchange({ grant_type: 'refresh_token', client_id: id, refresh_token: originalRefresh });
        if (response.id_token) await verifyIdentity(response.id_token, id, null, account.subject);
        const next = credentials(response, account);
        if (store.accounts[id]?.refresh_token !== originalRefresh) throw new Error('Сеанс был отключён.');
        store.accounts[id] = next; persist(); return next;
      })();
      refreshes.set(id, operation);
      operation.finally(() => refreshes.delete(id)).catch(() => {});
    }
    return refreshes.get(id);
  };
  return {
    status() {
      return { connected: Boolean(selected()?.access_token), canInfer: Boolean(selected()?.access_token && hasPlan(selected())), active: store.active, error: lastError,
        accounts: Object.entries(store.accounts).map(([id, a]) => ({ id, label: `${a.email || a.name || 'ChatGPT'} · ${id.slice(-6)}`, active: store.active === id, connected: Boolean(a.access_token) })) };
    },
    begin(accountId) {
      if (accountId && !store.accounts[accountId]) throw new Error('Unknown ChatGPT account.');
      const callback = callbackUrl();
      const parsed = new URL(callback);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.pathname !== '/auth/callback') throw new Error('SIWC requires its loopback callback.');
      const state = nonce(), oidcNonce = nonce(), verifier = nonce();
      for (const [key, entry] of pending) if (entry.expires < now()) pending.delete(key);
      if (pending.size >= 4) throw new Error('Завершите предыдущую попытку входа.');
      pending.set(state, { clientId: accountId || null, state, nonce: oidcNonce, verifier, callback, expires: now() + 600000 });
      persist(); // stable host ID is durable before the first authorization.
      const url = new URL(`${AUTH}/api/accounts/authorize`);
      const params = { client_id: accountId || 'dynamic_agent_client', ext_agent_host_id: store.hostId,
        response_type: 'code', redirect_uri: callback, scope: SCOPES, resource: RESOURCE, state,
        nonce: oidcNonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
      if (!accountId) params.agent_name_hint = 'Open Historia Strategy';
      // No retained ID-token hint is exposed to the page; reauthorization uses
      // the documented account-selector flow and still verifies the original sub.
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      lastError = '';
      return { url: url.href };
    },
    async complete(parameters) {
      const state = parameters.get('state');
      const attempt = pending.get(state);
      if (!attempt || attempt.expires < now()) throw new Error('Недействительная или истёкшая попытка входа.');
      pending.delete(state);
      try {
        if (parameters.get('error')) throw new Error('Разрешение на вход не предоставлено.');
        const suppliedId = parameters.get('client_id');
        const clientId = attempt.clientId || suppliedId;
        if (!clientId || clientId === 'dynamic_agent_client' || !/^[A-Za-z0-9._-]{1,200}$/.test(clientId)
          || (attempt.clientId && suppliedId && suppliedId !== attempt.clientId) || !parameters.get('code')) throw new Error('Неполная или несовместимая OAuth-регистрация.');
        const response = await exchange({ grant_type: 'authorization_code', client_id: clientId, code: parameters.get('code'), code_verifier: attempt.verifier, redirect_uri: attempt.callback });
        const identity = await verifyIdentity(response.id_token, clientId, attempt.nonce, store.accounts[clientId]?.subject);
        const next = credentials(response, { client_id: clientId, subject: identity.sub, email: identity.email || '', name: identity.name || '', issuer: AUTH });
        store.accounts[clientId] = next; store.active = clientId; persist(); lastError = '';
      } catch (error) { lastError = error.message; throw error; }
      return this.status();
    },
    select(id) {
      if (!store.accounts[id]) throw new Error('Unknown ChatGPT account.');
      for (const [controller, accountId] of requests) if (accountId !== id) controller.abort();
      store.active = id; persist(); return this.status();
    },
    cancel() { for (const [controller, accountId] of requests) if (accountId === store.active) controller.abort(); return { cancelled: true }; },
    async logout() {
      const id = store.active, account = selected();
      for (const [controller, accountId] of requests) if (accountId === id) controller.abort();
      if (!account) return { revoked: true };
      const refreshToken = account.refresh_token;
      // Clear locally before network work, preventing an in-flight refresh from
      // resurrecting credentials after the user's sign-out.
      store.accounts[id] = { client_id: id, subject: account.subject, email: account.email, name: account.name, issuer: AUTH, scopes: [] }; persist();
      let revoked = false;
      if (refreshToken) try {
        const md = await discovery();
        if (md.revocation_endpoint) revoked = (await get(authUrl(md.revocation_endpoint), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: id }) })).ok;
      } catch { /* remote revocation is reported separately; tokens remain erased */ }
      return { revoked, message: revoked ? 'Сеанс отключён.' : 'Локальный выход выполнен. Отзыв на сервере не подтверждён; отключить приложение можно в настройках ChatGPT.' };
    },
    async models() {
      const account = await token();
      const response = await get(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${account.access_token}` } });
      if (!response.ok) throw new Error(`Список моделей недоступен (${response.status}).`);
      const data = await response.json();
      if (!Array.isArray(data.models)) throw new Error('Неизвестный формат каталога моделей ChatGPT.');
      return data.models.filter((m) => m.visibility === 'list' && typeof m.slug === 'string').map((m) => ({ id: m.slug, name: m.display_name || m.slug }));
    },
    async ask({ model, prompt, context }) {
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 3000 || typeof context !== 'string' || context.length > 20000) throw new Error('Слишком большой или пустой запрос.');
      const selectedId = store.active;
      const available = await this.models();
      if (!available.some((item) => item.id === model)) throw new Error('Выберите модель из каталога своего аккаунта.');
      const account = await token();
      if (store.active !== selectedId || account.client_id !== selectedId || selected()?.access_token !== account.access_token) throw new Error('Выбранный аккаунт изменился; повторите запрос.');
      const controller = new AbortController();
      requests.set(controller, account.client_id);
      try {
        const response = await get(`${RESOURCE}/responses`, { method: 'POST', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
          headers: { Authorization: `Bearer ${account.access_token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, store: false, stream: true,
            instructions: 'Ты советник в геополитической игре. Отвечай на русском, кратко (до 600 слов). История после стартовой даты альтернативна. Игровые оценки не выдавай за исторические факты. Не утверждай, что изменил состояние игры. Рекомендации исполняются только через проверяемые игровые команды.',
            input: [{ role: 'user', content: `${context}\n\nВопрос: ${prompt}` }] }) });
        if (!response.ok) throw new Error(`Запрос ChatGPT отклонён (${response.status}). Партия продолжает работать автономно.`);
        let buffer = '', text = '', completed = false, usage = null;
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          buffer = buffer.replace(/\r\n/g, '\n');
          let end;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
            if (!data || data === '[DONE]') continue;
            const event = JSON.parse(data);
            if (event.type === 'response.output_text.delta') text += event.delta || '';
            if (['error', 'response.failed', 'response.incomplete'].includes(event.type)) throw new Error('ChatGPT не завершил ответ: лимит, отказ или прерывание. Мир игры не изменён.');
            if (event.type === 'response.completed') { completed = true; usage = event.response?.usage || null; }
            if (text.length > 30000) { controller.abort(); throw new Error('Ответ превысил допустимый размер.'); }
          }
        }
        if (!completed || !text) throw new Error('Поток ChatGPT прерван до завершения. Мир игры не изменён.');
        return { text, usage };
      } finally { requests.delete(controller); }
    },
  };
}
