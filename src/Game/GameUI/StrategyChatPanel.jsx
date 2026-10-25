import { useEffect, useRef, useState } from 'react';
import { conversationId, nativeThreads } from '../../../server/simulation/conversations.js';
import { strategyRequest as request } from '../../runtime/strategyRequest.js';

export default function StrategyChatPanel({ gameId, channel, target = '', chats, revision, label, busy, onBusy, onResult, onApply, onRefresh, onSettings, draft = '' }) {
  const [status, setStatus] = useState(null);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [usage, setUsage] = useState(null);
  const transcript = useRef(null);
  useEffect(()=>{if(draft)setPrompt(draft);},[draft]);
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
  useEffect(()=>{const node=transcript.current;if(node)node.scrollTop=node.scrollHeight;},[thread?.messages.length,revision]);
  const send = async (e, message = prompt) => {
    e.preventDefault();
    if (busy || sending || !message.trim()) return;
    setSending(true); onBusy(true); setError('');
    try {
      const result = await request('/api/strategy/chatgpt/chat', { gameId, channel, target, model, prompt: message, expectedRevision: revision }, { timeoutMs: 200000 });
      await onResult(result); setPrompt(''); setUsage(result.usage);
    } catch (failure) { setError(failure.message); void onRefresh().catch(() => {}); }
    finally { setSending(false); onBusy(false); }
  };
  const locked = busy || sending;
  return <section className="strategy-conversation" data-channel={channel}>
    <h2>{channel === 'decisions' ? 'Чат решений' : `Переговоры: ${label(target)}`}</h2>
    <p className="strategy-chat-help">{channel === 'decisions' ? 'Пиши приказы и обсуждай политику с правительством.' : 'Обсуждай условия с делегацией выбранной страны: она может согласиться, отказать или предложить компромисс.'} Конкретные действия появляются в предложении; проверь цену и прими его для исполнения.</p>
    <div ref={transcript} className="strategy-transcript" aria-live="polite" aria-label={channel === 'decisions' ? 'История решений' : 'История переговоров'}>
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
    {web ? <p>ИИ-чаты доступны в локальной Windows-версии. Сохранённую переписку можно читать здесь.</p> : !status?.canInfer ? <><p>Для ответа ИИ подключи ChatGPT. Переписка хранится в партии.</p><button onClick={onSettings}>Подключить ChatGPT</button></> : <form onSubmit={e=>send(e)}>
      <label className="strategy-model">Модель<select value={model} disabled={locked} onChange={e => setModel(e.target.value)}>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>{channel === 'decisions' ? 'Сообщение правительству' : 'Дипломатическое сообщение'}<textarea maxLength="3000" rows="3" placeholder={channel==='decisions'?'Опишите решение или цель вашей политики…':'Предложите условия переговоров…'} value={prompt} disabled={locked} onChange={e => setPrompt(e.target.value)} /></label>
      {channel==='decisions'&&<button type="button" disabled={locked||!model} onClick={e=>send(e,prompt.trim()?`Предложи три альтернативных проверяемых решения для цели: ${prompt}. Укажи пользу и риски. Используй suggestions, общие actions оставь пустыми.`:'Предложи три альтернативных решения для нашей страны с учётом бюджета, миграции и разведки. Укажи пользу и риски. Используй suggestions, общие actions оставь пустыми.')}>Предложить решения · ИИ</button>}
      <button className="strategy-primary" type="submit" disabled={locked || !model || !prompt.trim()}>{sending ? 'ИИ готовит ответ…' : 'Отправить · расходует лимит ChatGPT'}</button>
    </form>}
    {error && <p role="alert" className="strategy-error">{error}</p>}
    {usage && <small>Токены: вход {usage.input_tokens ?? '—'}, выход {usage.output_tokens ?? '—'}.</small>}
    <small>Время стоит на паузе. Сохраняются последние 40 реплик каждой из 32 недавних бесед.</small>
  </section>;
}
