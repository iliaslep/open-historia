// @ts-check
// Native resource/timing adapter around Open Historia's shared spycraft rules.
import { deploySpy, recallSpy, expelSpy, turnSpy, resolveEspionage, draw, signalClarity, suspicionChance } from '../spycraft.js';
import { addGameDays, diffGameDays, normalizeGameDate } from '../gameDates.js';
/** @typedef {{id:string,owner:string,target:string,deployedAt:string,status:string,turnedAt:string,exposedAt:string,coverStory:string,suspected:boolean}} Spy */
/** @typedef {{version:1,sequence:number,intelligence:Record<string,number>,spies:Spy[],pending:Array<{target:string,due:string}>,upgrade?:string,knowledge:Record<string,{date:string,estimate:number}>}} Intelligence */
/** @typedef {import('./strategy.js').Strategy} Strategy */
const live=(/** @type {Spy} */ a)=>['active','turned'].includes(a.status);
/** @param {Strategy} s @returns {Intelligence} */
export const createIntelligence=s=>({version:1,sequence:0,intelligence:Object.fromEntries(Object.keys(s.countries).map(id=>[id,40])),spies:[],pending:[],knowledge:{}});
/** @param {Intelligence} n @param {Strategy} s @param {string} at */
export function validateIntelligence(n,s,at) {
  const date=(/** @type {string} */ x)=>typeof x==='string'&&/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(x)&&normalizeGameDate(x)===x;
  const int=(/** @type {number} */ x,max=100)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
  if(!n||n.version!==1||!int(n.sequence,Number.MAX_SAFE_INTEGER)||!n.intelligence||Array.isArray(n.intelligence)
    || Object.keys(n.intelligence).length!==Object.keys(s.countries).length||!Array.isArray(n.spies)||n.spies.length>200
    || !Array.isArray(n.pending)||n.pending.length>3||!n.knowledge||Array.isArray(n.knowledge)) throw new Error('Повреждена разведывательная сеть.');
  for(const id of Object.keys(s.countries)) if(!int(n.intelligence[id])) throw new Error('Повреждён уровень разведслужбы.');
  const ids=new Set(),pairs=new Set();
  for(const a of n.spies) {
    if(!a||typeof a.id!=='string'||a.id.length>100||ids.has(a.id)||!s.countries[a.owner]||!s.countries[a.target]||a.owner===a.target
      ||!['active','turned','discovered','exposed','recalled'].includes(a.status)||!date(a.deployedAt)||(at&&a.deployedAt>at)
      ||typeof a.coverStory!=='string'||a.coverStory.length>2000||typeof a.suspected!=='boolean'
      ||[a.turnedAt,a.exposedAt].some(d=>d!==''&&(!date(d)||(at&&d>at)))) throw new Error('Повреждён агент.');
    ids.add(a.id);
    if(live(a)||a.status==='discovered') {const pair=`${a.owner}|${a.target}`;if(pairs.has(pair))throw new Error('Дублирован агент.');pairs.add(pair);}
  }
  for(const p of n.pending) {
    const pair=`${s.player}|${p.target}`;
    if(!s.countries[p.target]||p.target===s.player||!date(p.due)||(at&&p.due<=at)||pairs.has(pair))throw new Error('Повреждена подготовка агента.');pairs.add(pair);
  }
  if(n.spies.filter(a=>a.owner===s.player&&live(a)).length+n.pending.length>3
    ||n.spies.filter(a=>a.target===s.player&&(live(a)||a.status==='discovered')).length>3
    ||(n.upgrade!==undefined&&(!date(n.upgrade)||(at&&n.upgrade<=at))))throw new Error('Превышены возможности разведслужбы.');
  for(const [id,k] of Object.entries(n.knowledge))if(!s.countries[id]||!k||!date(k.date)||(at&&k.date>at)||!int(k.estimate))throw new Error('Повреждена оценка угрозы.');
}
/** @param {Strategy} s @returns {{rating:number,agents:Spy[],discovered:Spy[],pending:Array<{target:string,due:string}>,upgrade?:string}|null} */
export function intelligenceView(s) {
  const n=s.spycraft;if(!n)return null;
  // Never reveal that the player's agent has secretly been turned, or reveal
  // undetected foreign agents through UI/LLM context. Raw export is a save file.
  return {rating:n.intelligence[s.player],agents:n.spies.filter(a=>a.owner===s.player&&live(a)).map(a=>({...a,status:'active',turnedAt:'',coverStory:''})),
    discovered:n.spies.filter(a=>a.target===s.player&&(a.status==='discovered'||a.status==='turned')).map(a=>({...a})),pending:n.pending,upgrade:n.upgrade};
}
/** @param {Strategy} s @param {string} type @param {string} target @param {number} value @param {string} date @param {(money:number,capital?:number)=>void} spend */
export function intelligenceDecision(s,type,target,value,date,spend) {
  if(type==='spy_enable') {if(s.spycraft)throw new Error('Разведслужба уже включена.');s.spycraft=createIntelligence(s);return 'Включены постоянные разведывательные сети и контрразведка. Старые разовые отчёты сохранены.';}
  const n=s.spycraft;if(!n)throw new Error('Сначала включите разведывательные сети.');
  if(type==='spy_upgrade') {
    if(n.upgrade)throw new Error('Подготовка контрразведки уже идёт.');
    if(n.intelligence[s.player]>=100)throw new Error('Достигнут предел разведслужбы.');
    const cost=Math.max(20,Math.round(s.countries[s.player].gdp*.0002));spend(cost,5);n.upgrade=addGameDays(date,14);
    return `Повышение уровня разведки на 10: ${cost} млн €, 14 дней. Более сильная служба улучшает обнаружение и точность оценок.`;
  }
  if(!s.countries[target]||target===s.player)throw new Error('Выберите другую страну.');
  if(type==='spy_deploy') {
    if(n.pending.some(p=>p.target===target)||n.pending.length+n.spies.filter(a=>a.owner===s.player&&live(a)).length>=3)throw new Error('Не более трёх агентов, включая подготовку; повторная сеть в стране недоступна.');
    if(n.spies.some(a=>a.owner===s.player&&a.target===target&&live(a)))throw new Error('Агент уже работает в этой стране.');
    const cost=Math.max(10,Math.round(s.countries[s.player].gdp*.0001));spend(cost,3);n.pending.push({target,due:addGameDays(date,7)});
    return `Агент в ${target}: подготовка 7 дней, ${cost} млн €, затем 1 млн €/день за действующего агента. Предел — 3 агента; обнаружение возможно.`;
  }
  if(type==='spy_recall') {
    const pending=n.pending.find(p=>p.target===target);
    const a=n.spies.find(a=>a.owner===s.player&&a.target===target&&live(a));
    if(!pending&&!a)throw new Error('В этой стране нет вашей сети или подготовки.');
    n.pending=n.pending.filter(p=>p!==pending);if(a)n.spies=recallSpy(n,a.id);
    return `Агент из ${target} отозван; содержание прекращено. Подготовительные расходы не возвращаются.`;
  }
  const a=n.spies.find(a=>a.owner===target&&a.target===s.player&&a.status==='discovered');
  if(!a)throw new Error('Обнаруженного агента этой страны нет.');
  if(type==='spy_expel') {
    n.spies=expelSpy(n,a.id,{date});
    for(const [left,right]of[[s.player,target],[target,s.player]])s.countries[left].relations[right]=Math.max(-100,(s.countries[left].relations[right]||0)-10);
    return `Агент ${target} выслан. Отношения обеих сторон −10.`;
  }
  if(type==='spy_turn') {
    if(value!==1&&value!==2)throw new Error('Легенда двойного агента: 1 — слабая оборона, 2 — сильная оборона.');
    spend(10,3);n.spies=turnSpy(n,a.id,{date,coverStory:value===1?'Слабая оборона':'Сильная оборона'});
    return `Агент ${target} перевербован за 10 млн €. Легенда «${value===1?'Слабая оборона':'Сильная оборона'}» меняет оценку угрозы у его владельца; противник может заподозрить обман.`;
  }
  throw new Error('Неизвестная разведывательная мера.');
}
/** @param {Strategy} s @param {string} date @param {number} seed @param {(text:string,country?:string)=>void} note */
export function advanceIntelligence(s,date,seed,note) {
  const n=s.spycraft;if(!n)return;
  const ids=Object.keys(s.countries).sort();
  // Maintenance paid before reports. Insolvent owners lose their networks.
  for(const a of n.spies.filter(live)) {
    const c=s.countries[a.owner];
    if(c.treasury<1) {n.spies=recallSpy(n,a.id);if(a.owner===s.player)note(`Сеть в ${a.target} отозвана: не оплачено содержание.`);}
    else c.treasury--;
  }
  if(n.upgrade===date) {n.intelligence[s.player]=Math.min(100,n.intelligence[s.player]+10);delete n.upgrade;note('Завершено усиление разведслужбы: уровень +10.');}
  for(const p of n.pending.filter(p=>p.due===date)) {
    n.spies=deploySpy(n,p.target,{date,owner:s.player});n.spies[n.spies.length-1].id=`native-spy-${++n.sequence}`;
    note(`Агент начал работу в ${p.target}. Содержание — 1 млн €/день.`);
  }
  n.pending=n.pending.filter(p=>p.due>date);
  const day=diffGameDays('0001-01-01',date)||0;
  if(day%7!==0)return;
  const round=(seed^day)>>>0;
  const candidates=ids.filter(id=>id!==s.player&&s.countries[id].treasury>=Math.max(10,Math.round(s.countries[id].gdp*.0001)))
    .map(polity=>({polity,hostility:Math.max(0,-(s.countries[polity].relations[s.player]||0))/100}));
  const before=new Set(n.spies.map(a=>a.id));
  const result=resolveEspionage(n,{date,round,playerPolity:s.player,candidates});
  n.spies=result.spies;
  for(const a of n.spies.filter(a=>!before.has(a.id))) {
    s.countries[a.owner].treasury-=Math.max(10,Math.round(s.countries[a.owner].gdp*.0001));a.id=`native-spy-${++n.sequence}`;
  }
  for(const notice of result.notices) {
    if(notice.kind==='discovered')note(`Контрразведка обнаружила агента ${notice.owner}. Решите: выслать или перевербовать.`);
    if(notice.kind==='suspected')note(`Сведения агента в ${notice.target} вызывают подозрения. Рассмотрите отзыв.`);
    if(notice.kind==='exposed') {
      const a=n.spies.find(a=>a.id===notice.spyId); if(a) {
        for(const [left,right]of[[a.owner,a.target],[a.target,a.owner]])s.countries[left].relations[right]=Math.max(-100,(s.countries[left].relations[right]||0)-10);
        if(a.owner===s.player)note(`Агент в ${a.target} раскрыт и выслан. Отношения −10.`);
      }
    }
  }
  for(const a of n.spies.filter(live)) {
    if(a.target===s.player&&a.status==='turned'&&draw(`${round}:${a.id}:foreign-suspicion`)<suspicionChance(n.intelligence[a.owner],n.intelligence[s.player])) {
      n.spies=recallSpy(n,a.id);delete n.knowledge[a.owner];note(`Канал двойного агента ${a.owner} прекратил работу. Противник мог обнаружить дезинформацию.`);continue;
    }
    if(a.owner===s.player) {
      const confidence=Math.round(signalClarity(n.intelligence[s.player],n.intelligence[a.target])*100);
      const noise=Math.round((draw(`${round}:${a.id}:report`)-.5)*(100-confidence));
      const base=a.status==='turned'?100-s.countries[a.target].readiness:s.countries[a.target].readiness;
      const estimate=Math.max(0,Math.min(100,base+noise));
      s.reports.push({date,target:a.target,confidence,text:`Агентурная оценка боеготовности: около ${estimate}/100; качество сигнала ${confidence} %. Это оценка, источник может ошибаться или передавать дезинформацию.${a.suspected?' Есть подозрение на перевербовку.':''}`});
    } else if(a.target===s.player) {
      // Foreign AI only reacts to its imperfect observation, not omniscience.
      const estimate=a.status==='turned'?(a.coverStory==='Слабая оборона'?20:80):Math.max(0,Math.min(100,s.countries[s.player].readiness+Math.round((draw(`${round}:${a.id}:foreign`)-.5)*30)));
      n.knowledge[a.owner]={date,estimate};
    }
  }
  const active=n.spies.filter(a=>live(a)||a.status==='discovered'), finished=n.spies.filter(a=>!live(a)&&a.status!=='discovered');
  n.spies=[...finished.slice(-Math.max(0,200-active.length)),...active];s.reports=s.reports.slice(-200);
}
/** @param {Strategy} s @param {string} date @param {(text:string,country?:string)=>void} note */
export function intelligenceNPC(s,date,note) {
  const n=s.spycraft;if(!n)return;
  for(const [id,k]of Object.entries(n.knowledge)) {
    if(id===s.player||(diffGameDays(k.date,date)||0)>30)continue;
    const c=s.countries[id],cost=Math.max(10,Math.round(c.gdp*.0002));
    if((c.relations[s.player]||0)<-20&&k.estimate>c.readiness+10&&c.treasury>=cost) {
      c.treasury-=cost;c.readiness=Math.min(100,c.readiness+3);note(`${id}: по оценке угрозы выделено ${cost} млн € на подготовку сил.`,id);
    }
  }
}
