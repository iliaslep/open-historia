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
});
