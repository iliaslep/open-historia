const statuses={active:'Выполняется',success:'Первый этап выполнен',partial:'Частичный результат',setback:'Возникли препятствия'};
export default function StrategyInitiatives({strategy,onDiscuss}) {
  const plans=strategy.story?.initiatives||[];
  return <section><h2>Замыслы и решения</h2><p>Свободные приказы становятся частью истории. Они исполняются при перемотке времени; бюджет уже выделен, а успех зависит от сложности и обстановки.</p><button className="strategy-primary" onClick={()=>onDiscuss('Хочу предложить новый свободный замысел: ')}>Написать свой замысел</button>
    {!plans.length&&<p>Например: создать космическое агентство, начать школьную реформу, созвать международный конгресс или предложить новую форму государственного устройства.</p>}
    {plans.slice().reverse().map(p=><article key={p.id} className="strategy-option"><small>{statuses[p.status]} · {p.visibility==='private'?'Закрытая':'Открытая'} инициатива</small><h3>{p.title}</h3><p>{p.description}</p><small>Выделено {p.budget.toLocaleString('ru-RU')} млн € · {p.started} → {p.due}</small>{p.result&&<p>{p.result}</p>}<button onClick={()=>onDiscuss(`Продолжим замысел «${p.title}». Текущее состояние: ${p.result||p.description}. Предложи следующий этап с учётом уже сделанного.`)}>Обсудить продолжение</button></article>)}
  </section>;
}
