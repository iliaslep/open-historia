// @ts-check
import { addGameDays, addGameMonths, diffGameDays } from '../gameDates.js';
import { readWorldSimulation, validateSimulationState } from './state.js';
import { advanceStrategy } from './strategy.js';

/** @typedef {import('./state.js').SimulationState} SimulationState */
/** @typedef {'day' | 'week' | 'month'} TimeStep */
/** @typedef {{game: Record<string, unknown>, world: Record<string, unknown>}} ClockState */

/**
 * One daily tick. Revision counts processed days, independently of batching.
 * No domain systems or random draws run yet; the RNG checkpoint is preserved.
 * @param {SimulationState} raw
 * @returns {SimulationState}
 */
export function advanceSimulationDay(raw) {
  const state = validateSimulationState(raw);
  if (state.revision === Number.MAX_SAFE_INTEGER) throw new Error('Simulation revision exhausted.');
  return validateSimulationState({
    ...state,
    date: addGameDays(state.date, 1),
    revision: state.revision + 1,
  });
}

/**
 * A month means the same day of the next month, clamped to its last day.
 * Every interval runs the same daily tick; input is never changed.
 * @param {SimulationState} raw
 * @param {TimeStep} step
 * @returns {SimulationState}
 */
export function advanceSimulation(raw, step) {
  let state = validateSimulationState(raw);
  let targetDate;
  switch (step) {
    case 'day': targetDate = addGameDays(state.date, 1); break;
    case 'week': targetDate = addGameDays(state.date, 7); break;
    case 'month': targetDate = addGameMonths(state.date, 1); break;
    default: throw new Error('Unsupported simulation time step.');
  }
  // Reject date/revision overflow before processing any daily ticks.
  validateSimulationState({ ...state, date: targetDate });
  const days = diffGameDays(state.date, targetDate);
  if (days === null || !Number.isSafeInteger(days) || days < 1 || days > 31
    || state.revision > Number.MAX_SAFE_INTEGER - days) {
    throw new Error('Invalid simulation interval or exhausted revision.');
  }
  for (let day = 0; day < days; day++) state = advanceSimulationDay(state);
  return state;
}

/**
 * Prepare both clocks together in memory. This does not persist a turn or
 * enable the simulation for legacy games; storage transaction/UI come later.
 * @param {ClockState} input
 * @param {TimeStep} step
 * @returns {ClockState & {days: number}}
 */
export function advanceSimulationClock(input, step) {
  if (!input?.game || typeof input.game !== 'object' || Array.isArray(input.game)
    || !input.world || typeof input.world !== 'object' || Array.isArray(input.world)) {
    throw new Error('Simulation clock requires game and world objects.');
  }
  const simulation = readWorldSimulation(input.world);
  if (!simulation) throw new Error('Legacy game has no simulation clock; explicit initialization is required.');
  if (input.game.gameDate !== simulation.date) {
    throw new Error('Simulation date does not match game.gameDate; no turn was advanced.');
  }
  const next = advanceSimulation(simulation, step);
  const result = structuredClone(input);
  result.game.gameDate = next.date;
  if (simulation.rulesVersion === 2) {
    const advanced = advanceStrategy(input.world.strategy, simulation.date, next.date, simulation.rng);
    result.world.strategy = advanced.strategy;
    next.rng = advanced.rng;
    const ownership = { .../** @type {Record<string, string>} */ (input.world.regionOwnershipOverrides || {}) };
    const sovereignty = { .../** @type {Record<string, string>} */ (input.world.regionSovereigntyOverrides || {}) };
    for (const [id, region] of Object.entries(advanced.strategy.regions || {})) {
      ownership[id] = region.owner;
      if (region.owner !== region.sovereign) sovereignty[id] = region.sovereign;
    }
    result.world.regionOwnershipOverrides = ownership;
    result.world.regionSovereigntyOverrides = sovereignty;
  }
  result.world.simulation = next;
  return { ...result, days: next.revision - simulation.revision };
}
