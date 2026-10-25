// @ts-check
// Deterministic strategy rules. All monetary quantities are integer million EUR;
// starting values and coefficients are GAME ESTIMATES, not historical statistics.
import { addGameDays, diffGameDays, normalizeGameDate } from '../gameDates.js';
import { drawRandom } from './random.js';
import { buildStrategyGeography } from './geography.js';

/** @typedef {{gdp:number, treasury:number, debt:number, tax:number, spending:number, stability:number, readiness:number, industry:number, energy:number, unemployment:number, capital:number, relations:Record<string,number>}} Country */
/** @typedef {{owner:string, kind:'tax'|'spending'|'industry'|'mobilize', value?:number, due:string}} Project */
/** @typedef {{version:1, dataKind:'game-estimate', player:string, countries:Record<string,Country>, regions?:Record<string,import('./geography.js').Region>, history:Array<{date:string,text:string,country:string}>, projects:Project[], treaties:Array<{a:string,b:string,until:string}>, reports:Array<{date:string,target:string,confidence:number,text:string}>, intel:Array<{owner:string,target:string,due:string}>, wars:Array<{a:string,b:string,since:string}>}} Strategy */
/** @param {number} x @param {number} low @param {number} high */
const clamp = (x, low, high) => Math.max(low, Math.min(high, x));
/** @template T @param {T} value @returns {T} */
const copy = (value) => structuredClone(value);
/** @type {Record<string,number>} */
const baseGdp = { Germany: 3200000, France: 2200000, 'United Kingdom': 2400000, 'United States': 17000000, China: 10000000, Russia: 1200000, Japan: 4500000, India: 2000000, Italy: 1700000, Spain: 1100000 };
/** @param {unknown} x */
const object = (x) => x && typeof x === 'object' && !Array.isArray(x);
/** @param {unknown} x @param {number} min @param {number} max */
const integer = (x, min, max) => typeof x === 'number' && Number.isSafeInteger(x) && x >= min && x <= max;
/** @param {unknown} x */
const dateValue = (x) => typeof x === 'string' && /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(x) && normalizeGameDate(x) === x;

