import { useState } from 'react';
const number=x=>x.toLocaleString('ru-RU');
export default function StrategySociety({strategy,busy,onDecision,label}) {
  const society=strategy.migration?.countries[strategy.player];
  const [quota,setQuota]=useState(society?.quota||0),[fund,setFund]=useState(100);
  if(!society)return <section><h2>Население и миграция</h2><p>В этой старой партии модель населения ещё не включена. Включение добавит игровые оценки населения, сохранив историю и экономику.</p><button disabled={busy} onClick={()=>onDecision({type:'migration_enable'})}>Включить модель населения</button></section>;
  const flows=strategy.migration.flows.filter(f=>f.from===strategy.player||f.to===strategy.player).slice(-12).reverse();
  return <section className="strategy-society"><h2>Население и миграция</h2><p className="strategy-note">Человек учитывается в одной стране. Война, занятость и условия жизни вызывают отток; переселение возможно через общую границу или торговый договор в мирную принимающую страну.</p>
    <div className="strategy-stat-grid"><div>Население<strong>{number(society.population)}</strong></div><div>Сальдо за месяц<strong>{society.net>0?'+':''}{number(society.net)}</strong></div><div>Ожидают интеграции<strong>{number(society.waiting)}</strong></div><div>Из них беженцы<strong>{number(society.refugees)}</strong></div></div>
    <h3>Приём и интеграция</h3><dl><dt>Свободно мест приёма</dt><dd>{number(society.housing-society.waiting)} / {number(society.housing)}</dd><dt>Квота / месяц</dt><dd>{number(society.quota)}</dd><dt>Целевой фонд</dt><dd>{number(society.fund)} млн €</dd><dt>Интегрированы за месяц</dt><dd>{number(society.integrated)}</dd></dl>
    <p>Интеграция стоит 2 000 € на человека. Фонд расходуется в начале месяца на прибывших ранее; интеграция освобождает места, повышает выпуск и помогает занятости. При заполнении центров свыше 80 % снижается стабильность.</p>
    <label>Квота приёма, человек/месяц<input type="number" min="0" max="1000000" value={quota} onChange={e=>setQuota(Number(e.target.value))}/></label>
    <button disabled={busy||Boolean(society.policy)} onClick={()=>onDecision({type:'migration_quota',value:quota})}>Изменить квоту · 7 дней · 5 поддержки</button>
    {society.policy&&<p className="strategy-process">Квота {number(society.policy.value)} · вступит в силу {society.policy.due}</p>}
    <label>Взнос в интеграционный фонд, млн €<input type="number" min="1" max="1000000" value={fund} onChange={e=>setFund(Number(e.target.value))}/></label>
    <button disabled={busy} onClick={()=>onDecision({type:'migration_fund',value:fund})}>Выделить из казны · {number(fund)} млн € · 2 поддержки</button>
    <button disabled={busy||Boolean(society.building)} onClick={()=>onDecision({type:'migration_housing'})}>Построить 10 000 мест · {number(Math.max(20,Math.round(strategy.countries[strategy.player].gdp*.0002)))} млн € · 30 дней</button>
    {society.building&&<p className="strategy-process">Строительство завершится {society.building}</p>}
    <h3>Последние перемещения</h3>{flows.length?<div className="strategy-flow-list">{flows.map((f,i)=><article key={i}><small>{f.date}</small><strong>{label(f.from)} → {label(f.to)}</strong><p>{number(f.people)} человек{f.refugees?' · беженцы':''}</p></article>)}</div>:<p>Перемещений ещё нет. При одинаковых условиях жизни миграция не возникает автоматически. Расчёт — в начале месяца.</p>}
    <small>Стартовое население получено из условного ВВП на жителя; это игровые оценки, а не статистика на дату сценария. Квота 0 приостанавливает приём, не высылая жителей.</small>
  </section>;
}
