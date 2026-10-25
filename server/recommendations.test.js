import test from 'node:test';
import assert from 'node:assert/strict';
import { createStrategy, strategyDecision } from './simulation/strategy.js';
import { recommendDecisions } from './simulation/recommendations.js';
const date='2016-12-08';
test('offline recommendations do not mutate state and executable prices match actual resource debits',()=>{
  const s=createStrategy({},'Germany'),before=structuredClone(s),options=recommendDecisions(s,date);
  assert.ok(options.some(o=>o.action.type==='migration_fund'));assert.ok(options.some(o=>o.action.type==='spy_upgrade'));
  assert.deepEqual(s,before);
  for(const option of options.filter(o=>!o.error)) {
    const next=strategyDecision(s,option.action,date);
    assert.equal(before.countries.Germany.treasury-next.countries.Germany.treasury,option.cost.treasury);
    assert.equal(before.countries.Germany.capital-next.countries.Germany.capital,option.cost.capital);
  }
  s.countries.Germany.treasury=0;s.countries.Germany.capital=0;
  assert.ok(recommendDecisions(s,date).every(o=>o.error));
});
