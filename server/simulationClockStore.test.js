import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSimulationState } from './simulation/state.js';
import { commitSimulationClock, recoverSimulationClock } from './simulation/clockStore.js';

const journalName = '.simulation-clock-journal.json';
const moduleUrl = new URL('./simulation/clockStore.js', import.meta.url).href;
const fixture = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-clock-transaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'campaign');
  fs.mkdirSync(directory);
  const pair = {
    game: { gameDate: '2016-12-08', country: 'Germany', round: 1 },
    world: { simulation: createSimulationState({ scenarioId: 'germany-2016', date: '2016-12-08', seed: 42 }), units: [] },
    meta: { id: 'campaign', scenarioId: 'germany-2016', updatedAt: '2026-01-01T00:00:00.000Z' },
  };
  for (const [key, file] of [['game', 'game.json'], ['world', 'world.json'], ['meta', 'game-instance.json']]) {
    fs.writeFileSync(path.join(directory, file), JSON.stringify(pair[key]));
  }
  return { directory, pair };
};
const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
const bytes = (directory) => ['game.json', 'world.json', 'game-instance.json'].map((name) => fs.readFileSync(path.join(directory, name)));
const crash = (directory, target) => spawnSync(process.execPath, ['--input-type=module', '-e', `
  import fs from 'node:fs';
  import path from 'node:path';
  import {commitSimulationClock} from ${JSON.stringify(moduleUrl)};
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    rename(from, to);
    if (path.basename(to) === ${JSON.stringify(target)}) process.exit(86);
  };
  commitSimulationClock(${JSON.stringify(directory)}, {step:'week',expectedRevision:0});
`], { encoding: 'utf8' });

test('a successful commit writes both clocks and metadata; stale retries cannot double-advance', (t) => {
  const { directory, pair } = fixture(t);
  const result = commitSimulationClock(directory, { step: 'week', expectedRevision: 0 });
  assert.equal(result.days, 7);
  assert.equal(read(directory, 'game.json').gameDate, '2016-12-15');
  assert.equal(read(directory, 'world.json').simulation.revision, 7);
  assert.deepEqual(read(directory, 'world.json').simulation.rng, pair.world.simulation.rng);
  assert.notEqual(read(directory, 'game-instance.json').updatedAt, pair.meta.updatedAt);
  assert.equal(fs.existsSync(path.join(directory, journalName)), false);
  const before = bytes(directory);
  assert.throws(() => commitSimulationClock(directory, { step: 'week', expectedRevision: 0 }), (error) => error.status === 409);
  assert.deepEqual(bytes(directory), before);
  assert.equal(recoverSimulationClock(directory), false);
});

for (const target of [journalName, 'game.json', 'world.json', 'game-instance.json']) {
  test(`a new process recovers a crash after replacing ${target}`, (t) => {
    const { directory, pair } = fixture(t);
    const result = crash(directory, target);
    assert.equal(result.status, 86, result.stderr);
    assert.ok(fs.existsSync(path.join(directory, journalName)));
    const recovery = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {recoverSimulationClock} from ${JSON.stringify(moduleUrl)};
      if (!recoverSimulationClock(${JSON.stringify(directory)})) process.exit(2);
    `], { encoding: 'utf8' });
    assert.equal(recovery.status, 0, recovery.stderr);
    assert.equal(read(directory, 'game.json').gameDate, '2016-12-15');
    const simulation = read(directory, 'world.json').simulation;
    assert.equal(simulation.date, '2016-12-15');
    assert.equal(simulation.revision, 7);
    assert.deepEqual(simulation.rng, pair.world.simulation.rng);
    assert.notEqual(read(directory, 'game-instance.json').updatedAt, pair.meta.updatedAt);
    assert.equal(recoverSimulationClock(directory), false, 'recovery is idempotent');
    assert.throws(() => commitSimulationClock(directory, { step: 'week', expectedRevision: 0 }), (error) => error.status === 409);
  });
}

test('a failure before journal publication leaves the old files intact and allows retry', (t) => {
  const { directory } = fixture(t);
  const before = bytes(directory);
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    import {commitSimulationClock} from ${JSON.stringify(moduleUrl)};
    const rename = fs.renameSync;
    fs.renameSync = (from,to) => {
      if (path.basename(to) === ${JSON.stringify(journalName)}) throw new Error('injected disk failure');
      return rename(from,to);
    };
    try { commitSimulationClock(${JSON.stringify(directory)}, {step:'day',expectedRevision:0}); }
    catch { process.exit(87); }
  `], { encoding: 'utf8' });
  assert.equal(child.status, 87, child.stderr);
  assert.deepEqual(bytes(directory), before);
  assert.equal(recoverSimulationClock(directory), false);
  assert.equal(commitSimulationClock(directory, { step: 'day', expectedRevision: 0 }).days, 1);
});

test('corrupt or unknown recovery journals fail closed and remain available for repair', (t) => {
  const { directory } = fixture(t);
  assert.equal(crash(directory, 'game.json').status, 86);
  const journal = path.join(directory, journalName);
  const original = read(directory, journalName);
  const before = bytes(directory);
  for (const content of ['{broken', JSON.stringify({ ...original, schema: 'future/99' }),
    JSON.stringify({ ...original, payload: original.payload + ' ' })]) {
    fs.writeFileSync(journal, content);
    assert.throws(() => recoverSimulationClock(directory));
    assert.deepEqual(bytes(directory), before);
    assert.equal(fs.readFileSync(journal, 'utf8'), content);
  }
});

test('invalid commands, legacy games and mismatched clocks cannot create a commit intent', (t) => {
  const { directory } = fixture(t);
  const before = bytes(directory);
  for (const request of [null, {}, { step: 'week', expectedRevision: '0' },
    { step: 'day', expectedRevision: -1 }, { step: 'year', expectedRevision: 0 },
    { step: 'day', expectedRevision: 0, world: {} }]) {
    assert.throws(() => commitSimulationClock(directory, request));
    assert.deepEqual(bytes(directory), before);
    assert.equal(fs.existsSync(path.join(directory, journalName)), false);
  }
  for (const world of [{}, { simulation: { ...read(directory, 'world.json').simulation, date: '2016-12-09' } }]) {
    fs.writeFileSync(path.join(directory, 'world.json'), JSON.stringify(world));
    const current = bytes(directory);
    assert.throws(() => commitSimulationClock(directory, { step: 'day', expectedRevision: 0 }));
    assert.deepEqual(bytes(directory), current);
    assert.equal(fs.existsSync(path.join(directory, journalName)), false);
  }
});
