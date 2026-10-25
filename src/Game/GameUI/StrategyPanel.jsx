import { useEffect, useRef, useState } from 'react';
import { activateGame, createGame, refreshLibraryCatalog, useLibraryState } from '../../runtime/library.js';
import { dailyBudget } from '../../../server/simulation/strategy.js';
import { saveTextToDisk } from '../../runtime/saveFile.js';
import { acceptFor } from '../../runtime/fileAccept.js';
import ChatGPTPanel from './ChatGPTPanel.jsx';
import StrategyChatPanel from './StrategyChatPanel.jsx';
import StrategySociety from './StrategySociety.jsx';
import StrategyIntelligence from './StrategyIntelligence.jsx';
import StrategyRecommendations from './StrategyRecommendations.jsx';
import { strategyRequest as api } from '../../runtime/strategyRequest.js';
import './strategy.css';

const money = (value) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(value);
const labels = { Germany: 'Германия', France: 'Франция', 'United Kingdom': 'Великобритания', 'United States': 'США', China: 'Китай', Russia: 'Россия', Italy: 'Италия', Japan: 'Япония', India: 'Индия', Spain: 'Испания' };
const label = (name) => labels[name] || name;

export default function StrategyPanel() {
  const { activeGameId, activeGame, games, scenarios, loaded } = useLibraryState();
  const activeId = useRef(activeGameId);
  useEffect(()=>{activeId.current=activeGameId;},[activeGameId]);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [country, setCountry] = useState('Germany');
  const [target, setTarget] = useState('France');
  const [tax, setTax] = useState(38);
  const [spending, setSpending] = useState(35);
  const [aid, setAid] = useState(500);
  const [tab, setTab] = useState('decisions');
  const [draft, setDraft] = useState('');
  const discuss = text => {setDraft(text);setTab('decisions');};
  const [compact, setCompact] = useState(false);
  const [seed, setSeed] = useState(20161208);
  const [startDate, setStartDate] = useState('2016-12-08');
  const [creating, setCreating] = useState(false);
  const refresh = async () => {
    if (!activeGameId) { setData(null); return; }
    const details = await api(`/api/games/${encodeURIComponent(activeGameId)}`);
    if (activeId.current !== activeGameId) return;
    setData(current => current?.world?.simulation?.revision > details.data.world?.simulation?.revision ? current : details.data);
  };
  useEffect(() => {
    let valid = true;
    if (activeGameId) api(`/api/games/${encodeURIComponent(activeGameId)}`).then((details) => { if (valid) setData(details.data); }).catch((e) => { if (valid) setError(e.message); });
    return () => { valid = false; };
  }, [activeGameId, activeGame?.cacheToken]);
  const run = async (task) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await task(); }
    catch (e) { setError(e.message); void refresh().catch(() => {}); }
    finally { setBusy(false); }
  };
  const strategy = data?.world?.strategy;
  const player = strategy?.countries?.[strategy.player];
  const native = Boolean(strategy && data?.game?.simulationMode === 'native');
  useEffect(()=>{
    if(strategy && (target===strategy.player || !Object.hasOwn(strategy.countries,target))) setTarget(Object.keys(strategy.countries).filter(id=>id!==strategy.player).sort()[0] || '');
  },[strategy,target]);
  const acceptResult = async (result) => {
    setData(current => ({ ...current, game: result.game, world: result.world, ...(result.chat ? { chat: result.chat } : {}) }));
    await refreshLibraryCatalog({ force: true });
    window.dispatchEvent(new CustomEvent('oh:active-game-changed', { detail: { gameId: activeGameId } }));
  };
  const command = (operation, body) => run(async () => {
    const result = await api(`/api/games/${encodeURIComponent(activeGameId)}/simulation/${operation}`, {
      ...body, expectedRevision: data.world.simulation.revision,
    });
    await acceptResult(result);
  });
  const decision = (type, value) => command('decision', { type, ...(value !== undefined ? { value } : {}), target });
  const newGame = () => run(async () => {
    const scenario = scenarios.find((s) => s.id === 'default') || scenarios[0];
    if (!scenario) throw new Error('Нет сценария. Импортируйте сценарий через библиотеку исходной игры.');
    const details = await createGame({ name: `Стратегия · ${label(country)} · ${startDate}`, scenarioId: scenario.id, setActive: false,
      gamePatch: { country, gameDate: startDate, startDate, difficulty: 'standard', language: 'Russian' } });
    await api(`/api/games/${encodeURIComponent(details.game.id)}/simulation/start`, { seed: Number(seed) });
    setCreating(false);
    await activateGame(details.game.id);
    await refreshLibraryCatalog({ force: true });
  });
  const exportGame = () => run(async () => {
    const bundle = await api(`/api/games/${encodeURIComponent(activeGameId)}/export`);
    await saveTextToDisk(JSON.stringify(bundle), `strategy-${data.game.gameDate}.json`);
  });
  const importGame = (file) => { if (file) run(async () => {
    const details = await api('/api/games/import', JSON.parse(await file.text()));
    await activateGame(details.game.id);
  }); };
  const budget = player ? dailyBudget(player, strategy.wars.some((w) => w.a === strategy.player || w.b === strategy.player)) : null;
  return <aside className={`strategy ${compact ? 'strategy-compact' : ''}`} data-game-id={native ? activeGameId : ''} data-no-translate>
    <header><div><strong>ГОСУДАРСТВО</strong><small>Автономная стратегия · локальная партия</small></div>
      <button onClick={() => setCompact(!compact)} aria-label={compact ? 'Развернуть панель' : 'Свернуть панель'}>{compact ? 'Развернуть' : 'Карта ↗'}</button></header>
    {!compact && <>
      <nav className="strategy-library"><button onClick={() => setCreating(!creating)}>Новая партия</button>
        <select aria-label="Сохранённые партии" value={activeGameId || ''} disabled={busy} onChange={(e) => run(() => activateGame(e.target.value))}>
          <option value="" disabled>Выберите сохранение</option>{games.filter((g) => g.simulationMode === 'native').map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select></nav>
      {activeGame?.simulationMode === 'native' && !data && <p>Загрузка партии…</p>}
      {(creating || (!native && activeGame?.simulationMode !== 'native')) && <section className="strategy-create"><h2>Начать самостоятельную игру</h2>
        <p>Карта и библиотека Open Historia. Расчёты и решения стран работают без API-ключа.</p>
        <label>Государство<select value={country} onChange={(e) => setCountry(e.target.value)}>{Object.keys(labels).map((name) => <option key={name} value={name}>{label(name)}</option>)}</select></label>
        <label>Начальная дата<input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
        <label>Seed мира<input type="number" min="0" max="4294967295" value={seed} onChange={(e) => setSeed(e.target.value)} /></label>
        <button className="strategy-primary" disabled={busy || !startDate || !loaded} onClick={newGame}>{loaded ? 'Создать партию' : 'Загрузка сценариев…'}</button>
        <p className="strategy-note">Исходные экономические показатели — игровые оценки. Историческая верификация кабинета и данных на дату старта ещё не завершена.</p>
      </section>}
      {error && <p className="strategy-error" role="alert">{error}</p>}
      {native && <>
        <div className="strategy-title"><h1>{label(strategy.player)}</h1><time>{new Intl.DateTimeFormat('ru-RU', { timeZone: 'UTC', dateStyle: 'long' }).format(new Date(`${data.game.gameDate}T00:00:00Z`))}</time></div>
        <div className="strategy-clock">{[['day', '1 день'], ['week', '7 дней'], ['month', 'Месяц']].map(([step, text]) => <button key={step} disabled={busy} onClick={() => command('advance', { step })}>{busy ? '…' : `▶ ${text}`}</button>)}</div>
        <p className="strategy-status">Пауза между ходами · изменения сохраняются автоматически</p>
        <div className="strategy-metrics"><span>Казна<strong>{money(player.treasury)} млн €</strong></span><span>Бюджет/день<strong className={budget.balance < 0 ? 'negative' : ''}>{budget.balance >= 0 ? '+' : ''}{money(budget.balance)} млн €</strong></span>
          <span>Стабильность<strong>{player.stability}/100</strong></span><span>Поддержка решений<strong>{player.capital}/100</strong></span></div>
        <nav className="strategy-tabs">{[['decisions', 'Чат решений'], ['cabinet', 'Советники'], ['economy', 'Экономика'], ['society', 'Население'], ['diplomacy', 'Дипломатия'], ['intelligence', 'Разведка'], ['security', 'Оборона'], ['history', 'Сводки'], ['chatgpt', 'ChatGPT']].map(([id, text]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{text}</button>)}</nav>
        <main className={`strategy-content ${['decisions','diplomacy'].includes(tab)?'strategy-content-chat':''}`}>
        {tab === 'decisions' && <StrategyChatPanel draft={draft} key={`decisions-${activeGameId}`} gameId={activeGameId} channel="decisions" chats={data.chat} revision={data.world.simulation.revision} label={label} busy={busy} onBusy={setBusy} onResult={acceptResult} onRefresh={refresh} onApply={messageId => command('chat-apply', { messageId })} onSettings={() => setTab('chatgpt')} />}
        {tab === 'chatgpt' && <ChatGPTPanel key={activeGameId} gameId={activeGameId} target={target} />}
        {tab === 'economy' && <section><h2>Бюджет и развитие</h2><dl><dt>Годовой ВВП, игровая оценка</dt><dd>{money(player.gdp)} млн €</dd><dt>Государственный долг</dt><dd>{money(player.debt)} млн € ({Math.round(player.debt / player.gdp * 100)} % ВВП)</dd><dt>Доходы / расходы в день</dt><dd>{money(budget.revenue)} / {money(budget.services + budget.interest + budget.military)} млн €</dd><dt>Промышленность / энергетика</dt><dd>{player.industry} / {player.energy}</dd><dt>Безработица, модель</dt><dd>{player.unemployment} %</dd></dl>
          <label>Налоговая нагрузка: {tax} % ВВП (сейчас {player.tax / 100} %)<input type="range" min="20" max="60" value={tax} onChange={(e) => setTax(Number(e.target.value))} /></label><button disabled={busy} onClick={() => decision('tax', tax)}>Внести налоговую реформу · 7 дней</button>
          <label>Госрасходы: {spending} % ВВП (сейчас {player.spending / 100} %)<input type="range" min="20" max="60" value={spending} onChange={(e) => setSpending(Number(e.target.value))} /></label><button disabled={busy} onClick={() => decision('spending', spending)}>Внести бюджетную реформу · 7 дней</button>
          <button disabled={busy} onClick={() => decision('industry')}>Инфраструктура · {money(Math.round(player.gdp * 0.005))} млн € · 30 дней</button>
          <h3>Процессы</h3>{strategy.projects.filter((p) => p.owner === strategy.player).map((p, i) => <p key={i}>{({ tax: 'Налоговая реформа', spending: 'Бюджетная реформа', industry: 'Инфраструктура', mobilize: 'Подготовка резервов' })[p.kind]} — {p.due}</p>)}
        </section>}
        {['diplomacy', 'security'].includes(tab) && <section className={tab==='diplomacy'?'strategy-diplomacy':''}><label>Государство<select value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>{Object.keys(strategy.countries).filter((id) => id !== strategy.player).sort().map((id) => <option key={id} value={id}>{label(id)}</option>)}</select></label>
          <p>Отношения: {player.relations[target] || 0}/100 · {strategy.wars.some((w) => [w.a, w.b].includes(strategy.player) && [w.a, w.b].includes(target)) ? 'Военный конфликт' : 'Мир'}</p>
          {tab === 'diplomacy' && <StrategyChatPanel key={`diplomacy-${activeGameId}-${target}`} gameId={activeGameId} channel="diplomacy" target={target} chats={data.chat} revision={data.world.simulation.revision} label={label} busy={busy} onBusy={setBusy} onResult={acceptResult} onRefresh={refresh} onApply={messageId => command('chat-apply', { messageId })} onSettings={() => setTab('chatgpt')} />}
          {tab === 'diplomacy' ? <details className="strategy-manual"><summary>Договоры и прямые распоряжения</summary><button disabled={busy} onClick={() => decision('trade')}>Предложить торговое соглашение · 365 дней</button><label>Помощь, млн €<input type="number" min="1" max="1000000" value={aid} onChange={(e) => setAid(Number(e.target.value))} /></label><button disabled={busy} onClick={() => decision('aid', aid)}>Перечислить помощь</button><button disabled={busy} onClick={() => decision('sanctions')}>Ввести санкции</button><button disabled={busy} onClick={() => decision('peace')}>Предложить перемирие</button><h3>Действующие договоры</h3>{strategy.treaties.filter((t) => t.a === strategy.player || t.b === strategy.player).map((t, i) => <p key={i}>{label(t.a)} — {label(t.b)} · до {t.until}</p>)}</details>
            : <><p>Боеготовность: {player.readiness}/100. Война увеличивает бюджетные расходы и истощает силы. {Object.keys(strategy.regions || {}).length ? "Наступления меняют контроль над соседними регионами карты, сохраняя юридический суверенитет. Морские десанты не моделируются." : "У этого сохранения нет графа территории. Создайте новую партию для наступлений на карте."}</p><button disabled={busy} onClick={() => decision('mobilize')}>Подготовить резервы · 14 дней</button><button disabled={busy} onClick={() => decision('intel')}>Сбор разведывательных сведений · 7 дней</button><button disabled={busy} onClick={() => decision('war')}>Начать военную операцию</button><h3>Разведывательные оценки</h3>{strategy.reports.slice().reverse().map((r, i) => <p key={i}>{r.date} · {label(r.target)} · доверие {r.confidence} %<br />{r.text}</p>)}</>}
        </section>}
        {tab === 'society' && <StrategySociety key={activeGameId} strategy={strategy} label={label} busy={busy} onDecision={body=>command('decision',body)} />}
        {tab === 'intelligence' && <StrategyIntelligence strategy={strategy} label={label} busy={busy} target={target} setTarget={setTarget} onDecision={body=>command('decision',body)} />}
        {tab === 'cabinet' && <StrategyRecommendations strategy={strategy} date={data.game.gameDate} busy={busy} onDecision={body=>command('decision',body)} onDiscuss={discuss} />}
        {tab === 'history' && <section><h2>Хроника мира</h2>{strategy.history.length ? strategy.history.slice().reverse().map((entry, i) => <article key={i}><small>{entry.date} · {label(entry.country)}</small><p>{entry.text}</p></article>) : <p>Мир на паузе. Примите решение или продвиньте время. Другие государства самостоятельно пересматривают политику в начале месяца.</p>}</section>}
        </main>
        <footer><details><summary>Сохранения и сведения о партии</summary><button disabled={busy} onClick={exportGame}>Экспорт партии</button><label className="strategy-file">Импорт партии<input type="file" accept={acceptFor('.json,application/json')} onChange={(e) => { importGame(e.target.files[0]); e.target.value = ''; }} /></label><p>Все численные стартовые данные и коэффициенты — игровые оценки. LLM не участвует в расчётах.</p><a href="?editor=1">Редактор сценариев</a> · <a href="?strategy=1">Обновить</a></details></footer>
      </>}
    </>}
  </aside>;
}
