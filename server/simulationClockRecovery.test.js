import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const storeUrl = new URL('./libraryStore.js', import.meta.url).href;
const stateUrl = new URL('./simulation/state.js', import.meta.url).href;

test('normal library reads recover a process interrupted between game and world projections', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-library-clock-recovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (source) => spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    env: { ...process.env, OH_DATA_DIR: root }, encoding: 'utf8',
  });
  const setup = run(`
    import fs from 'node:fs';
    import path from 'node:path';
    import * as store from ${JSON.stringify(storeUrl)};
    import {createSimulationState} from ${JSON.stringify(stateUrl)};
    store.createGame({id:'recovery',scenarioId:'default',setActive:true});
    const world = store.readRuntimeJsonAsset('world').data;
    const game = store.readRuntimeJsonAsset('game').data;
    store.updateGame('recovery',{world:{...world,simulation:createSimulationState({scenarioId:'default',date:game.gameDate,seed:7})}});
    const rename = fs.renameSync;
    fs.renameSync = (from,to) => {
      rename(from,to);
      if (path.basename(to) === 'game.json') process.exit(86);
    };
    store.advanceGameClock('recovery',{step:'week',expectedRevision:0});
  `);
  assert.equal(setup.status, 86, setup.stderr);
  const gameDir = path.join(root, 'games', 'recovery');
  const journal = path.join(gameDir, '.simulation-clock-journal.json');
  assert.ok(fs.existsSync(journal));
  const gameDate = JSON.parse(fs.readFileSync(path.join(gameDir, 'game.json'), 'utf8')).gameDate;
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(gameDir, 'world.json'), 'utf8')).simulation.date, gameDate);
  const loaded = run(`
    import assert from 'node:assert/strict';
    import * as store from ${JSON.stringify(storeUrl)};
    const game = store.readRuntimeJsonAsset('game').data;
    const world = store.readRuntimeJsonAsset('world').data;
    assert.equal(world.simulation.revision,7);
    assert.equal(game.gameDate,world.simulation.date);
    const details = store.getGameDetails('recovery');
    assert.equal(details.game.currentDate,game.gameDate);
    const bundle = store.exportGameBundle('recovery');
    assert.equal(bundle.data.game.gameDate,bundle.data.world.simulation.date);
    assert.throws(() => store.advanceGameClock('recovery',{step:'week',expectedRevision:0}),e=>e.status===409);
  `);
  assert.equal(loaded.status, 0, loaded.stderr);
  assert.equal(fs.existsSync(journal), false);
});
