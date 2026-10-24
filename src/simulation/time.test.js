import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createSimulationState } from '../../server/simulation/state.js';
import { drawRandom } from '../../server/simulation/random.js';
import { advanceSimulation, advanceSimulationClock, advanceSimulationDay } from '../../server/simulation/time.js';

const stateAt = (date) => createSimulationState({ scenarioId: 'germany-2016', date, seed: 42 });

test('daily, weekly and calendar-month steps cross calendar boundaries correctly', () => {
  for (const [date, step, expected, days] of [
    ['2016-12-31', 'day', '2017-01-01', 1],
    ['2016-02-28', 'day', '2016-02-29', 1],
    ['1900-02-28', 'day', '1900-03-01', 1],
    ['2000-02-28', 'day', '2000-02-29', 1],
    ['2016-02-25', 'week', '2016-03-03', 7],
    ['2016-12-28', 'week', '2017-01-04', 7],
    ['2024-03-30', 'week', '2024-04-06', 7],
    ['2016-01-31', 'month', '2016-02-29', 29],
    ['2017-01-31', 'month', '2017-02-28', 28],
    ['2016-02-29', 'month', '2016-03-29', 29],
    ['2016-04-30', 'month', '2016-05-30', 30],
    ['2016-12-08', 'month', '2017-01-08', 31],
    ['0001-01-01', 'day', '0001-01-02', 1],
  ]) {
    const result = advanceSimulation(stateAt(date), step);
    assert.equal(result.date, expected, `${date}: ${step}`);
    assert.equal(result.revision, days);
  }
});

test('batching uses daily ticks: a week or month equals that many separate days', () => {
  for (const [date, step, count] of [['2016-12-08', 'week', 7], ['2016-01-31', 'month', 29]]) {
    const start = stateAt(date);
    start.revision = 17;
    start.rng = drawRandom(start.rng).rng;
    let daily = start;
    for (let i = 0; i < count; i++) daily = advanceSimulationDay(daily);
    assert.deepEqual(advanceSimulation(start, step), daily);
    assert.deepEqual(daily.rng, start.rng, 'calendar ticks do not spend randomness');
  }
});

test('saving and resuming between steps produces the same state and next random draw', () => {
  const first = advanceSimulation(stateAt('2016-12-08'), 'week');
  const restored = JSON.parse(JSON.stringify(first));
  const uninterrupted = advanceSimulation(first, 'month');
  const resumed = advanceSimulation(restored, 'month');
  assert.deepEqual(resumed, uninterrupted);
  assert.deepEqual(drawRandom(resumed.rng), drawRandom(uninterrupted.rng));
});

test('both dates advance together; unrelated state and caller-owned inputs are preserved', () => {
  const input = {
    game: { gameDate: '2016-12-08', round: 4, language: 'Russian', settings: { keep: true } },
    world: { simulation: stateAt('2016-12-08'), units: [{ id: 'army' }] },
  };
  const before = structuredClone(input);
  const result = advanceSimulationClock(input, 'week');
  assert.equal(result.game.gameDate, '2016-12-15');
  assert.equal(result.world.simulation.date, result.game.gameDate);
  assert.equal(result.world.simulation.revision, 7);
  assert.equal(result.days, 7);
  assert.equal(result.game.round, 4, 'legacy round semantics are not changed by this clock adapter');
  assert.deepEqual(result.world.units, input.world.units);
  assert.deepEqual(input, before);
  result.world.units[0].id = 'changed';
  result.game.settings.keep = false;
  result.world.simulation.rng.state = 0;
  assert.deepEqual(input, before, 'the returned pair must not share mutable state with its caller');
});

test('legacy, mismatched and damaged clocks fail without changing either input', () => {
  for (const input of [
    { game: { gameDate: '2016-12-08' }, world: {} },
    { game: { gameDate: '2016-12-09' }, world: { simulation: stateAt('2016-12-08') } },
    { game: {}, world: { simulation: stateAt('2016-12-08') } },
    { game: { gameDate: '2016-12-08' }, world: { simulation: { ...stateAt('2016-12-08'), rulesVersion: 99 } } },
    { game: null, world: {} },
  ]) {
    const before = structuredClone(input);
    assert.throws(() => advanceSimulationClock(input, 'day'));
    assert.deepEqual(input, before);
  }
});

test('unsupported intervals, date limits and revision overflow are rejected without partial progress', () => {
  for (const [start, step] of [
    [stateAt('2016-12-08'), 'year'],
    [stateAt('2016-12-08'), 0],
    [stateAt('9999-12-31'), 'day'],
    [stateAt('9999-12-25'), 'week'],
    [stateAt('9999-12-01'), 'month'],
    [{ ...stateAt('2016-12-08'), revision: Number.MAX_SAFE_INTEGER }, 'day'],
    [{ ...stateAt('2016-12-08'), revision: Number.MAX_SAFE_INTEGER - 6 }, 'week'],
  ]) {
    const before = structuredClone(start);
    assert.throws(() => advanceSimulation(start, step));
    assert.deepEqual(start, before);
  }
  const last = advanceSimulationDay({ ...stateAt('2016-12-08'), revision: Number.MAX_SAFE_INTEGER - 1 });
  assert.equal(last.revision, Number.MAX_SAFE_INTEGER);
});

test('the time module runs from a packaged server tree without client sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-clock-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  fs.mkdirSync(path.join(root, 'server'));
  fs.cpSync(new URL('../../server/simulation/', import.meta.url), path.join(root, 'server', 'simulation'), { recursive: true });
  fs.copyFileSync(new URL('../../server/gameDates.js', import.meta.url), path.join(root, 'server', 'gameDates.js'));
  const entry = pathToFileURL(path.join(root, 'server', 'simulation', 'time.js')).href;
  const stateEntry = pathToFileURL(path.join(root, 'server', 'simulation', 'state.js')).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import {advanceSimulation} from ${JSON.stringify(entry)};
    import {createSimulationState} from ${JSON.stringify(stateEntry)};
    console.log(advanceSimulation(createSimulationState({scenarioId:'test',date:'2016-01-31',seed:0}), 'month').date);
  `], { encoding: 'utf8' });
  assert.equal(output.trim(), '2016-02-29');
});
