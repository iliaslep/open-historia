import assert from 'node:assert/strict';
import test from 'node:test';
import { createRandomState, drawRandom, validateRandomState } from '../../server/simulation/random.js';
import { createSimulationState, readWorldSimulation, validateSimulationState } from '../../server/simulation/state.js';
import { normalizeWorldState } from '../runtime/gameState.js';

const header = () => createSimulationState({ scenarioId: 'germany-2016', date: '2016-12-08', seed: 1 });

test('mulberry32-v1 follows its fixed reference sequence without mutating the checkpoint', () => {
  const initial = Object.freeze(createRandomState(1));
  let rng = initial;
  const values = [];
  for (let i = 0; i < 4; i++) {
    const draw = drawRandom(rng);
    values.push(draw.value);
    rng = draw.rng;
  }
  assert.deepEqual(values, [0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741]);
  assert.equal(initial.state, 1);
  assert.equal(initial.draws, 0);
  assert.equal(rng.draws, 4);
});

test('JSON checkpoints resume exactly, including zero seed and uint32 wraparound', () => {
  for (const seed of [0, 1, 0xffffffff]) {
    let live = createRandomState(seed);
    for (let i = 0; i < 137; i++) live = drawRandom(live).rng;
    let restored = validateRandomState(JSON.parse(JSON.stringify(live)));
    for (let i = 0; i < 1000; i++) {
      const a = drawRandom(live);
      const b = drawRandom(restored);
      assert.deepEqual(a, b);
      assert.ok(a.value >= 0 && a.value < 1);
      live = a.rng;
      restored = b.rng;
    }
  }
});

test('RNG rejects corrupt checkpoints instead of silently reseeding', () => {
  for (const seed of [-1, 2 ** 32, 1.5, NaN, Infinity, '1', null]) {
    assert.throws(() => createRandomState(seed));
  }
  const rng = createRandomState(1);
  for (const bad of [null, [], {}, { ...rng, algorithm: 'unknown' }, { ...rng, state: 2 },
    { ...rng, draws: -1 }, { ...rng, draws: Number.MAX_SAFE_INTEGER + 1 }, { ...rng, extra: true }]) {
    assert.throws(() => validateRandomState(bad));
  }
  const draws = Number.MAX_SAFE_INTEGER;
  const exhausted = { ...rng, draws, state: (1 + Math.imul(draws % 2 ** 32, 0x6d2b79f5)) >>> 0 };
  assert.throws(() => drawRandom(exhausted), /exhausted/);
});

test('legacy worlds stay in legacy mode; explicit simulation survives normalization as a detached copy', () => {
  const legacy = { regionOwnershipOverrides: { 'DEU.1_1': 'Germany' } };
  assert.equal(readWorldSimulation(legacy), undefined);
  assert.equal(Object.hasOwn(normalizeWorldState(legacy), 'simulation'), false);
  const simulation = header();
  simulation.rng = drawRandom(simulation.rng).rng;
  const normalized = normalizeWorldState({ ...legacy, simulation });
  assert.deepEqual(normalized.simulation, simulation);
  assert.deepEqual(normalized.regionOwnershipOverrides, normalizeWorldState(legacy).regionOwnershipOverrides);
  assert.notEqual(normalized.simulation.rng, simulation.rng);
  assert.deepEqual(normalizeWorldState(JSON.parse(JSON.stringify(normalized))), normalized);
  normalized.simulation.rng.draws = 999;
  assert.equal(simulation.rng.draws, 1);
});

test('unknown versions and malformed headers fail without modifying input', () => {
  for (const patch of [{ schemaVersion: 2 }, { schemaVersion: 0 }, { rulesVersion: 99 },
    { revision: -1 }, { revision: 0.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
    { scenarioId: '' }, { scenarioId: ' padded ' }, { date: '2016-02-30' },
    { date: '2016-2-08' }, { date: '2016-12-08T00:00:00Z' }, { rng: null }, { extra: true }]) {
    const raw = { ...header(), ...patch };
    const before = structuredClone(raw);
    assert.throws(() => validateSimulationState(raw));
    assert.throws(() => normalizeWorldState({ simulation: raw }));
    assert.deepEqual(raw, before);
  }
  assert.throws(() => readWorldSimulation({ simulation: null }));
  assert.deepEqual(validateSimulationState(header()), header());
});
