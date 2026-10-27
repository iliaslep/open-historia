// @ts-check
// Open-ended plans and a persistent alternative-history memory. Text is data;
// resource debits, deadlines, chances and bounded consequences belong to rules.
import { addGameDays, normalizeGameDate } from '../gameDates.js';
/** @typedef {import('./strategy.js').Strategy} Strategy */
/** @typedef {{type:'initiative',title:string,description:string,budget:number,days:number,focus:string,difficulty:string,visibility:string,target?:string}} InitiativeAction */
/** @typedef {{id:string,title:string,description:string,budget:number,days:number,focus:string,difficulty:string,visibility:string,target?:string,owner:string,started:string,due:string,status:string,result:string}} Initiative */
/** @typedef {{id:string,date:string,country:string,title:string,body:string,section:string,consequence:string,source:string,initiativeId?:string}} Article */
/** @typedef {{version:1,sequence:number,initiatives:Initiative[],facts:Array<{date:string,country:string,title:string,text:string,visibility:string,sourceId:string}>,news:Article[]}} Story */
export const effectLabel=(/** @type {string} */ focus)=>focus==='economy'||focus==='science'?'Промышленный и научный потенциал':focus==='security'?'Боеготовность':focus==='governance'?'Поддержка решений':'Стабильность';
export const FOCUSES=['economy','society','diplomacy','security','science','governance'];
const difficulties=['routine','ambitious','breakthrough'];
const statuses=['active','success','partial','setback'];
const sections=['politics','economy','world','science','society','security'];
/** @param {unknown} x @returns {x is Record<string,unknown>} */
const object=x=>Boolean(x)&&typeof x==='object'&&!Array.isArray(x);
/** @param {unknown} x @param {number} max @returns {x is string} */
const text=(x,max)=>typeof x==='string'&&Boolean(x.trim())&&x.length<=max;
/** @param {unknown} x @param {number} min @param {number} max @returns {x is number} */
const int=(x,min,max)=>typeof x==='number'&&Number.isSafeInteger(x)&&x>=min&&x<=max;
/** @param {unknown} x @returns {x is string} */
const date=x=>typeof x==='string'&&/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(x)&&normalizeGameDate(x)===x;
/** @returns {Story} */
export const createStory=()=>({version:1,sequence:0,initiatives:[],facts:[],news:[]});
/** @param {unknown} raw @param {Strategy} s @param {string} [target] @returns {InitiativeAction} */
export function validateInitiativeAction(raw,s,target) {
  if(!object(raw)||raw.type!=='initiative'||Object.keys(raw).some(k=>!['type','title','description','budget','days','focus','difficulty','visibility','target'].includes(k))
    ||!text(raw.title,140)||!text(raw.description,1800)||!int(raw.budget,0,1000000)||!int(raw.days,1,3650)
    ||!FOCUSES.includes(String(raw.focus))||!difficulties.includes(String(raw.difficulty))||!['public','private'].includes(String(raw.visibility))
    ||(raw.target!==undefined&&(typeof raw.target!=='string'||raw.target===s.player||!Object.hasOwn(s.countries,raw.target)))
    ||(target!==undefined&&(raw.target!==target||raw.visibility!=='public')))throw new Error('Неверно оформлена свободная инициатива.');
  return /** @type {InitiativeAction} */({...raw,title:raw.title.trim(),description:raw.description.trim()});
}
/** @param {Story} story @param {Strategy} s @param {string} at */
export function validateStory(story,s,at) {
  if(!object(story)||story.version!==1||!int(story.sequence,0,Number.MAX_SAFE_INTEGER)||!Array.isArray(story.initiatives)||story.initiatives.length>120
    ||!Array.isArray(story.facts)||story.facts.length>120||!Array.isArray(story.news)||story.news.length>180)throw new Error('Повреждена история симуляции.');
  const ids=new Set();
  for(const p of story.initiatives) {
    if(!object(p))throw new Error('Повреждена инициатива.');
    const {id,owner,started,due,status,result,...action}=p;
    validateInitiativeAction({type:'initiative',...action},s);
    if(!text(id,100)||ids.has(id)||owner!==s.player||!date(started)||!date(due)||due!==addGameDays(started,p.days)
      ||!statuses.includes(status)||typeof result!=='string'||result.length>2500||(at&&(started>at||(status==='active'?due<=at:due>at))))throw new Error('Повреждены сроки инициативы.');
    ids.add(id);
  }
  if(story.initiatives.filter(p=>p.status==='active').length>20)throw new Error('Слишком много активных инициатив.');
  for(const f of story.facts)if(!object(f)||!date(f.date)||(at&&f.date>at)||!Object.hasOwn(s.countries,f.country)||!text(f.title,140)||!text(f.text,2500)
    ||!['public','private'].includes(f.visibility)||!text(f.sourceId,100))throw new Error('Повреждена память альтернативной истории.');
  for(const a of story.news) {
    if(!object(a)||!text(a.id,150)||ids.has(a.id)||!date(a.date)||(at&&a.date>at)||!Object.hasOwn(s.countries,a.country)||!text(a.title,180)
      ||!text(a.body,2500)||!text(a.consequence,1200)||!sections.includes(a.section)||!['engine','ai'].includes(a.source)
      ||(a.initiativeId!==undefined&&!text(a.initiativeId,100)))throw new Error('Повреждён газетный архив.');
    ids.add(a.id);
  }
}
/** @param {Strategy} s @param {Record<string,unknown>} raw @param {string} at @param {(cash:number,support?:number)=>void} spend */
export function startInitiative(s,raw,at,spend) {
  const p=validateInitiativeAction(Object.fromEntries(Object.entries(raw).filter(([k])=>k!=='expectedRevision')),s);
  const story=s.story||(s.story=createStory());
  if(story.sequence===Number.MAX_SAFE_INTEGER)throw new Error('Исчерпан счётчик инициатив.');
  const active=story.initiatives.filter(p=>p.status==='active');
  if(active.length>=20)throw new Error('Сначала дождитесь результатов активных инициатив (предел 20).');
  if(active.some(a=>a.title.toLowerCase()===p.title.toLowerCase()&&a.target===p.target))throw new Error('Такой замысел уже выполняется. Уточните его или дождитесь результата.');
  const rank=difficulties.indexOf(p.difficulty);
  const minimum=rank===0?0:Math.max(1,Math.round(s.countries[s.player].gdp*(rank===1?.00005:.0005)));
  if(p.budget<minimum)throw new Error(`Для масштаба «${rank===1?'сложный':'прорывной'}» нужно хотя бы ${minimum} млн €. Сократите первый этап или увеличьте бюджет.`);
  if(p.days<(rank===2?30:rank===1?7:1))throw new Error('Масштабный замысел требует времени: сложный этап — от 7 дней, прорывной — от 30.');
  spend(p.budget,[3,8,15][rank]);
  const initiative={...p,id:`initiative-${++story.sequence}`,owner:s.player,started:at,due:addGameDays(at,p.days),status:'active',result:''};
  story.initiatives.push(initiative);
  story.initiatives=[...story.initiatives.filter(p=>p.status!=='active').slice(-100),...story.initiatives.filter(p=>p.status==='active')];
  return `${p.visibility==='private'?'Закрытая инициатива':'Инициатива'} «${p.title}» принята: ${p.budget} млн €, ${[3,8,15][rank]} поддержки. Первый результат — ${initiative.due}. Реакция участников и успех не гарантированы.`;
}
/** @param {Strategy} s @param {string} owner @param {string} focus @param {number} amount */
export function applyStoryEffect(s,owner,focus,amount) {
  const c=s.countries[owner];
  const field=focus==='economy'||focus==='science'?'industry':focus==='security'?'readiness':focus==='governance'?'capital':'stability';
  const before=c[field];c[field]=Math.max(0,Math.min(100,before+amount));
  return c[field]-before;
}
/** @param {Strategy} s @param {string} at @param {()=>number} roll @param {(text:string,country?:string)=>void} note */
export function resolveInitiatives(s,at,roll,note) {
  if(!s.story)return;
  for(const p of s.story.initiatives.filter(p=>p.status==='active'&&p.due===at)) {
    const c=s.countries[s.player],rank=difficulties.indexOf(p.difficulty);
    const chance=Math.max(.15,Math.min(.9,.6+c.stability/500-rank*.12+(p.target?(c.relations[p.target]||0)/500:0)));
    const draw=roll();p.status=draw<chance?'success':draw<Math.min(.96,chance+.25)?'partial':'setback';
    const effect=p.status==='success'?[1,2,3][rank]:p.status==='partial'?0:-1;
    const change=applyStoryEffect(s,s.player,p.focus,effect);
    if(p.target)for(const [a,b]of[[s.player,p.target],[p.target,s.player]])s.countries[a].relations[b]=Math.max(-100,Math.min(100,(s.countries[a].relations[b]||0)+(p.status==='success'?4:p.status==='partial'?1:-3)));
    const outcome=p.status==='success'?'первый этап выполнен':p.status==='partial'?'частичный результат, требуется продолжение':'этап столкнулся с препятствиями';
    p.result=`«${p.title}»: ${outcome}. ${p.description} Израсходовано ${p.budget} млн €. ${change?`${effectLabel(p.focus)} ${change>0?'+':''}${change}.`:'Числовой показатель не изменился; результат сохранён в истории.'}`;
    s.story.facts.push({date:at,country:s.player,title:p.title,text:p.result,visibility:p.visibility,sourceId:p.id});
    note(`${p.visibility==='private'?'Закрытая инициатива':'Инициатива'} «${p.title}»: ${outcome}.`,s.player);
    if(p.visibility==='public')s.story.news.push({id:`news-${p.id}`,date:at,country:s.player,title:`${p.title}: ${outcome}`,body:p.result,section:p.focus==='diplomacy'?'world':p.focus==='governance'?'politics':p.focus,consequence:`Бюджет этапа: ${p.budget} млн €. ${change?`${effectLabel(p.focus)}: ${change>0?'+':''}${change}.`:'Мгновенного роста показателей нет.'}`,source:'engine',initiativeId:p.id});
  }
  s.story.facts=s.story.facts.slice(-120);s.story.news=s.story.news.slice(-180);
}
/** @param {string} message */
export const privateHistory=message=>/развед|агент|Контрразвед|Закрытая инициатива|Сеть в|Сведения .*подозрен|Получен отчёт|сбор сведений|источник|двойного/i.test(message);
/** @param {Strategy} s @param {string} at */
export function publishDailyNews(s,at) {
  const story=s.story||(s.story=createStory());
  const entries=s.history.filter(h=>h.date===at&&!privateHistory(h.text)&&!h.text.startsWith('Инициатива «'));
  const important=entries.sort((a,b)=>Number(b.country===s.player)-Number(a.country===s.player)).slice(0,8);
  for(const [i,h]of important.entries()) {
    const section=/конфликт|контроль|войн|перемири/i.test(h.text)?'world':/ВВП|инвест|бюджет|промышлен|торгов/i.test(h.text)?'economy':'politics';
    const sentence=h.text.split(/[.!?]/)[0];
    story.news.push({id:`news-${at}-${i}`,date:at,country:h.country,title:sentence.length>140?sentence.slice(0,137)+'…':sentence,body:h.text,section,consequence:'Изменения учтены в состоянии мира; продолжение зависит от новых решений и последующих ходов.',source:'engine'});
  }
  if(!important.length&&!story.news.some(a=>a.date===at))story.news.push({id:`news-${at}-brief`,date:at,country:s.player,title:'Мир продолжает жить: правительства исполняют текущие решения',body:`На ${at} не зафиксировано новых крупных открытых кризисов. Продолжаются государственные программы, бюджетные расчёты и подготовка ранее утверждённых решений.`,section:'politics',consequence:'Новые результаты появятся по срокам инициатив. На паузе программы не продвигаются.',source:'engine'});
  story.news=story.news.slice(-180);
}
/** @param {Strategy} s @param {boolean} [publicOnly] */
export function storyMemory(s,publicOnly=false) {
  if(!s.story)return {initiatives:[],facts:[]};
  const visible=s.story.initiatives.filter(p=>!publicOnly||p.visibility==='public');
  return {initiatives:[...visible.filter(p=>p.status==='active'),...visible.filter(p=>p.status!=='active').slice(-3)].map(p=>({id:p.id,title:p.title,description:p.description.slice(0,140),due:p.due,status:p.status,result:p.result.slice(0,160),target:p.target})),
    facts:s.story.facts.filter(f=>!publicOnly||f.visibility==='public').slice(-6).map(f=>({...f,text:f.text.slice(0,350)}))};
}
