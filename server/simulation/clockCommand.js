// @ts-check
// Shared command contract. No filesystem or database dependencies.
import { advanceSimulationClock } from './time.js';
import { readWorldSimulation } from './state.js';

/** @typedef {{game: Record<string, unknown>, world: Record<string, unknown>, meta: Record<string, unknown>}} ClockPair */
/** @typedef {{step: import('./time.js').TimeStep, expectedRevision: number}} ClockRequest */
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export class ClockRequestError extends Error {
  /** @param {string} message @param {number} [status] */
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** @param {unknown} request @returns {ClockRequest} */
export function validateClockRequest(request) {
  if (!isObject(request) || Object.keys(request).length !== 2
    || typeof request.expectedRevision !== 'number'
    || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0
    || (request.step !== 'day' && request.step !== 'week' && request.step !== 'month')) {
    throw new ClockRequestError('Expected step (day/week/month) and a nonnegative integer expectedRevision.');
  }
  return { step: request.step, expectedRevision: request.expectedRevision };
}

/** @param {unknown} pair @param {string} gameId @returns {ClockPair} */
export function validateClockPair(pair, gameId) {
  if (!isObject(pair) || !isObject(pair.game) || !isObject(pair.world) || !isObject(pair.meta)) {
    throw new Error('Invalid simulation clock record.');
  }
  const simulation = readWorldSimulation(pair.world);
  if (!simulation || simulation.date !== pair.game.gameDate
    || pair.meta.id !== gameId || pair.meta.scenarioId !== simulation.scenarioId) {
    throw new Error('Simulation clock record has inconsistent identity or dates.');
  }
  return { game: pair.game, world: pair.world, meta: pair.meta };
}

/** @param {ClockPair} pair @param {unknown} request @param {string} gameId */
export function prepareClockAdvance(pair, request, gameId) {
  const command = validateClockRequest(request);
  const simulation = readWorldSimulation(pair.world);
  if (!simulation) throw new ClockRequestError('Legacy game requires explicit simulation initialization.');
  if (simulation.revision !== command.expectedRevision) {
    throw new ClockRequestError('Simulation revision conflict; reload the saved game before retrying.', 409);
  }
  try {
    validateClockPair(pair, gameId);
    return advanceSimulationClock({ game: pair.game, world: pair.world }, command.step);
  } catch (error) {
    throw new ClockRequestError(error instanceof Error ? error.message : String(error));
  }
}