/** @param {unknown} input @param {string} [at] @returns {Strategy} */
export function validateStrategy(input, at = '') {
  const raw = /** @type {Strategy} */ (input);
  if (!object(raw) || raw.version !== 1 || raw.dataKind !== 'game-estimate' || !object(raw.countries)
    || !Array.isArray(raw.history) || !Array.isArray(raw.projects) || !Array.isArray(raw.treaties)
    || !Array.isArray(raw.reports) || !Array.isArray(raw.wars) || !Array.isArray(raw.intel)) throw new Error('Повреждено состояние стратегии.');
  const entries = Object.entries(raw.countries);
  if (!entries.length || entries.length > 1000 || !Object.hasOwn(raw.countries, raw.player)) throw new Error('Неизвестное государство игрока.');
  for (const [, country] of entries) {
    for (const key of /** @type {const} */ (['gdp', 'treasury', 'debt'])) if (!integer(country[key], 0, 1e12)) throw new Error(`Некорректный баланс: ${key}`);
    if (!country.gdp || !integer(country.tax, 2000, 6000) || !integer(country.spending, 2000, 6000)) throw new Error('Некорректная бюджетная политика.');
    for (const key of /** @type {const} */ (['stability', 'readiness', 'industry', 'energy', 'unemployment', 'capital'])) {
      if (!integer(country[key], 0, 100)) throw new Error(`Некорректный показатель: ${key}`);
    }
    if (!object(country.relations) || Object.entries(country.relations).some(([id, x]) => !Object.hasOwn(raw.countries, id) || !integer(x, -100, 100))) throw new Error('Повреждены отношения.');
  }
  for (const list of [raw.projects, raw.intel]) for (const item of list) {
    if (!object(item) || !Object.hasOwn(raw.countries, item.owner) || !dateValue(item.due) || (at && item.due <= at)) throw new Error('Повреждён процесс.');
  }
  if (raw.projects.length > entries.length * 4 || raw.intel.length > entries.length ** 2 || raw.treaties.length > 2000 || raw.wars.length > 2000) throw new Error('Превышен предел процессов.');
  const pending = new Set();
  for (const project of raw.projects) {
    const key = `${project.owner}|${project.kind}`;
    if (pending.has(key) || !['tax', 'spending', 'industry', 'mobilize'].includes(project.kind)
      || (['tax', 'spending'].includes(project.kind) && !integer(project.value, 2000, 6000))) throw new Error('Повреждена реформа или проект.');
    pending.add(key);
  }
  for (const op of raw.intel) if (!Object.hasOwn(raw.countries, op.target) || op.target === op.owner) throw new Error('Повреждена разведывательная операция.');
  if ([raw.history, raw.reports].some((list) => list.length > 200)) throw new Error('Слишком большой журнал.');
  for (const item of [...raw.treaties, ...raw.wars]) if (!Object.hasOwn(raw.countries, item.a) || !Object.hasOwn(raw.countries, item.b) || item.a === item.b) throw new Error('Повреждены участники соглашения/конфликта.');
  for (const treaty of raw.treaties) if (!dateValue(treaty.until) || (at && treaty.until <= at)) throw new Error('Повреждён срок договора.');
  for (const war of raw.wars) if (!dateValue(war.since) || (at && war.since > at)) throw new Error('Повреждена дата конфликта.');
  for (const entry of raw.history) if (!object(entry) || !dateValue(entry.date) || typeof entry.text !== 'string' || entry.text.length > 20000 || !Object.hasOwn(raw.countries, entry.country) || (at && entry.date > at)) throw new Error('Повреждён журнал.');
  for (const report of raw.reports) if (!object(report) || !dateValue(report.date) || typeof report.text !== 'string' || !integer(report.confidence, 0, 100) || !Object.hasOwn(raw.countries, report.target) || (at && report.date > at)) throw new Error('Повреждён отчёт.');
  const regions = raw.regions || {};
  for (const [id, region] of Object.entries(regions)) {
    if (!object(region) || !Object.hasOwn(raw.countries, region.owner) || !Object.hasOwn(raw.countries, region.sovereign)
      || typeof region.name !== 'string' || !Array.isArray(region.neighbors)
      || region.neighbors.some((other) => other === id || !Object.hasOwn(regions, other)
        || !Array.isArray(regions[other].neighbors) || !regions[other].neighbors.includes(id))) throw new Error('Повреждена география стратегии.');
  }
  return copy(raw);
}

/** @param {Strategy} s @param {string} date @param {string} text @param {string} [country] */
const note = (s, date, text, country = s.player) => {
  s.history.push({ date, text, country });
  s.history = s.history.slice(-200);
};
/** @param {Strategy} s @param {string} a @param {string} b @param {number} delta */
const relation = (s, a, b, delta) => {
  for (const [left, right] of [[a, b], [b, a]]) s.countries[left].relations[right] = clamp((s.countries[left].relations[right] || 0) + delta, -100, 100);
};
/** @param {Strategy} s @param {string} a @param {string} b */
const atWar = (s, a, b) => s.wars.some((w) => (w.a === a && w.b === b) || (w.a === b && w.b === a));

/** @param {Record<string,unknown>} world @param {string} player @param {unknown} [geometry] @returns {Strategy} */
export function createStrategy(world, player, geometry) {
  const regions = buildStrategyGeography(geometry, world);
  const names = [...new Set([player, ...Object.keys(world.polityOverrides || {}), ...Object.values(world.regionOwnershipOverrides || {}), ...Object.values(regions).flatMap((r) => [r.owner, r.sovereign])])].filter((x) => typeof x === 'string' && x.trim()).sort();
  const countries = Object.fromEntries(names.map((name) => {
    const gdp = baseGdp[name] || 100000;
    return [name, { gdp, treasury: Math.round(gdp * 0.04), debt: Math.round(gdp * 0.6), tax: 3800, spending: 3500,
      stability: 65, readiness: 45, industry: 50, energy: 60, unemployment: 7, capital: 60, relations: {} }];
  }));
  return validateStrategy({ version: 1, dataKind: 'game-estimate', player, countries, regions, history: [], projects: [], treaties: [], reports: [], intel: [], wars: [] });
}

