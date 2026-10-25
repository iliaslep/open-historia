import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { prepareSimulationOperation } from './simulation/clockCommand.js';
import { advanceSimulationClock } from './simulation/time.js';
import { dailyBudget, validateStrategy } from './simulation/strategy.js';
import { buildStrategyGeography } from './simulation/geography.js';

const start = () => {
  const initial = { game: { country: 'Germany', gameDate: '2016-12-08' }, world: { polityOverrides: { Germany: {}, France: {}, Russia: {} } }, meta: { id: 'test', scenarioId: 'default' } };
  return { ...initial, ...prepareSimulationOperation(initial, 'start', { seed: 7 }, 'test') };
};
const decide = (pair, type, rest = {}) => ({ ...pair, ...prepareSimulationOperation(pair, 'decision', {
  expectedRevision: pair.world.simulation.revision, type, ...rest,
}, 'test') });
const advance = (pair, step) => ({ ...pair, ...advanceSimulationClock(pair, step) });

test('native initialization is explicit, versioned, and never overwrites an existing simulation', () => {
  const pair = start();
  assert.equal(pair.game.simulationMode, 'native');
  assert.equal(pair.world.simulation.rulesVersion, 2);
  assert.equal(pair.world.strategy.dataKind, 'game-estimate');
  assert.throws(() => prepareSimulationOperation(pair, 'start', { seed: 8 }, 'test'), (e) => e.status === 409);
});

test('budget flows balance cash, borrowing and spending, without inventing funds', () => {
  const pair = start();
  const before = pair.world.strategy.countries.Germany;
  const budget = dailyBudget(before);
  const next = advance(pair, 'day');
  assert.equal(next.world.strategy.countries.Germany.treasury, before.treasury + budget.balance);
  const deficit = structuredClone(pair);
  const c = deficit.world.strategy.countries.Germany;
  c.treasury = 0; c.tax = 2000; c.spending = 6000;
  const flow = dailyBudget(c);
  const result = advance(deficit, 'day').world.strategy.countries.Germany;
  assert.equal(result.debt - c.debt, -flow.balance);
  assert.equal(result.treasury, 0);
  const ceiling = structuredClone(deficit);
  ceiling.world.strategy.countries.Germany.debt = c.gdp * 2;
  const capped = advance(ceiling, 'day').world.strategy.countries.Germany;
  assert.equal(capped.debt, c.gdp * 2);
  assert.equal(capped.stability, c.stability - 1);
});

test('reforms consume support, wait seven days, and cannot be duplicated or passed during instability', () => {
  const pair = start();
  const proposed = decide(pair, 'tax', { value: 45 });
  assert.equal(proposed.game.gameDate, pair.game.gameDate);
  assert.equal(proposed.world.strategy.countries.Germany.tax, 3800);
  assert.equal(proposed.world.strategy.countries.Germany.capital, 50);
  assert.throws(() => decide(proposed, 'tax', { value: 50 }));
  assert.equal(advance(proposed, 'week').world.strategy.countries.Germany.tax, 4500);
  const unstable = start(); unstable.world.strategy.countries.Germany.stability = 20;
  const before = structuredClone(unstable);
  assert.throws(() => decide(unstable, 'tax', { value: 40 }));
  assert.deepEqual(unstable, before);
});

test('aid transfers exact cash to another country; rejected overspending changes nothing', () => {
  const pair = start();
  const next = decide(pair, 'aid', { target: 'France', value: 500 });
  for (const [id, difference] of [['Germany', -500], ['France', 500]]) {
    assert.equal(next.world.strategy.countries[id].treasury - pair.world.strategy.countries[id].treasury, difference);
  }
  const before = structuredClone(pair);
  assert.throws(() => decide(pair, 'aid', { target: 'France', value: 1000000 }));
  assert.deepEqual(pair, before);
});

test('trade affects both economies; sanctions end obligations and carry domestic costs', () => {
  const pair = start();
  const traded = decide(pair, 'trade', { target: 'France' });
  assert.equal(traded.world.strategy.treaties.length, 1);
  const baseline = advance(pair, 'month');
  const next = advance(traded, 'month');
  for (const id of ['Germany', 'France']) assert.ok(next.world.strategy.countries[id].gdp > baseline.world.strategy.countries[id].gdp);
  const sanctioned = decide(traded, 'sanctions', { target: 'France' });
  assert.equal(sanctioned.world.strategy.treaties.length, 0);
  assert.equal(sanctioned.world.strategy.countries.Germany.industry, 48);
  assert.equal(sanctioned.world.strategy.countries.France.energy, 55);
});

test('industry, reserves and intelligence have real costs, deadlines and reproducible results', () => {
  let pair = decide(start(), 'industry');
  pair = decide(pair, 'mobilize');
  pair = decide(pair, 'intel', { target: 'France' });
  assert.equal(advance(pair, 'week').world.strategy.reports.length, 1);
  pair = advance(advance(pair, 'week'), 'week');
  assert.equal(pair.world.strategy.countries.Germany.readiness, 60);
  assert.equal(pair.world.strategy.countries.Germany.industry, 50);
  const restored = JSON.parse(JSON.stringify(pair));
  const next = advance(pair, 'month');
  assert.deepEqual(next, advance(restored, 'month'));
  assert.equal(next.world.strategy.countries.Germany.industry, 55);
});

