import assert from 'node:assert/strict';
import test from 'node:test';
import { createStrategy, strategyDecision, advanceStrategy, validateStrategy } from './simulation/strategy.js';
import { advanceMigration } from './simulation/migration.js';
import { createRandomState } from './simulation/random.js';
import { addGameDays } from './gameDates.js';
const date='2016-12-08';
const initial=()=> {
  const s=createStrategy({polityOverrides:{Germany:{},France:{},Russia:{}}},'Germany');
  s.regions={a:{name:'A',owner:'Germany',sovereign:'Germany',neighbors:['b']},b:{name:'B',owner:'France',sovereign:'France',neighbors:['a','c']},c:{name:'C',owner:'Russia',sovereign:'Russia',neighbors:['b']}};
  return s;
};
const sum=s=>Object.values(s.migration.countries).reduce((a,c)=>a+c.population,0);
const month=s=>{advanceMigration(s,'2017-01-01',()=>{});return validateStrategy(s,'2017-01-01');};

test('population flow follows pressure and routes, conserves every person, and cannot transit twice in a month',()=>{
  const s=initial();s.countries.France.stability=25;
  const before=structuredClone(s),next=month(s);
  assert.equal(sum(next),sum(before));
  const moved=next.migration.flows.filter(f=>f.to==='Germany').reduce((a,f)=>a+f.people,0);
  assert.ok(moved>0);
  assert.equal(next.migration.countries.Germany.population-before.migration.countries.Germany.population,moved);
  assert.equal(next.migration.countries.France.population-before.migration.countries.France.population,-next.migration.countries.France.departures);
  assert.ok(next.migration.flows.every(f=>f.from==='France'));
  assert.ok(next.migration.flows.every(f=>f.refugees===0));
  assert.ok(next.countries.France.gdp<before.countries.France.gdp);
  const noRoute=initial();noRoute.regions={};noRoute.countries.France.stability=5;
  assert.equal(month(noRoute).migration.flows.length,0);
  const trade=initial();trade.regions={};trade.countries.France.stability=5;trade.treaties=[{a:'Germany',b:'France',until:'2018-01-01'}];
  assert.ok(month(trade).migration.flows.some(f=>f.to==='Germany'));
});

test('refugees leave war for a peaceful reachable country; quotas and housing cap intake across all origins',()=>{
  const s=initial();s.wars=[{a:'France',b:'Russia',since:date}];
  s.treaties=[{a:'Germany',b:'Russia',until:'2018-01-01'}];
  s.migration.countries.France.population=100000;s.countries.France.gdp=4000;
  const c=s.migration.countries.Germany;c.quota=1000;c.housing=700;
  const before=sum(s),next=month(s);
  assert.equal(sum(next),before);assert.equal(next.migration.countries.Germany.arrivals,700);
  assert.equal(next.migration.countries.Germany.refugees,700);
  assert.equal(next.migration.countries.Germany.waiting,700);
  assert.ok(next.migration.flows.every(f=>f.to==='Germany'));
  assert.equal(new Set(next.migration.flows.map(f=>f.from)).size,2);
  const closed=initial();closed.countries.France.stability=5;closed.migration.countries.Germany.quota=0;
  assert.equal(month(closed).migration.countries.Germany.arrivals,0);
});

test('integration uses escrow, costs real cash, waits until next month, releases places and improves output',()=>{
  let s=initial();s.countries.France.stability=5;
  const treasury=s.countries.Germany.treasury;
  s=strategyDecision(s,{type:'migration_fund',value:3},date);
  assert.equal(s.countries.Germany.treasury,treasury-3);assert.equal(s.migration.countries.Germany.fund,3);
  s=month(s);const before=structuredClone(s),c=s.migration.countries.Germany;
  assert.ok(c.waiting>1500);assert.equal(c.integrated,0);assert.equal(c.fund,3);
  c.quota=0;advanceMigration(s,'2017-02-01',()=>{});
  assert.equal(c.integrated,1500);assert.equal(c.fund,0);assert.equal(s.migration.spent-before.migration.spent,3);
  assert.equal(c.waiting,before.migration.countries.Germany.waiting-1500);
  assert.equal(s.countries.Germany.treasury,treasury-3);
  assert.ok(s.countries.Germany.gdp>before.countries.Germany.gdp);assert.equal(sum(s),sum(before));
  const poor=initial();poor.countries.Germany.treasury=0;const copy=structuredClone(poor);
  assert.throws(()=>strategyDecision(poor,{type:'migration_fund',value:1},date),/средств/);assert.deepEqual(poor,copy);
});

test('migration policy and housing have real deadlines and old saves remain opt-in',()=>{
  let s=initial(),old=structuredClone(s);delete old.migration;delete old.spycraft;
  const after=advanceStrategy(old,date,'2017-02-01',createRandomState(7)).strategy;
  assert.equal(after.migration,undefined);assert.equal(after.spycraft,undefined);
  assert.deepEqual(strategyDecision(old,{type:'migration_enable'},date).countries,old.countries);
  assert.ok(strategyDecision(old,{type:'spy_enable'},date).spycraft);
  s=strategyDecision(s,{type:'migration_quota',value:1234},date);
  s=strategyDecision(s,{type:'migration_housing'},date);
  const before=structuredClone(s.migration.countries.Germany);
  assert.throws(()=>strategyDecision(s,{type:'migration_quota',value:2},date),/уже/);
  let next=advanceStrategy(s,date,addGameDays(date,6),createRandomState(7)).strategy;
  assert.equal(next.migration.countries.Germany.quota,before.quota);
  next=advanceStrategy(s,date,addGameDays(date,30),createRandomState(7)).strategy;
  assert.equal(next.migration.countries.Germany.quota,1234);assert.equal(next.migration.countries.Germany.housing,before.housing+10000);
});

test('new subsystems are reproducible for batched, daily and JSON-reloaded play; malformed imports fail',()=>{
  let s=initial();s.countries.France.stability=5;
  s=strategyDecision(s,{type:'migration_fund',value:100},date);s=strategyDecision(s,{type:'spy_deploy',target:'France'},date);
  const bulk=advanceStrategy(s,date,addGameDays(date,60),createRandomState(9));let state=s,rng=createRandomState(9);
  for(let d=1;d<=60;d++) {const next=advanceStrategy(JSON.parse(JSON.stringify(state)),addGameDays(date,d-1),addGameDays(date,d),rng);state=next.strategy;rng=next.rng;}
  assert.deepEqual(state,bulk.strategy);assert.deepEqual(rng,bulk.rng);
  for(const corrupt of [x=>x.migration.countries.Germany.population=-1,x=>x.migration.countries.Germany.refugees=1,x=>x.migration.countries.Germany.policy={value:1,due:date},x=>x.migration.countries.Germany.quota=1000001,x=>x.migration.flows.push({date,from:'France',to:'Germany',people:NaN,refugees:0})]) {
    const bad=initial();corrupt(bad);assert.throws(()=>validateStrategy(bad,date));
  }
});
