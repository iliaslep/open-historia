import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { legacyNews } from '../../../server/simulation/newspaper.js';
const categories={politics:'Политика',economy:'Экономика',world:'Мир',science:'Наука',society:'Общество',security:'Безопасность'};
const format=d=>new Intl.DateTimeFormat('ru-RU',{dateStyle:'long',timeZone:'UTC'}).format(new Date(`${d}T00:00:00Z`));
export default function StrategyNewspaper({strategy,range,onClose,label}) {
  const [section,setSection]=useState('all'),[selected,setSelected]=useState(null);
  const root=useRef(null);
  const raw=(strategy.story?.news||legacyNews(strategy,'0001-01-01')).filter(a=>(!range?.from||a.date>range.from)&&(!range?.to||a.date<=range.to));
  const meaningful=raw.filter(a=>!a.id.endsWith('-brief')||a.source==='ai');
  const articles=meaningful.length?meaningful:raw.slice(-1);
  const filtered=articles.filter(a=>section==='all'||a.section===section).slice().reverse();
  const article=selected?filtered.find(a=>a.id===selected):null;
  useEffect(()=>{
    const previous=document.activeElement,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';root.current?.querySelector('button')?.focus();
    const key=e=>{
      if(e.key==='Escape'){e.preventDefault();onClose();}
      if(e.key==='Tab') {
        const nodes=Array.from(root.current?.querySelectorAll('button:not(:disabled),select')||[]);
        const first=nodes[0],last=nodes.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    };
    window.addEventListener('keydown',key);
    return()=>{window.removeEventListener('keydown',key);document.body.style.overflow=overflow;previous?.focus?.();};
  },[onClose]);
  return createPortal(<div className="strategy-paper-overlay" data-no-translate><section className="strategy-newspaper" ref={root} role="dialog" aria-modal="true" aria-labelledby="strategy-paper-title">
    <div className="strategy-paper-toolbar"><span>Альтернативная история вашей партии</span><button onClick={onClose} aria-label="Закрыть газету">Вернуться в игру ×</button></div>
    <header className="strategy-paper-masthead"><div>МЕЖДУНАРОДНЫЙ ОБОЗРЕВАТЕЛЬ</div><h1 id="strategy-paper-title">Хроника мира</h1><p>{range?.from?`${format(range.from)} — ${format(range.to)}`:'Архив выпусков'} · {label(strategy.player)}</p></header>
    <nav className="strategy-paper-sections" aria-label="Разделы газеты">{[['all','Все новости'],...Object.entries(categories)].map(([id,title])=><button key={id} aria-pressed={section===id} onClick={()=>{setSection(id);setSelected(null);}}>{title}</button>)}</nav>
    {article?<article className="strategy-paper-full"><button onClick={()=>setSelected(null)}>← К выпуску</button><small>{categories[article.section]} · {format(article.date)} · {label(article.country)}</small><h2>{article.title}</h2><div className="strategy-paper-body">{article.body}</div><aside><strong>Последствия для мира</strong><p>{article.consequence}</p></aside><small>{article.source==='ai'?'Реконструкция событий ИИ':'Сводка игрового движка'} · события этой партии</small><div className="strategy-paper-pages"><button disabled={filtered.indexOf(article)===0} onClick={()=>setSelected(filtered[filtered.indexOf(article)-1]?.id)}>Предыдущая новость</button><button disabled={filtered.indexOf(article)===filtered.length-1} onClick={()=>setSelected(filtered[filtered.indexOf(article)+1]?.id)}>Следующая новость</button></div></article>:
    <div className="strategy-paper-grid">{filtered.length?filtered.map((a,i)=><article key={a.id} className={i===0?'strategy-paper-lead':''}><small>{categories[a.section]} · {format(a.date)} · {label(a.country)}</small><h2><button onClick={()=>setSelected(a.id)}>{a.title}</button></h2><div className="strategy-paper-body">{a.body}</div><p className="strategy-paper-consequence">{a.consequence}</p><button className="strategy-paper-read" onClick={()=>setSelected(a.id)}>Читать новость →</button>{a.source==='ai'&&<small>ИИ-симуляция</small>}</article>):<p>В этом выпуске пока нет открытых событий. Продвиньте время, чтобы получить новости.</p>}</div>}
    <footer>События относятся к альтернативной истории партии. Численные показатели — игровые оценки. Тайные операции не публикуются.</footer>
  </section></div>,document.body);
}
