// Local, single-server persistence. A durable redo record precedes all projections.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareSimulationOperation, validateClockPair } from './clockCommand.js';
export { ClockRequestError } from './clockCommand.js';

const JOURNAL = '.simulation-clock-journal.json';
const SCHEMA = 'open-historia-clock-transaction/1';
// Old applications must refuse a pending chat transaction rather than silently
// recover only game/world and drop the conversation/receipt projection.
const CHAT_SCHEMA = 'open-historia-clock-transaction/2';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

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

/**
 * Complete an interrupted commit before exposing any of its files. A malformed
 * journal fails closed and remains on disk; never silently replace it with defaults.
 */
export function recoverSimulationClock(directory) {
  const journal = path.join(directory, JOURNAL);
  if (!fs.existsSync(journal)) return false;
  const envelope = readJson(journal);
  if (!isObject(envelope) || ![SCHEMA, CHAT_SCHEMA].includes(envelope.schema) || typeof envelope.payload !== 'string'
    || envelope.sha256 !== digest(envelope.payload)) {
    throw new Error('Simulation clock recovery journal is corrupt or unsupported.');
  }
  const pair = validateClockPair(JSON.parse(envelope.payload), path.basename(directory));
  if ((pair.chat !== undefined) !== (envelope.schema === CHAT_SCHEMA)) throw new Error('Simulation journal has an incompatible chat projection.');
  atomicJson(path.join(directory, 'game.json'), pair.game);
  atomicJson(path.join(directory, 'world.json'), pair.world);
  if (pair.chat !== undefined) {
    fs.mkdirSync(path.join(directory, 'storage'), { recursive: true });
    atomicJson(path.join(directory, 'storage', 'chat.json'), pair.chat);
  }
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
export function commitSimulationOperation(directory, operation, request, context = {}) {
  recoverSimulationClock(directory);
  const pair = {
    game: readJson(path.join(directory, 'game.json')),
    world: readJson(path.join(directory, 'world.json')),
    meta: readJson(path.join(directory, 'game-instance.json')),
    ...(['chat-record', 'chat-apply'].includes(operation) ? { chat: fs.existsSync(path.join(directory, 'storage', 'chat.json')) ? readJson(path.join(directory, 'storage', 'chat.json')) : [] } : {}),
  };
  // Older createGame records omitted the redundant id from metadata; the
  // validated directory identity remains authoritative for those saves.
  if (pair.meta.id === undefined) pair.meta.id = path.basename(directory);
  const next = prepareSimulationOperation(pair, operation, request, path.basename(directory), context);
  // Metadata belongs to the commit too: a recovered turn must invalidate client
  // asset URLs even if the process died before updating the catalog token.
  const previousTime = Date.parse(pair.meta.updatedAt);
  const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
  const committedPair = validateClockPair({ game: next.game, world: next.world, meta: { ...pair.meta, updatedAt }, ...('chat' in next ? { chat: next.chat } : {}) }, path.basename(directory));
  const payload = JSON.stringify(committedPair);
  atomicJson(path.join(directory, JOURNAL), { schema: 'chat' in next ? CHAT_SCHEMA : SCHEMA, payload, sha256: digest(payload) });
  // From this point the turn is committed intent. Failure leaves the journal:
  // recovery rolls forward; an identical request then conflicts rather than double-advancing.
  recoverSimulationClock(directory);
  return next;
}

export const commitSimulationClock = (directory, request) => commitSimulationOperation(directory, 'advance', request);