test('NPC policies change without LLM; batch simulation equals daily execution', () => {
  const pair = start();
  pair.world.strategy.countries.France.tax = 2000;
  pair.world.strategy.countries.France.spending = 5000;
  const monthly = advance(pair, 'month');
  let daily = pair;
  for (let i = 0; i < 31; i++) daily = advance(daily, 'day');
  assert.deepEqual(daily.world, monthly.world);
  assert.ok(monthly.world.strategy.countries.France.tax > 2000);
});

test('ten years remain finite and loadable, and journals stay bounded', () => {
  let pair = start();
  for (let month = 0; month < 120; month++) pair = advance(pair, 'month');
  assert.equal(pair.game.gameDate, '2026-12-08');
  assert.deepEqual(validateStrategy(JSON.parse(JSON.stringify(pair.world.strategy))), pair.world.strategy);
  assert.ok(pair.world.strategy.history.length <= 200);
});

const land = (id, owner, x) => ({ type: 'Feature', properties: { id, owner, name: id }, geometry: {
  type: 'Polygon', coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 1], [x, 0]]],
} });
const geometry = { type: 'FeatureCollection', features: [land('a', 'Germany', 0), land('b', 'France', 1), land('remote', 'France', 10)] };
test('territory adjacency comes from shared edges; isolated regions are not land fronts', () => {
  const regions = buildStrategyGeography(geometry, {});
  assert.deepEqual(regions.a.neighbors, ['b']);
  assert.deepEqual(regions.b.neighbors, ['a']);
  assert.deepEqual(regions.remote.neighbors, []);
});
test('battle changes one neighboring control region, preserves sovereignty and survives reload', () => {
  const initial = { game: { country: 'Germany', gameDate: '2016-12-08' }, world: {}, meta: { id: 'test', scenarioId: 'default' } };
  const pair = { ...initial, ...prepareSimulationOperation(initial, 'start', { seed: 7 }, 'test', { geometry }) };
  pair.world.strategy.wars.push({ a: 'Germany', b: 'France', since: pair.game.gameDate });
  pair.world.strategy.countries.Germany.readiness = 80;
  pair.world.strategy.countries.France.readiness = 80;
  const next = advance(pair, 'week');
  const changed = ['a', 'b'].filter((id) => next.world.strategy.regions[id].owner !== pair.world.strategy.regions[id].owner);
  assert.equal(changed.length, 1);
  const id = changed[0];
  assert.equal(next.world.regionOwnershipOverrides[id], next.world.strategy.regions[id].owner);
  assert.equal(next.world.regionSovereigntyOverrides[id], pair.world.strategy.regions[id].sovereign);
  assert.equal(next.world.strategy.regions.remote.owner, 'France');
  assert.deepEqual(advance(next, 'week'), advance(JSON.parse(JSON.stringify(next)), 'week'));
});

test('the complete built-in world survives ten years with all countries and map identities intact', () => {
  const world = JSON.parse(fs.readFileSync(new URL('./seed/default/world.json', import.meta.url), 'utf8'));
  const map = JSON.parse(fs.readFileSync(new URL('./seed/default/regions.geojson', import.meta.url), 'utf8'));
  const original = { game: { country: 'Germany', gameDate: '2016-12-08' }, world, meta: { id: 'test', scenarioId: 'default' } };
  let pair = { ...original, ...prepareSimulationOperation(original, 'start', { seed: 20161208 }, 'test', { geometry: map }) };
  const countryIds = Object.keys(pair.world.strategy.countries).sort();
  assert.ok(countryIds.length >= 200);
  for (let month = 0; month < 120; month++) pair = advance(pair, 'month');
  assert.deepEqual(Object.keys(pair.world.strategy.countries).sort(), countryIds);
  assert.equal(pair.game.gameDate, '2026-12-08');
  assert.equal(Object.keys(pair.world.strategy.regions).length, map.features.length);
  assert.deepEqual(validateStrategy(JSON.parse(JSON.stringify(pair.world.strategy)), pair.game.gameDate), pair.world.strategy);
});

test('corrupt operation deadlines, political parameters and territorial graphs are rejected', () => {
  const strategy = start().world.strategy;
  const invalid = [
    { ...strategy, projects: [{ owner: 'Germany', kind: 'tax', value: 4000, due: '2016-99-99' }] },
    { ...strategy, projects: [{ owner: 'Germany', kind: 'tax', value: 4000, due: '2015-01-01' }] },
    { ...strategy, wars: [{ a: 'Germany', b: 'France', since: 'not-a-date' }] },
    { ...strategy, intel: [{ owner: 'Germany', target: 'Unknown', due: '2016-12-15' }] },
    { ...strategy, regions: { a: { name: 'A', owner: 'Germany', sovereign: 'Germany', neighbors: ['missing'] } } },
  ];
  for (const bad of invalid) assert.throws(() => validateStrategy(bad, '2016-12-08'));
});
