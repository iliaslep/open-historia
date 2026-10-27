import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrategy,strategyDecision,advanceStrategy,validateStrategy } from './simulation/strategy.js';
import { createRandomState } from './simulation/random.js';
import { storyMemory } from './simulation/story.js';
import { applyNewspaper,newspaperContext } from './simulation/newspaper.js';
import { addGameDays } from './gameDates.js';
const at='2016-12-08';
const initial=()=>createStrategy({polityOverrides:{Germany:{},France:{},Russia:{}}},'Germany');
const plan=(rest={})=>({type:'initiative',title:'Новая форма государственного устройства',description:'Созвать общественный конгресс для обсуждения конституционного проекта, подготовить текст и выслушать возражения.',budget:1000,days:7,focus:'governance',difficulty:'ambitious',visibility:'public',...rest});

test('free initiatives accept unenumerated goals, pay real resources, survive JSON and resolve after a real deadline',()=>{
  for(const title of ['Космическое агентство','Новая конституция','Конгресс по океанам','Реформа школьной программы','Культурная столица']) {
    const s=initial(),before=structuredClone(s),next=strategyDecision(s,plan({title}),at);
    assert.deepEqual(s,before);assert.equal(next.countries.Germany.treasury,s.countries.Germany.treasury-1000);
    assert.equal(next.countries.Germany.capital,s.countries.Germany.capital-8);
    assert.equal(next.story.initiatives[0].status,'active');
    const six=advanceStrategy(next,at,'2016-12-14',createRandomState(7)).strategy;
    assert.equal(six.story.initiatives[0].status,'active');
    const seven=advanceStrategy(JSON.parse(JSON.stringify(next)),at,'2016-12-15',createRandomState(7)).strategy;
    assert.notEqual(seven.story.initiatives[0].status,'active');assert.ok(seven.story.facts.some(f=>f.title===title));
    assert.ok(seven.story.news.some(n=>n.initiativeId==='initiative-1'));
  }
});

test('funds, scale and sovereignty restrict consequences rather than a whitelist of ideas',()=>{
  const s=initial(),before=structuredClone(s);
  for(const action of [plan({budget:1000000}),plan({budget:0}),plan({days:1}),plan({target:'Atlantis'}),plan({world:{treasury:1e9}})])assert.throws(()=>strategyDecision(s,action,at));
  assert.deepEqual(s,before);
  const accepted=strategyDecision(s,plan(),at);
  assert.throws(()=>strategyDecision(accepted,plan(),at),/уже/);
  const diplomatic=strategyDecision(s,plan({target:'France',focus:'diplomacy'}),at);
  assert.deepEqual(diplomatic.countries.France,s.countries.France);
  assert.deepEqual(diplomatic.regions,s.regions);
});

test('news and initiative results are identical for batched and daily simulation after reload',()=>{
  const s=strategyDecision(initial(),plan(),at),bulk=advanceStrategy(s,at,'2017-01-08',createRandomState(42));
  let state=s,rng=createRandomState(42);
  for(let d=1;d<=31;d++){const next=advanceStrategy(JSON.parse(JSON.stringify(state)),addGameDays(at,d-1),addGameDays(at,d),rng);state=next.strategy;rng=next.rng;}
  assert.deepEqual(state,bulk.strategy);assert.deepEqual(rng,bulk.rng);
});

test('private initiatives never reach newspapers or a foreign delegation public memory',()=>{
  const s=strategyDecision(initial(),plan({title:'Секретный протокол СИРИУС',visibility:'private'}),at);
  const next=advanceStrategy(s,at,'2016-12-15',createRandomState(7)).strategy;
  assert.ok(storyMemory(next).facts.some(f=>f.title.includes('СИРИУС')));
  assert.equal(JSON.stringify(storyMemory(next,true)).includes('СИРИУС'),false);
  assert.equal(JSON.stringify(newspaperContext(next,at,'2016-12-15')).includes('СИРИУС'),false);
  assert.equal(next.story.news.some(n=>n.body.includes('СИРИУС')),false);
});

test('AI newspaper edits existing events and autonomous NPC events debit the NPC only once',()=>{
  const s=advanceStrategy(initial(),at,'2016-12-09',createRandomState(7)).strategy;
  const before=structuredClone(s),id=s.story.news[0].id;
  applyNewspaper(s,{articles:[{id,title:'Правительства определяют приоритеты',body:'Кабинеты продолжают исполнение утверждённых программ.'}],worldEvents:[{country:'France',title:'Франция готовит исследовательский консорциум',body:'Правительство оплатило подготовительный этап научного сотрудничества.',focus:'science',direction:'advance'}]},at,'2016-12-09');
  assert.equal(s.countries.France.treasury,before.countries.France.treasury-440);
  assert.equal(s.countries.France.industry,before.countries.France.industry+1);
  assert.deepEqual(s.countries.Germany,before.countries.Germany);
  assert.equal(s.story.news[0].source,'ai');assert.equal(s.story.facts.at(-1).country,'France');
  validateStrategy(s,'2016-12-09');
  for(const response of [{articles:[{id:'future',title:'x',body:'x'}],worldEvents:[]},{articles:[],worldEvents:[{country:'Germany',title:'x',body:'x',focus:'science',direction:'advance'}]},{articles:[],worldEvents:[{country:'France',title:'x',body:'x',focus:'science',direction:'advance',treasury:1e9}]}])assert.throws(()=>applyNewspaper(structuredClone(s),response,at,'2016-12-09'));
  const poor=structuredClone(before);poor.countries.France.treasury=0;
  assert.throws(()=>applyNewspaper(poor,{articles:[],worldEvents:[{country:'France',title:'x',body:'x',focus:'science',direction:'advance'}]},at,'2016-12-09'),/ресурс/);
});

test('future/malformed imported stories fail closed, archive stays bounded and old saves remain readable',()=>{
  const s=strategyDecision(initial(),plan(),at);
  for(const corrupt of [x=>x.story.version=2,x=>x.story.initiatives[0].due=at,x=>x.story.initiatives[0].budget=-1,x=>x.story.initiatives[0].owner='France',x=>x.story.news.push({id:'x',date:'9999-01-01'})]) {const bad=structuredClone(s);corrupt(bad);assert.throws(()=>validateStrategy(bad,at));}
  const next=advanceStrategy(s,at,'2018-12-08',createRandomState(7)).strategy;
  assert.equal(next.story.news.length,180);assert.ok(next.story.facts.length<=120);
  const old=initial();delete old.story;assert.ok(validateStrategy(old,at));
});

test('narrated initiative developments enter lasting memory for later decisions and newspaper turns',()=>{
  let s=strategyDecision(initial(),plan(),at);s=advanceStrategy(s,at,'2016-12-15',createRandomState(7)).strategy;
  const article=s.story.news.find(n=>n.initiativeId),detail='Парламент запросил дополнительную экспертизу проекта у общественного конгресса.';
  applyNewspaper(s,{articles:[{id:article.id,title:'Обсуждение проекта продолжается',body:detail}],worldEvents:[]},at,'2016-12-15');
  assert.ok(storyMemory(s).facts.some(f=>f.text.includes(detail)));
  assert.ok(newspaperContext(s,'2016-12-15','2016-12-22').facts.some(f=>f.text.includes(detail)));
  assert.ok(s.story.initiatives[0].result.includes(detail));
});