/** @param {Country} c @param {boolean} [war] */
export function dailyBudget(c, war = false) {
  const revenue = Math.round(c.gdp * c.tax / 10000 / 365);
  const services = Math.round(c.gdp * c.spending / 10000 / 365);
  const interest = Math.round(c.debt * 0.03 / 365);
  const military = war ? Math.round(c.gdp * 0.03 / 365) : 0;
  return { revenue, services, interest, military, balance: revenue - services - interest - military };
}

/** @param {unknown} raw @param {Record<string,unknown>} request @param {string} date @returns {Strategy} */
export function strategyDecision(raw, request, date) {
  const s = validateStrategy(raw, date);
  const c = s.countries[s.player];
  const { type } = request;
  const target = typeof request.target === 'string' ? request.target : '';
  const value = typeof request.value === 'number' ? request.value : NaN;
  /** @param {number} money @param {number} [capital] */
  const spend = (money, capital = 5) => {
    if (!integer(money, 0, 1e12) || c.treasury < money) throw new Error('Недостаточно средств в казне.');
    if (c.capital < capital) throw new Error('Недостаточно политической поддержки.');
    c.treasury -= money; c.capital -= capital;
  };
  const counterpart = () => {
    if (!Object.hasOwn(s.countries, target) || target === s.player) throw new Error('Выберите другое государство.');
    return s.countries[target];
  };
  if (type === 'tax' || type === 'spending') {
    if (!integer(value, 20, 60)) throw new Error('Допустимый диапазон: 20–60 % ВВП.');
    if (s.projects.some((p) => p.owner === s.player && p.kind === type)) throw new Error('Предыдущая реформа ещё рассматривается.');
    spend(0, 10);
    if (c.stability < 35) throw new Error('Парламент не поддерживает реформу при текущей нестабильности.');
    s.projects.push({ owner: s.player, kind: type, value: value * 100, due: addGameDays(date, 7) });
    note(s, date, `Правительство внесло ${type === 'tax' ? 'налоговую' : 'бюджетную'} реформу: ${value} %. Рассмотрение — 7 дней.`);
  } else if (type === 'industry' || type === 'mobilize') {
    if (s.projects.some((p) => p.owner === s.player && p.kind === type)) throw new Error('Такой проект уже выполняется.');
    const cost = Math.round(c.gdp * 0.005);
    spend(cost, 8);
    s.projects.push({ owner: s.player, kind: type, due: addGameDays(date, type === 'industry' ? 30 : 14) });
    note(s, date, `${type === 'industry' ? 'Инфраструктурный проект' : 'Подготовка резервов'}: выделено ${cost} млн €, результат ожидается ${s.projects[s.projects.length - 1].due}.`);
  } else if (type === 'aid') {
    const other = counterpart();
    if (!integer(value, 1, 1000000)) throw new Error('Размер помощи: целое число от 1 до 1 000 000 млн €.');
    spend(value, 3); other.treasury += value;
    relation(s, s.player, target, 5);
    note(s, date, `${target}: перечислена помощь ${value} млн €. Средства зачислены получателю.`);
  } else if (type === 'trade') {
    counterpart();
    if (atWar(s, s.player, target)) throw new Error('Для торговли сначала необходимо прекратить войну.');
    if (s.treaties.some((t) => (t.a === s.player && t.b === target) || (t.b === s.player && t.a === target))) throw new Error('Торговый договор уже действует.');
    spend(0, 5);
    const trust = c.relations[target] || 0;
    if (trust < -10) note(s, date, `${target} отклонило торговое предложение из-за низкого доверия. Сначала улучшите отношения.`);
    else {
      s.treaties.push({ a: s.player, b: target, until: addGameDays(date, 365) });
      relation(s, s.player, target, 5);
      note(s, date, `${target} приняло торговое предложение. Договор действует 365 дней и улучшает рост обеих экономик.`);
    }
  } else if (type === 'sanctions') {
    counterpart(); spend(Math.round(c.gdp * 0.001), 8);
    s.treaties = s.treaties.filter((t) => !((t.a === s.player && t.b === target) || (t.b === s.player && t.a === target)));
    relation(s, s.player, target, -20);
    s.countries[target].energy = clamp(s.countries[target].energy - 5, 0, 100);
    c.industry = clamp(c.industry - 2, 0, 100);
    note(s, date, `Введены санкции против ${target}: торговый договор расторгнут, энергетическая доступность адресата снизилась; отечественная промышленность понесла издержки.`);
  } else if (type === 'intel') {
    counterpart();
    if (s.intel.some((x) => x.owner === s.player && x.target === target)) throw new Error('Операция уже проводится.');
    spend(Math.max(10, Math.round(c.gdp * 0.0001)), 3);
    s.intel.push({ owner: s.player, target, due: addGameDays(date, 7) });
    note(s, date, `Начат сбор сведений о ${target}. Срок — 7 дней; информация может оказаться неполной.`);
  } else if (type === 'war') {
    counterpart();
    if (atWar(s, s.player, target)) throw new Error('Конфликт уже идёт.');
    if (c.readiness < 55 || c.stability < 45) throw new Error('Для военной операции нужны боеготовность 55 и стабильность 45.');
    if ((c.relations[target] || 0) > -20) throw new Error('Институты не поддерживают войну без серьёзного дипломатического кризиса (отношения ≤ −20).');
    spend(Math.round(c.gdp * 0.01), 25);
    s.wars.push({ a: s.player, b: target, since: date });
    relation(s, s.player, target, -40);
    note(s, date, `Начался конфликт с ${target}. Возросли ежедневные расходы; снабжение и боеготовность определяют способность продолжать его.`);
  } else if (type === 'peace') {
    counterpart();
    if (!atWar(s, s.player, target)) throw new Error('Активного конфликта нет.');
    spend(0, 5);
    s.wars = s.wars.filter((w) => !((w.a === s.player && w.b === target) || (w.b === s.player && w.a === target)));
    relation(s, s.player, target, 15);
    note(s, date, `С ${target} заключено перемирие без изменения границ. Дополнительные военные расходы прекращаются.`);
  } else throw new Error('Неизвестное действие.');
  return validateStrategy(s, date);
}

