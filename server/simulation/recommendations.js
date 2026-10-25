// @ts-check
// Offline advisors propose options. Preview and execution use the same engine.
import { dailyBudget, strategyDecision } from './strategy.js';
/** @param {import('./strategy.js').Strategy} s @param {string} date */
export function recommendDecisions(s,date) {
  const c=s.countries[s.player],m=s.migration?.countries[s.player];
  /** @type {Array<{title:string,reason:string,risk:string,action:{type:string,value?:number},cost?:{treasury:number,capital:number},description?:string,error?:string}>} */
  const options=[];
  if(dailyBudget(c,s.wars.some(w=>w.a===s.player||w.b===s.player)).balance<0) options.push({title:'Сократить дефицит',reason:'Текущие расходы требуют резервов или заимствований.',risk:'Повышение налогов может снизить рост и стабильность; рассмотрение занимает 7 дней.',action:{type:'tax',value:Math.min(60,Math.ceil(c.tax/100)+2)}});
  if(m) {
    if(m.fund<Math.ceil(Math.max(m.waiting,m.quota)/500)) options.push({title:'Профинансировать интеграцию',reason:`Ожидают интеграции: ${m.waiting}; квота: ${m.quota} человек/месяц.`,risk:'Деньги уходят из свободной казны в целевой фонд. Прибывшие интегрируются со следующего месяца.',action:{type:'migration_fund',value:Math.max(1,Math.min(1000000,Math.ceil(Math.max(m.waiting,m.quota)/500)-m.fund))}});
    if(m.waiting+m.quota>m.housing)options.push({title:'Расширить места приёма',reason:'Квота и ожидающие могут превысить доступные места.',risk:'Строительство занимает 30 дней; до завершения приём ограничен вместимостью.',action:{type:'migration_housing'}});
  }
  if(c.industry<80)options.push({title:'Модернизировать промышленность',reason:'Развитие промышленности улучшает потенциал роста.',risk:'Расход 0,5 % годового ВВП; результат через 30 дней, свободные резервы сократятся.',action:{type:'industry'}});
  if(s.spycraft&&s.spycraft.intelligence[s.player]<70)options.push({title:'Усилить контрразведку',reason:'Служба повышает шанс обнаружить иностранных агентов и качество своих оценок.',risk:'Подготовка 14 дней. Улучшение снижает риски, но не гарантирует достоверность.',action:{type:'spy_upgrade'}});
  if(c.readiness<55)options.push({title:'Подготовить резервы',reason:'Боеготовность недостаточна для крупной операции.',risk:'Расход 0,5 % ВВП и 14 дней подготовки; повышенная готовность сама не разрешает войну.',action:{type:'mobilize'}});
  return options.slice(0,5).map(option=>{
    try {
      const next=strategyDecision(s,option.action,date);
      return {...option,cost:{treasury:c.treasury-next.countries[s.player].treasury,capital:c.capital-next.countries[s.player].capital},description:next.history.at(-1)?.text};
    } catch(error) {return {...option,error:error instanceof Error?error.message:'Недоступно по правилам.'};}
  });
}
