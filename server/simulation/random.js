// @ts-check
// Pure, serializable simulation PRNG. Not intended for secrets or cryptography.

/** @typedef {{algorithm: 'mulberry32-v1', seed: number, state: number, draws: number}} RandomState */
const STEP = 0x6d2b79f5;
const UINT32_RANGE = 0x100000000;

/** @param {unknown} value @returns {value is number} */
export const isUint32 = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < UINT32_RANGE;

/** @param {number} seed @returns {RandomState} */
export function createRandomState(seed) {
  if (!isUint32(seed)) throw new Error('Simulation seed must be a uint32.');
  return { algorithm: 'mulberry32-v1', seed, state: seed, draws: 0 };
}

/** @param {unknown} raw @returns {RandomState} */
export function validateRandomState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid simulation RNG.');
  const value = /** @type {Record<string, unknown>} */ (raw);
  const { algorithm, seed, state, draws } = value;
  if (Object.keys(value).length !== 4 || algorithm !== 'mulberry32-v1'
    || !isUint32(seed) || !isUint32(state)
    || typeof draws !== 'number' || !Number.isSafeInteger(draws) || draws < 0) {
    throw new Error('Invalid simulation RNG fields or algorithm.');
  }
  // Detect a truncated or inconsistent checkpoint without replaying its draws.
  if (((seed + Math.imul(draws % UINT32_RANGE, STEP)) >>> 0) !== state) {
    throw new Error('Simulation RNG checkpoint is inconsistent.');
  }
  return { algorithm, seed, state, draws };
}

/** @param {RandomState} raw @returns {{value: number, rng: RandomState}} */
export function drawRandom(raw) {
  const rng = validateRandomState(raw);
  if (rng.draws === Number.MAX_SAFE_INTEGER) throw new Error('Simulation RNG draw counter exhausted.');
  const state = (rng.state + STEP) >>> 0;
  let bits = Math.imul(state ^ (state >>> 15), state | 1);
  bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
  const value = ((bits ^ (bits >>> 14)) >>> 0) / UINT32_RANGE;
  return { value, rng: { ...rng, state, draws: rng.draws + 1 } };
}
