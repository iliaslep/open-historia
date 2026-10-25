// @ts-check
// Shared command contract. No filesystem or database dependencies.
import { advanceSimulationClock } from './time.js';
import { createSimulationState, readWorldSimulation, validateSimulationState } from './state.js';
import { createStrategy, strategyDecision } from './strategy.js';

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

/** @param {ClockPair} pair @param {string} operation @param {unknown} raw @param {string} gameId @param {{geometry?: unknown, scenarioId?: string}} [context] */
export function prepareSimulationOperation(pair, operation, raw, gameId, context = {}) {
  if (operation === 'advance') return prepareClockAdvance(pair, raw, gameId);
  if (!isObject(raw)) throw new ClockRequestError('Ожидался объект команды.');
  if (operation === 'start') {
    if (context.scenarioId && context.scenarioId !== pair.meta.scenarioId) throw new ClockRequestError('Сценарий изменился. Обновите партию.', 409);
    if (Object.keys(raw).length !== 1 || typeof raw.seed !== 'number' || !Number.isInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffffffff) throw new ClockRequestError('Укажите целый seed от 0 до 4294967295.');
    if (Object.hasOwn(pair.world, 'simulation')) throw new ClockRequestError('В партии уже включена симуляция.', 409);
    if (typeof pair.game.country !== 'string' || !pair.game.country) throw new ClockRequestError('Сначала выберите государство.');
    const world = structuredClone(pair.world);
    world.strategy = createStrategy(world, pair.game.country, context.geometry);
    world.simulation = validateSimulationState({ ...createSimulationState({ scenarioId: String(pair.meta.scenarioId), date: String(pair.game.gameDate), seed: raw.seed }), rulesVersion: 2 });
    return { game: { ...pair.game, simulationMode: 'native', language: 'Russian' }, world, days: 0 };
  }
  if (operation !== 'decision') throw new ClockRequestError('Неизвестная операция.');
  const simulation = readWorldSimulation(pair.world);
  if (!simulation || simulation.rulesVersion !== 2) throw new ClockRequestError('Расчётный режим не включён.');
  if (typeof raw.expectedRevision !== 'number' || !Number.isSafeInteger(raw.expectedRevision) || raw.expectedRevision < 0) throw new ClockRequestError('Некорректная revision команды.');
  if (raw.expectedRevision !== simulation.revision) throw new ClockRequestError('Состояние изменилось. Обновите партию.', 409);
  if (Object.keys(raw).some((key) => !['type', 'target', 'value', 'expectedRevision'].includes(key))) throw new ClockRequestError('Команда содержит неизвестные поля.');
  if (simulation.revision === Number.MAX_SAFE_INTEGER) throw new ClockRequestError('Счётчик состояния исчерпан.');
  try {
    validateClockPair(pair, gameId);
    const strategy = strategyDecision(pair.world.strategy, raw, simulation.date);
    return { game: structuredClone(pair.game), world: { ...structuredClone(pair.world), strategy, simulation: { ...simulation, revision: simulation.revision + 1 } }, days: 0 };
  } catch (error) { throw new ClockRequestError(error instanceof Error ? error.message : String(error)); }
}
