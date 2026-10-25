import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSimulationState } from './simulation/state.js';
import { drawRandom } from './simulation/random.js';

test('simulation checkpoints persist through the real API; invalid writes/imports preserve saved games', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-simulation-'));
  process.env.OH_DATA_DIR = root;
  process.env.OH_HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.OH_ASSETS_DIR = path.join(root, 'downloaded-assets');
  fs.mkdirSync(process.env.OH_ASSETS_DIR);
  fs.writeFileSync(path.join(process.env.OH_ASSETS_DIR, 'cities-seed.json'), JSON.stringify({ downloadedSeed: true }));
  const { httpServer } = await import('./server.js');
  t.after(async () => {
    await new Promise((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  if (!httpServer.listening) await once(httpServer, 'listening');
  const base = `http://127.0.0.1:${httpServer.address().port}`;
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const created = await request('/api/games', 'POST', { name: 'Checkpoint test', scenarioId: 'default', setActive: true });
  assert.deepEqual((await request('/assets/cities-seed.json')).data, { downloadedSeed: true }, 'packaged editor reads map seeds from writable profile');
  const planStatus = await request('/api/strategy/chatgpt/status');
  assert.equal(planStatus.data.connected, false);
  const login = await request('/api/strategy/chatgpt/start', 'POST', {});
  assert.equal(login.status, 200);
  assert.equal(new URL(login.data.url).searchParams.get('redirect_uri'), `${base}/auth/callback`);
  const forgedCallback = await fetch(`${base}/auth/callback?state=forged&code=never-exchange&client_id=oaiapp_invalid`);
  assert.equal(forgedCallback.status, 400);
  assert.equal(forgedCallback.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(created.status, 201);
  const gameId = created.data.game.id;
  const legacy = (await request('/api/runtime/json/world')).data;
  assert.equal(Object.hasOwn(legacy, 'simulation'), false);
  const simulation = createSimulationState({ scenarioId: 'default', date: '2016-12-08', seed: 42 });
  for (let i = 0; i < 13; i++) simulation.rng = drawRandom(simulation.rng).rng;
  const world = { ...legacy, simulation };
  assert.equal((await request('/api/runtime/json/world', 'PUT', world)).status, 200);
  assert.deepEqual((await request('/api/runtime/json/world')).data.simulation, simulation);
  const savedPath = path.join(root, 'games', gameId, 'world.json');
  const savedBytes = fs.readFileSync(savedPath);
  const bundle = (await request(`/api/games/${gameId}/export`)).data;
  assert.deepEqual(bundle.data.world.simulation, simulation);

  for (const bad of [null, { ...simulation, schemaVersion: 99 }, { ...simulation, rulesVersion: 99 },
    { ...simulation, rng: { ...simulation.rng, state: -1 } }]) {
    const invalidWorld = { ...world, simulation: bad };
    assert.equal((await request('/api/runtime/json/world', 'PUT', invalidWorld)).status, 400);
    const gameBefore = (await request(`/api/games/${gameId}`)).data;
    assert.equal((await request(`/api/games/${gameId}`, 'PUT', {
      name: 'Must not change', worldPatch: { simulation: bad },
    })).status, 400);
    assert.deepEqual((await request(`/api/games/${gameId}`)).data, gameBefore);
    const before = (await request('/api/games')).data;
    const invalidBundle = { ...bundle, data: { ...bundle.data, world: invalidWorld } };
    assert.equal((await request('/api/games/import', 'POST', invalidBundle)).status, 400);
    assert.deepEqual((await request('/api/games')).data, before);
    assert.deepEqual(fs.readFileSync(savedPath), savedBytes);
  }

  const imported = await request('/api/games/import', 'POST', bundle);
  assert.equal(imported.status, 201);
  assert.notEqual(imported.data.game.id, gameId);
  await request('/api/games/active', 'PUT', { gameId: imported.data.game.id });
  const restored = (await request('/api/runtime/json/world')).data.simulation;
  assert.deepEqual(drawRandom(restored.rng), drawRandom(simulation.rng));
  assert.deepEqual(fs.readFileSync(savedPath), savedBytes, 'import must preserve the source game');

  const copyId = imported.data.game.id;
  await request(`/api/games/${copyId}`, 'PUT', { gamePatch: { gameDate: simulation.date } });
  const copyBefore = (await request(`/api/games/${copyId}`)).data;
  const other = await request('/api/games', 'POST', { name: 'Other active game', scenarioId: 'default', setActive: true });
  const otherBefore = (await request(`/api/games/${other.data.game.id}`)).data;
  const endpoint = `/api/games/${copyId}/simulation/advance`;
  const advanced = await request(endpoint, 'POST', { step: 'week', expectedRevision: 0 });
  assert.equal(advanced.status, 200);
  assert.equal(advanced.data.gameId, copyId);
  assert.equal(advanced.data.days, 7);
  assert.equal(advanced.data.game.gameDate, '2016-12-15');
  assert.equal(advanced.data.world.simulation.date, advanced.data.game.gameDate);
  assert.equal(advanced.data.world.simulation.revision, 7);
  assert.deepEqual(advanced.data.world.simulation.rng, simulation.rng);
  const copyAfter = (await request(`/api/games/${copyId}`)).data;
  assert.notEqual(copyAfter.game.cacheToken, copyBefore.game.cacheToken);
  assert.deepEqual((await request(`/api/games/${other.data.game.id}`)).data, otherBefore);
  assert.equal((await request('/api/games')).data.activeGameId, other.data.game.id);

  const competing = await Promise.all([
    request(endpoint, 'POST', { step: 'day', expectedRevision: 7 }),
    request(endpoint, 'POST', { step: 'day', expectedRevision: 7 }),
  ]);
  assert.deepEqual(competing.map((reply) => reply.status).sort(), [200, 409]);
  const final = (await request(`/api/games/${copyId}/export`)).data;
  assert.equal(final.data.game.gameDate, '2016-12-16');
  assert.equal(final.data.world.simulation.revision, 8);
  const unchanged = (await request(`/api/games/${copyId}`)).data;
  assert.equal((await request(endpoint, 'POST', { step: 'month', expectedRevision: 8, world: {} })).status, 400);
  assert.deepEqual((await request(`/api/games/${copyId}`)).data, unchanged);
  assert.equal((await request(`/api/games/${other.data.game.id}/simulation/advance`, 'POST', { step: 'day', expectedRevision: 0 })).status, 400);
  assert.equal((await request('/api/games/missing-clock-game/simulation/advance', 'POST', { step: 'day', expectedRevision: 0 })).status, 404);

  const nativeId = other.data.game.id;
  const initialized = await request(`/api/games/${nativeId}/simulation/start`, 'POST', { seed: 20161208 });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.data.game.simulationMode, 'native');
  assert.equal(initialized.data.world.simulation.rulesVersion, 2);
  assert.equal((await request('/api/runtime/json/world', 'PUT', initialized.data.world)).status, 409);
  assert.equal((await request(`/api/games/${nativeId}`, 'PUT', { gamePatch: { gameDate: '2020-01-01' } })).status, 409);
  const policy = await request(`/api/games/${nativeId}/simulation/decision`, 'POST', { type: 'tax', value: 45, expectedRevision: 0 });
  assert.equal(policy.status, 200);
  const nativeStep = await request(`/api/games/${nativeId}/simulation/advance`, 'POST', { step: 'week', expectedRevision: 1 });
  assert.equal(nativeStep.status, 200);
  const player = nativeStep.data.world.strategy.player;
  assert.equal(nativeStep.data.world.strategy.countries[player].tax, 4500);
  const nativeBundle = (await request(`/api/games/${nativeId}/export`)).data;
  const restoredNative = await request('/api/games/import', 'POST', nativeBundle);
  assert.equal(restoredNative.status, 201);
  assert.equal(restoredNative.data.game.simulationMode, 'native');
  assert.deepEqual(restoredNative.data.data.world.strategy, nativeStep.data.world.strategy);
});
