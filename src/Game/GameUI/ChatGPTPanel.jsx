import { useEffect, useState } from 'react';

async function request(action, body) {
  const response = await fetch(`/api/strategy/chatgpt/${action}`, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'ChatGPT сейчас недоступен.');
  return data;
}

export default function ChatGPTPanel({ gameId, target }) {
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('Оцените бюджет и предложите три следующих решения.');
  const [reply, setReply] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const web = Boolean(import.meta.env.VITE_OH_WEB);
  useEffect(() => {
    if (web) return;
    let valid = true;
    const refresh = () => request('status').then((data) => { if (valid) setStatus(data); }).catch((e) => { if (valid) setError(e.message); });
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => { valid = false; clearInterval(timer); };
  }, [web]);
  useEffect(() => {
    let valid = true;
    if (status?.canInfer) request('models').then(({ models: items }) => {
      if (valid) { setModels(items); setModel(items[0]?.id || ''); }
    }).catch((e) => { if (valid) setError(e.message); });
    return () => { valid = false; };
  }, [status?.active, status?.canInfer]);
  const run = async (task) => {
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try { await task(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const login = (accountId) => run(async () => {
    const result = await request('start', accountId ? { accountId } : {});
    setLoginUrl(result.url);
    setStatus(await request('status'));
    // The one-use PKCE URL contains no retained identity/access/refresh token.
    const link = document.createElement('a');
    link.href = result.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.click();
    setMessage('Завершите вход в открывшемся браузере. При блокировке нового окна повторите вход.');
  });
  if (web) return <section><h2>ChatGPT</h2><p>Вход через подписку доступен в локальной версии для Windows. Программные советники находятся во вкладке «Кабинет».</p></section>;
  return <section className="strategy-chatgpt"><h2>Советник ChatGPT</h2>
    <p>Необязательный официальный вход. Запросы используют лимит вашего плана ChatGPT; доступ зависит от аккаунта и доступности OpenAI. Советник видит сводку партии и не изменяет мир.</p>
    {status?.accounts?.length > 0 && <label>Аккаунт<select disabled={busy} value={status.active || ''} onChange={(e) => run(async () => { setStatus(await request('select', { accountId: e.target.value })); setReply(null); })}>
      {status.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.connected ? '' : ' · отключён'}</option>)}
    </select></label>}
    {!status?.canInfer && <p>ChatGPT не подключён. Игра и программные рекомендации продолжают работать без него.</p>}
    <button disabled={busy} onClick={() => login(status?.active)}>Continue with ChatGPT</button>
    {loginUrl && !status?.canInfer && !status?.error && <a href={loginUrl} target="_blank" rel="noopener noreferrer">Открыть официальный вход в браузере</a>}
    {status?.accounts?.length > 0 && <button disabled={busy} onClick={() => login()}>Добавить другой аккаунт</button>}
    {status?.connected && <button disabled={busy} onClick={() => run(async () => { const result = await request('logout', {}); setMessage(result.message); setStatus(await request('status')); setModels([]); setReply(null); })}>Отключить ChatGPT</button>}
    {status?.canInfer && <><label>Модель<select value={model} disabled={busy} onChange={(e) => setModel(e.target.value)}>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>Вопрос советнику<textarea rows="5" maxLength="3000" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></label>
      <button disabled={busy || !model || !prompt.trim()} onClick={() => run(async () => { setReply(null); setReply(await request('ask', { gameId, target, model, prompt })); })}>Отправить · расходует лимит ChatGPT</button>
      {busy && <button onClick={() => request('cancel', {}).catch((e) => setError(e.message))}>Остановить ответ</button>}
    </>}
    {status?.error ? <p className="strategy-error" role="alert">{status.error}</p> : message && <p role="status">{message}</p>}
    {error && <p className="strategy-error" role="alert">{error}</p>}
    {reply && <article><p className="strategy-answer">{reply.text}</p><small>Токены: вход {reply.usage?.input_tokens ?? '—'}, выход {reply.usage?.output_tokens ?? '—'}. Рекомендации применяйте через игровые кнопки.</small></article>}
    <a href="https://developers.openai.com/siwc/token-sharing-open-source" target="_blank" rel="noreferrer">Официальные условия подключения</a>
  </section>;
}
