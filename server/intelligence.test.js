import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrategy, strategyDecision, advanceStrategy, validateStrategy } from './simulation/strategy.js';
import { intelligenceView, advanceIntelligence, intelligenceNPC } from './simulation/intelligence.js';
import { createRandomState } from './simulation/random.js';
const date='2016-12-08';
const initial=()=>createStrategy({polityOverrides:{Germany:{},France:{},Russia:{},Italy:{},Spain:{}}},'Germany');
const agent=(owner,target,status='active')=>({id:`agent-${owner}-${target}`,owner,target,deployedAt:date,status,turnedAt:status==='turned'?date:'',exposedAt:'',coverStory:'',suspected:false});

test('spy recruitment enforces real prices, capacity, deadlines, duplicate and recall rules',()=>{
  let s=initial();const before=s.countries.Germany.treasury;
  s=strategyDecision(s,{type:'spy_deploy',target:'France'},date);
  assert.equal(s.countries.Germany.treasury,before-320);assert.equal(s.spycraft.spies.length,0);
  assert.throws(()=>strategyDecision(s,{type:'spy_deploy',target:'France'},date));
  s=strategyDecision(s,{type:'spy_deploy',target:'Russia'},date);s=strategyDecision(s,{type:'spy_deploy',target:'Italy'},date);
  assert.throws(()=>strategyDecision(s,{type:'spy_deploy',target:'Spain'},date));
  const ready=advanceStrategy(s,date,'2016-12-15',createRandomState(3)).strategy;
  assert.equal(ready.spycraft.spies.filter(a=>a.owner==='Germany').length,3);assert.equal(ready.spycraft.pending.length,0);
  const recalled=strategyDecision(ready,{type:'spy_recall',target:'France'},'2016-12-15');
  assert.equal(recalled.spycraft.spies.find(a=>a.target==='France'&&a.owner==='Germany').status,'recalled');
  assert.ok(strategyDecision(recalled,{type:'spy_deploy',target:'Spain'},'2016-12-15'));
  const poor=initial();poor.countries.Germany.treasury=319;
  assert.throws(()=>strategyDecision(poor,{type:'spy_deploy',target:'France'},date),/средств/);
});

test('unpaid agents are recalled before reports; counterintelligence upgrade has a price and delay',()=>{
  let s=initial();s.spycraft.spies=[agent('Germany','France')];s.countries.Germany.treasury=0;
  advanceIntelligence(s,'2016-12-12',3,()=>{});
  assert.equal(s.spycraft.spies[0].status,'recalled');assert.equal(s.reports.length,0);
  s=initial();const before=s.countries.Germany.treasury;
  s=strategyDecision(s,{type:'spy_upgrade'},date);assert.equal(s.countries.Germany.treasury,before-640);
  assert.equal(s.spycraft.intelligence.Germany,40);
  const next=advanceStrategy(s,date,'2016-12-22',createRandomState(7)).strategy;
  assert.equal(next.spycraft.intelligence.Germany,50);assert.equal(next.spycraft.upgrade,undefined);
});

test('the player view hides undetected foreign agents and secretly turned own agents',()=>{
  const s=initial();s.spycraft.spies=[agent('Germany','France','turned'),agent('Russia','Germany'),agent('Italy','Germany','discovered')];
  const view=intelligenceView(s);
  assert.equal(view.agents[0].status,'active');assert.equal(view.agents[0].turnedAt,'');assert.equal(view.discovered.length,1);assert.equal(view.discovered[0].owner,'Italy');
  assert.equal(JSON.stringify(view).includes('Russia'),false);
  s.spycraft.spies[0].suspected=true;assert.equal(intelligenceView(s).agents[0].suspected,true);
});

test('only discovered foreign spies can be expelled or turned; deception affects funded NPC threat response',()=>{
  let s=initial();s.spycraft.spies=[agent('France','Germany')];
  assert.throws(()=>strategyDecision(s,{type:'spy_turn',target:'France',value:2},date),/Обнаруженного/);
  s.spycraft.spies[0].status='discovered';s.countries.France.relations.Germany=-50;
  const expelled=strategyDecision(s,{type:'spy_expel',target:'France'},date);
  assert.equal(expelled.spycraft.spies[0].status,'exposed');assert.equal(expelled.countries.Germany.relations.France,-10);assert.equal(expelled.countries.France.relations.Germany,-60);
  const before=s.countries.Germany.treasury;
  s=strategyDecision(s,{type:'spy_turn',target:'France',value:2},date);
  assert.equal(s.countries.Germany.treasury,before-10);
  advanceIntelligence(s,'2016-12-12',7,()=>{});assert.equal(s.spycraft.knowledge.France.estimate,80);
  const treasury=s.countries.France.treasury;
  intelligenceNPC(s,'2017-01-01',()=>{});
  assert.equal(s.countries.France.readiness,48);assert.equal(s.countries.France.treasury,treasury-440);
  const insolvent=structuredClone(s);insolvent.countries.France.treasury=0;intelligenceNPC(insolvent,'2017-01-01',()=>{});assert.equal(insolvent.countries.France.readiness,48);
  const low=structuredClone(s);low.spycraft.spies.find(a=>a.owner==='France').coverStory='Слабая оборона';
  advanceIntelligence(low,'2016-12-19',7,()=>{});assert.equal(low.spycraft.knowledge.France.estimate,20);
  const readiness=low.countries.France.readiness;intelligenceNPC(low,'2017-01-01',()=>{});assert.equal(low.countries.France.readiness,readiness);
});

test('weekly native reports use estimates, discovery is reproducible, and imported corruption is rejected',()=>{
  const s=initial();s.spycraft.spies=[agent('Germany','France'),agent('Russia','Germany')];s.spycraft.intelligence.Germany=100;s.spycraft.intelligence.Russia=0;
  const resolve=()=>{const copy=structuredClone(s);for(let i=0;i<30;i++)advanceIntelligence(copy,`2017-01-${String(i+1).padStart(2,'0')}`,7,()=>{});return copy;};
  const a=resolve(),b=resolve();assert.deepEqual(a,b);assert.ok(a.reports.length>0);
  assert.ok(a.reports.every(r=>r.text.includes('оценка')));
  assert.ok(a.spycraft.spies.some(a=>a.owner==='Russia'&&a.status==='discovered'));
  for(const corrupt of [x=>x.spycraft.intelligence.Germany=101,x=>x.spycraft.pending=[{target:'France',due:date}],x=>x.spycraft.spies=[agent('Germany','Germany')],x=>x.spycraft.spies=[agent('Germany','France'),agent('Germany','France')],x=>x.spycraft.knowledge.France={date:'9999-01-01',estimate:40}]) {
    const bad=initial();corrupt(bad);assert.throws(()=>validateStrategy(bad,date));
  }
});
