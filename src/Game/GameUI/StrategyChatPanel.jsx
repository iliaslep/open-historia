import { useEffect, useState } from 'react';
import { conversationId, nativeThreads } from '../../../server/simulation/conversations.js';

async function request(url, body) {
  const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || 'Не удалось обработать сообщение.');
  return data;
}

export default function StrategyChatPanel({ gameId, channel, target = '', chats, revision, label, busy, onBusy, onResult, onApply, onRefresh, onSettings }) {
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [usage, setUsage] = useState(null);
  const web = Boolean(import.meta.env.VITE_OH_WEB);
  const thread = nativeThreads(Array.isArray(chats) ? chats : []).find(t => t.id === conversationId(channel, target));
  useEffect(() => {
    if (web) return;
    let valid = true;
    request('/api/strategy/chatgpt/status').then(async s => {
      if (valid) setStatus(s);
      if (s.canInfer) {
        const result = await request('/api/strategy/chatgpt/models');
        if (valid) { setModels(result.models); setModel(result.models[0]?.id || ''); }
      }
    }).catch(e => { if (valid) setError(e.message); });
    return () => { valid = false; };
  }, [web]);
  const send = async e => {
    e.preventDefault();
    if (busy || sending || !prompt.trim()) return;
    setSending(true); onBusy(true); setError('');
    try {
      const result = await request('/api/strategy/chatgpt/chat', { gameId, channel, target, model, prompt, expectedRevision: revision });
      await onResult(result); setPrompt(''); setUsage(result.usage);
    } catch (failure) { setError(failure.message); await onRefresh().catch(() => {}); }
    finally { setSending(false); onBusy(false); }
  };
  const locked = busy || sending;
  return <section className="strategy-conversation" data-channel={channel}>
    <h2>{channel === 'decisions' ? 'Чат решений' : `Переговоры: ${label(target)}`}</h2>
    <p>{channel === 'decisions' ? 'Пиши приказы и обсуждай политику с правительством.' : 'Обсуждай условия с делегацией выбранной страны: она может согласиться, отказать или предложить компромисс.'} Конкретные действия появляются в предложении; проверь цену и прими его для исполнения.</p>
    <div className="strategy-transcript" aria-live="polite" aria-label={channel === 'decisions' ? 'История решений' : 'История переговоров'}>
      {!thread?.messages.length && <p>Беседа ещё не начата. {channel === 'decisions' ? 'Например: «Предлагаю повысить налоговую нагрузку до 40 %».' : 'Например: «Предлагаем торговое соглашение на год. Какие условия вы готовы принять?»'}</p>}
      {thread?.messages.map(m => <article key={m.id} className={`strategy-message strategy-message-${m.role}`}>
        <small>{m.time} · {m.role === 'user' ? 'Вы' : channel === 'decisions' ? 'Правительство · ИИ' : `${label(target)} · ИИ`}</small>
        <p className="strategy-answer">{m.content}</p>
        {m.proposal && <div className="strategy-proposal">
          <strong>{m.proposal.status === 'applied' ? 'Исполнено движком' : m.proposal.status === 'blocked' ? 'Недоступно по правилам' : 'Предложение · ещё не исполнено'}</strong>
          {(m.proposal.receipts || m.proposal.description).map((s, i) => <p key={i}>{s}</p>)}
          {m.proposal.status === 'pending' && <><p>Цена: {m.proposal.cost.treasury.toLocaleString('ru-RU')} млн €; поддержка: {m.proposal.cost.capital}.</p>
            {m.proposal.revision === revision ? <button disabled={locked} onClick={() => onApply(m.id)}>{channel === 'decisions' ? 'Принять и выполнить' : 'Принять условия'}</button> : <p>Партия изменилась. Обсудите предложение заново.</p>}</>}
          {m.proposal.error && <p>{m.proposal.error}</p>}
        </div>}
      </article>)}
    </div>
    {web ? <p>ИИ-чаты доступны в локальной Windows-версии. Сохранённую переписку можно читать здесь.</p> : !status?.canInfer ? <><p>Для ответа ИИ подключи ChatGPT. Переписка хранится в партии.</p><button onClick={onSettings}>Подключить ChatGPT</button></> : <form onSubmit={send}>
      <label>Модель<select value={model} disabled={locked} onChange={e => setModel(e.target.value)}>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>{channel === 'decisions' ? 'Сообщение правительству' : 'Дипломатическое сообщение'}<textarea maxLength="3000" rows="4" value={prompt} disabled={locked} onChange={e => setPrompt(e.target.value)} /></label>
      <button className="strategy-primary" type="submit" disabled={locked || !model || !prompt.trim()}>{sending ? 'ИИ готовит ответ…' : 'Отправить · расходует лимит ChatGPT'}</button>
    </form>}
    {error && <p role="alert" className="strategy-error">{error}</p>}
    {usage && <small>Токены: вход {usage.input_tokens ?? '—'}, выход {usage.output_tokens ?? '—'}.</small>}
    <small>Время стоит на паузе. Сохраняются последние 40 реплик каждой из 32 недавних бесед.</small>
  </section>;
}
