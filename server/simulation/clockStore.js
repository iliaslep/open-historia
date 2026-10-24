// Local, single-server persistence. A durable redo record precedes all projections.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { advanceSimulationClock } from './time.js';
import { readWorldSimulation } from './state.js';

const JOURNAL = '.simulation-clock-journal.json';
const SCHEMA = 'open-historia-clock-transaction/1';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ClockRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const syncDirectory = (directory) => {
  // Windows does not expose directory fsync through node:fs. Atomic rename still
  // protects against process termination; power-loss durability is platform-specific.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

const atomicJson = (file, value) => {
  const temporary = `${file}.clock-tmp`;
  const fd = fs.openSync(temporary, 'w', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDirectory(path.dirname(file));
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const validatePair = (pair, gameId) => {
  if (!isObject(pair) || !isObject(pair.game) || !isObject(pair.world) || !isObject(pair.meta)) {
    throw new Error('Invalid simulation clock record.');
  }
  const simulation = readWorldSimulation(pair.world);
  if (!simulation || simulation.date !== pair.game.gameDate
    || pair.meta.id !== gameId || pair.meta.scenarioId !== simulation.scenarioId) {
    throw new Error('Simulation clock record has inconsistent identity or dates.');
  }
  return pair;
};

/**
 * Complete an interrupted commit before exposing any of its files. A malformed
 * journal fails closed and remains on disk; never silently replace it with defaults.
 */
export function recoverSimulationClock(directory) {
  const journal = path.join(directory, JOURNAL);
  if (!fs.existsSync(journal)) return false;
  const envelope = readJson(journal);
  if (!isObject(envelope) || envelope.schema !== SCHEMA || typeof envelope.payload !== 'string'
    || envelope.sha256 !== digest(envelope.payload)) {
    throw new Error('Simulation clock recovery journal is corrupt or unsupported.');
  }
  const pair = validatePair(JSON.parse(envelope.payload), path.basename(directory));
  atomicJson(path.join(directory, 'game.json'), pair.game);
  atomicJson(path.join(directory, 'world.json'), pair.world);
  atomicJson(path.join(directory, 'game-instance.json'), pair.meta);
  fs.unlinkSync(journal);
  syncDirectory(directory);
  return true;
}

/**
 * Runs synchronously inside one server process, so revision check and durable
 * intent cannot interleave with another HTTP request. Multiple server processes
 * writing the same data directory are unsupported.
 */
export function commitSimulationClock(directory, request) {
  recoverSimulationClock(directory);
  if (!isObject(request) || Object.keys(request).length !== 2
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || !['day', 'week', 'month'].includes(request.step)) {
    throw new ClockRequestError('Expected step (day/week/month) and a nonnegative integer expectedRevision.');
  }
  const pair = {
    game: readJson(path.join(directory, 'game.json')),
    world: readJson(path.join(directory, 'world.json')),
    meta: readJson(path.join(directory, 'game-instance.json')),
  };
  const simulation = readWorldSimulation(pair.world);
  if (!simulation) throw new ClockRequestError('Legacy game requires explicit simulation initialization.');
  if (simulation.revision !== request.expectedRevision) {
    throw new ClockRequestError('Simulation revision conflict; reload the saved game before retrying.', 409);
  }
  let next;
  try {
    validatePair(pair, path.basename(directory));
    next = advanceSimulationClock({ game: pair.game, world: pair.world }, request.step);
  } catch (error) {
    throw new ClockRequestError(error.message);
  }
  // Metadata belongs to the commit too: a recovered turn must invalidate client
  // asset URLs even if the process died before updating the catalog token.
  const previousTime = Date.parse(pair.meta.updatedAt);
  const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
  const payload = JSON.stringify({ game: next.game, world: next.world, meta: { ...pair.meta, updatedAt } });
  atomicJson(path.join(directory, JOURNAL), { schema: SCHEMA, payload, sha256: digest(payload) });
  // From this point the turn is committed intent. Failure leaves the journal:
  // recovery rolls forward; an identical request then conflicts rather than double-advancing.
  recoverSimulationClock(directory);
  return next;
}
