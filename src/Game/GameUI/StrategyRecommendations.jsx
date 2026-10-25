import { recommendDecisions } from '../../../server/simulation/recommendations.js';
export default function StrategyRecommendations({strategy,date,busy,onDecision,onDiscuss}) {
  const options=recommendDecisions(strategy,date);
  return <section><h2>Советники · варианты решений</h2><p>Программные рекомендации доступны без подключения. Сравните пользу, риск, цену и срок; выполнение требует вашего выбора.</p>
    {options.map(o=><article className="strategy-option" key={o.action.type}><h3>{o.title}</h3><p>{o.reason}</p><p className="strategy-risk">Риск: {o.risk}</p>{o.cost&&<small>Цена: {o.cost.treasury.toLocaleString('ru-RU')} млн € · {o.cost.capital} поддержки</small>}{o.description&&<details><summary>Последствия по правилам</summary><p>{o.description}</p></details>}{o.error&&<p className="strategy-error">{o.error}</p>}<div className="strategy-action-row"><button disabled={busy||Boolean(o.error)} onClick={()=>onDecision(o.action)}>Принять решение</button><button disabled={busy} onClick={()=>onDiscuss(`Обсудим вариант «${o.title}». ${o.reason} Какие риски и альтернативы?`)}>Обсудить с ИИ</button></div></article>)}
    {!options.length&&<p>Срочных рекомендаций нет. Поставьте цель в чате решений, чтобы обсудить дальнейший курс.</p>}
    <button className="strategy-primary" disabled={busy} onClick={()=>onDiscuss('Предложи три альтернативных решения для нашей страны: укажи пользу и риск каждого с учётом бюджета, миграции и безопасности. Не исполняй их вместе.')}>Запросить варианты у ИИ в чате</button><small>Откроется подготовленный текст. Отправка расходует лимит ChatGPT; переход в чат бесплатен.</small>
  </section>;
}
