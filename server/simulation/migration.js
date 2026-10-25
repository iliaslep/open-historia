// @ts-check
// Population is a conserved stock. Parameters and starting populations are GAME
// ESTIMATES derived from GDP, not demographic statistics for the scenario date.
import { addGameDays, normalizeGameDate } from '../gameDates.js';
/** @typedef {{population:number,waiting:number,refugees:number,housing:number,quota:number,fund:number,net:number,arrivals:number,departures:number,integrated:number,policy?:{value:number,due:string},building?:string}} Society */
/** @typedef {{version:1,countries:Record<string,Society>,flows:Array<{date:string,from:string,to:string,people:number,refugees:number}>,spent:number}} Migration */
/** @typedef {import('./strategy.js').Strategy} Strategy */
/** @param {Strategy} s @returns {Migration} */
export function createMigration(s) {
  return { version: 1, countries: Object.fromEntries(Object.entries(s.countries).map(([id,c]) => {
    const population = Math.max(100000, c.gdp * 25);
    return [id, { population, waiting:0, refugees:0, housing:Math.round(population * .005), quota:Math.round(population * .001), fund:0, net:0, arrivals:0, departures:0, integrated:0 }];
  })), flows:[], spent:0 };
}
/** @param {Migration} m @param {Strategy} s @param {string} at */
export function validateMigration(m, s, at) {
  const int = (/** @type {number} */ x, min=0, max=1e12) => Number.isSafeInteger(x) && x>=min && x<=max;
  const date = (/** @type {string} */ x) => typeof x==='string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(x) && normalizeGameDate(x)===x;
  if (!m || m.version!==1 || !m.countries || Array.isArray(m.countries) || Object.keys(m.countries).length!==Object.keys(s.countries).length
    || !int(m.spent) || !Array.isArray(m.flows) || m.flows.length>200) throw new Error('Повреждена модель миграции.');
  for (const id of Object.keys(s.countries)) {
    const c=m.countries[id];
    if (!c || [c.population,c.waiting,c.refugees,c.housing,c.quota,c.fund,c.arrivals,c.departures,c.integrated].some(x=>!int(x))
      || !int(c.net,-1e12) || c.waiting>c.population || c.refugees>c.waiting || c.waiting>c.housing || c.quota>1000000
      || (c.policy!==undefined && (!int(c.policy.value,0,1000000) || !date(c.policy.due) || (at && c.policy.due<=at)))
      || (c.building!==undefined && (!date(c.building) || (at && c.building<=at)))) throw new Error('Повреждены население или миграционная политика.');
  }
  for (const f of m.flows) if (!f || !date(f.date) || (at && f.date>at) || f.from===f.to || !s.countries[f.from] || !s.countries[f.to]
    || !int(f.people,1) || !int(f.refugees) || f.refugees>f.people) throw new Error('Повреждён миграционный поток.');
}
/** @param {Strategy} s @param {string} type @param {number} value @param {string} date @param {(money:number,capital?:number)=>void} spend */
export function migrationDecision(s,type,value,date,spend) {
  if (type==='migration_enable') { if(s.migration) throw new Error('Модель населения уже включена.'); s.migration=createMigration(s); return 'Включена модель населения: стартовые числа — игровые оценки; прежняя история сохранена.'; }
  if (!s.migration) throw new Error('Сначала включите модель населения в этой партии.');
  const c=s.migration.countries[s.player];
  if (type==='migration_quota') {
    if(!Number.isSafeInteger(value)||value<0||value>1000000) throw new Error('Квота: от 0 до 1 000 000 человек в месяц.');
    if(c.policy) throw new Error('Изменение квоты уже рассматривается.');
    spend(0,5); c.policy={value,due:addGameDays(date,7)};
    return `Квота приёма ${value} чел./месяц рассматривается 7 дней. Закрытие приёма не высылает жителей.`;
  }
  if(type==='migration_fund') {
    if(!Number.isSafeInteger(value)||value<1||value>1000000) throw new Error('Взнос в интеграционный фонд: 1–1 000 000 млн €.');
    spend(value,2); c.fund+=value;
    return `В интеграционный фонд перечислено ${value} млн €. Средства зарезервированы; интеграция стоит 2 000 € за человека.`;
  }
  if(type==='migration_housing') {
    if(c.building) throw new Error('Центр приёма уже строится.');
    const cost=Math.max(20,Math.round(s.countries[s.player].gdp*.0002)); spend(cost,5); c.building=addGameDays(date,30);
    return `Начато строительство 10 000 мест приёма: ${cost} млн €, 30 дней. Места освобождаются после интеграции.`;
  }
  throw new Error('Неизвестная миграционная мера.');
}
/** @param {Strategy} s @param {string} from @param {string} to */
export function migrationRoute(s,from,to) {
  return s.treaties.some(t=>(t.a===from&&t.b===to)||(t.a===to&&t.b===from))
    || Object.values(s.regions||{}).some(r=>r.owner===from&&r.neighbors.some(n=>s.regions?.[n]?.owner===to));
}
/** @param {Strategy} s @param {string} date @param {(text:string,country?:string)=>void} note */
export function advanceMigration(s,date,note) {
  const m=s.migration; if(!m)return;
  const ids=Object.keys(m.countries).sort();
  for(const id of ids) {
    const c=m.countries[id];
    if(c.policy?.due===date) { c.quota=c.policy.value; delete c.policy; note(`${id}: вступила в силу квота приёма ${c.quota} чел./месяц.`,id); }
    if(c.building===date) { c.housing+=10000; delete c.building; note(`${id}: открыто 10 000 мест приёма.`,id); }
  }
  if(!date.endsWith('-01'))return;
  // Integrate last month's arrivals; an escrow debit is an actual expenditure.
  for(const id of ids) {
    const c=m.countries[id], economy=s.countries[id];
    c.net=0;c.arrivals=0;c.departures=0;c.integrated=0;
    if(id!==s.player && c.fund<20 && economy.treasury>economy.gdp*.02) {
      const grant=Math.min(economy.treasury,Math.max(1,Math.round(economy.gdp*.0001)));
      economy.treasury-=grant; c.fund+=grant;
    }
    const people=Math.min(c.waiting,c.fund*500);
    if(people) {
      const cost=Math.ceil(people/500); c.fund-=cost; m.spent+=cost;
      c.refugees-=Math.min(c.refugees,people);c.waiting-=people;c.integrated=people;
      // Existing GDP expands only after funded integration, at half the current
      // output per resident; arrivals do not create cash or instant GDP.
      economy.gdp+=Math.floor(economy.gdp/c.population*people*.5);
      if(people>=1000) economy.unemployment=Math.max(1,economy.unemployment-1);
    }
    if(c.waiting>c.housing*.8 && c.waiting>0) economy.stability=Math.max(0,economy.stability-1);
  }
  const snapshot=structuredClone(m.countries);
  const remaining=Object.fromEntries(ids.map(id=>[id,Math.max(0,Math.min(snapshot[id].quota,snapshot[id].housing-snapshot[id].waiting))]));
  const residents=Object.fromEntries(ids.map(id=>[id,snapshot[id].population-snapshot[id].waiting]));
  const war=(/** @type {string} */ id)=>s.wars.some(w=>w.a===id||w.b===id);
  const score=(/** @type {string} */ id)=>s.countries[id].stability-s.countries[id].unemployment*2+Math.round(Math.log2(s.countries[id].gdp*1000000/snapshot[id].population/40000)*10)+(war(id)?-70:0);
  for(const from of ids) {
    // At most 0.1% of established residents leave per month; only pressure
    // differences create a flow. A direct war frontier is never a safe route.
    let supply=Math.floor(residents[from]*(war(from)?.001:.0002));
    const destinations=ids.filter(to=>to!==from&&!war(to)&&score(to)>score(from)+10&&migrationRoute(s,from,to))
      .sort((a,b)=>score(b)-score(a)||a.localeCompare(b));
    for(const to of destinations) {
      const people=Math.min(supply,remaining[to]); if(!people)continue;
      const refugees=war(from)?people:0;
      const lostOutput=Math.floor(s.countries[from].gdp/snapshot[from].population*people*.5);
      s.countries[from].gdp=Math.max(1,s.countries[from].gdp-lostOutput);
      m.countries[from].population-=people;m.countries[from].net-=people;m.countries[from].departures+=people;
      m.countries[to].population+=people;m.countries[to].waiting+=people;m.countries[to].refugees+=refugees;
      m.countries[to].net+=people;m.countries[to].arrivals+=people;
      remaining[to]-=people;supply-=people;
      m.flows.push({date,from,to,people,refugees});
      if(from===s.player||to===s.player) note(`${from} → ${to}: ${people} переселенцев${refugees?' (беженцы)':''}. Нужны места и средства на интеграцию.`);
    }
  }
  m.flows=m.flows.slice(-200);
}