/** @param {unknown} raw @param {string} from @param {string} to @param {import('./random.js').RandomState} rng */
export function advanceStrategy(raw, from, to, rng) {
  const s = validateStrategy(raw, from);
  let random = rng;
  const roll = () => { const draw = drawRandom(random); random = draw.rng; return draw.value; };
  const count = diffGameDays(from, to);
  if (count === null || count < 0 || !Number.isSafeInteger(count)) throw new Error('Некорректный интервал стратегии.');
  for (let day = 1; day <= count; day++) {
    const date = addGameDays(from, day);
    for (const id of Object.keys(s.countries).sort()) {
      const c = s.countries[id];
      const budget = dailyBudget(c, s.wars.some((w) => w.a === id || w.b === id));
      if (budget.balance >= 0) c.treasury += budget.balance;
      else {
        const needed = -budget.balance;
        const cash = Math.min(c.treasury, needed); c.treasury -= cash;
        const borrowing = Math.min(needed - cash, Math.max(0, c.gdp * 2 - c.debt)); c.debt += borrowing;
        if (cash + borrowing < needed) {
          c.stability = Math.max(0, c.stability - 1);
          if (id === s.player && date.endsWith('-01')) note(s, date, 'Достигнут предел заимствований. Часть расходов не профинансирована; поддержка правительства падает.');
        }
      }
      if (date.endsWith('-01')) {
        const trade = s.treaties.filter((t) => t.a === id || t.b === id).length;
        const growthBp = clamp(120 + (c.industry - 50) * 5 + trade * 15 - Math.max(0, c.tax - 4000) / 10 - (c.energy < 40 ? 100 : 0), -1000, 1000);
        c.gdp = Math.max(1, Math.round(c.gdp * (1 + growthBp / 10000 / 12)));
        c.unemployment = clamp(c.unemployment + (growthBp > 100 ? -1 : 1), 1, 40);
        c.stability = clamp(c.stability + (c.tax > 4500 ? -2 : 1) - (c.unemployment > 15 ? 2 : 0), 0, 100);
        c.capital = clamp(c.capital + Math.floor(c.stability / 10), 0, 100);
        if (id !== s.player) {
          if (budget.balance < 0) c.tax = Math.min(6000, c.tax + 100);
          else if (c.treasury > c.gdp * 0.02 && c.industry < 90 && roll() < 0.25) {
            const cost = Math.round(c.gdp * 0.005); c.treasury -= cost; c.industry += 1;
            note(s, date, `${id} самостоятельно инвестировало ${cost} млн € в промышленность.`, id);
          }
        }
      }
    }
    for (const project of s.projects.filter((p) => p.due === date)) {
      const c = s.countries[project.owner];
      if (project.kind === 'tax' || project.kind === 'spending') c[project.kind] = /** @type {number} */ (project.value);
      if (project.kind === 'industry') c.industry = Math.min(100, c.industry + 5);
      if (project.kind === 'mobilize') c.readiness = Math.min(100, c.readiness + 15);
      note(s, date, `${project.owner}: завершено решение «${({ tax: 'налоги', spending: 'бюджет', industry: 'инфраструктура', mobilize: 'резервы' })[project.kind]}».`, project.owner);
    }
    s.projects = s.projects.filter((p) => p.due > date);
    for (const op of s.intel.filter((x) => x.due === date)) {
      const target = s.countries[op.target];
      const confidence = 55 + Math.floor(roll() * 35);
      const estimate = clamp(target.readiness + Math.round((roll() - 0.5) * 30), 0, 100);
      const discovered = roll() < 0.15;
      s.reports.push({ date, target: op.target, confidence, text: `Оценка боеготовности: около ${estimate}/100. Это разведывательная оценка, а не точное значение.` });
      if (discovered) relation(s, op.owner, op.target, -15);
      note(s, date, `Получен отчёт о ${op.target}.${discovered ? ' Операция раскрыта: отношения ухудшились.' : ''}`, op.owner);
    }
    s.intel = s.intel.filter((x) => x.due > date); s.reports = s.reports.slice(-200);
    for (const treaty of s.treaties.filter((t) => t.until === date)) note(s, date, `Истёк торговый договор ${treaty.a} — ${treaty.b}.`);
    s.treaties = s.treaties.filter((t) => t.until > date);
    for (const w of s.wars.filter((war) => (diffGameDays(war.since, date) ?? -1) % 7 === 0)) {
      for (const id of [w.a, w.b]) {
        const c = s.countries[id];
        c.readiness = Math.max(0, c.readiness - 2 - Math.floor(roll() * 4));
        c.stability = Math.max(0, c.stability - 1);
      }
      const a = s.countries[w.a], b = s.countries[w.b];
      /** @param {Country} c */
      const power = (c) => Math.max(1, c.readiness * (0.5 + c.industry / 100) * (0.3 + c.energy / 100) * (c.treasury > 0 ? 1 : 0.4));
      const winner = roll() * (power(a) + power(b)) < power(a) ? w.a : w.b;
      const loser = winner === w.a ? w.b : w.a;
      const regions = s.regions || {};
      const frontier = Object.keys(regions).sort().filter((id) => regions[id].owner === loser
        && regions[id].neighbors.some((neighbor) => regions[neighbor].owner === winner));
      if (frontier.length && s.countries[winner].readiness > 10) {
        const id = frontier[Math.floor(roll() * frontier.length)];
        regions[id].owner = winner;
        const lost = Math.max(1, Math.round(s.countries[loser].gdp * 0.002));
        s.countries[loser].gdp = Math.max(1, s.countries[loser].gdp - lost);
        s.countries[winner].gdp += Math.floor(lost / 2);
        note(s, date, `${winner} установило военный контроль над регионом ${regions[id].name}. Суверенитет не изменён; война повредила часть производства.`);
      }
      note(s, date, `Продолжается конфликт ${w.a} — ${w.b}: потери и нагрузка на снабжение снизили боеготовность сторон.`);
    }
    s.wars = s.wars.filter((w) => {
      if (s.countries[w.a].readiness > 10 && s.countries[w.b].readiness > 10) return true;
      note(s, date, `${w.a} и ${w.b} согласовали прекращение огня из-за истощения сил.`); return false;
    });
  }
  return { strategy: validateStrategy(s, to), rng: random };
}
