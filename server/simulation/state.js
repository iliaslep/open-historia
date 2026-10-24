// @ts-check
import { createRandomState, validateRandomState } from './random.js';

/**
 * Header for the opt-in simulation. No economy or NPC turn is implemented yet.
 * @typedef {object} SimulationState
 * @property {1} schemaVersion
 * @property {1} rulesVersion
 * @property {string} scenarioId
 * @property {string} date Canonical CE date (0001–9999), not wall-clock time.
 * @property {number} revision Committed simulation turns (not random draws).
 * @property {import('./random.js').RandomState} rng
 */
export const SIMULATION_SCHEMA_VERSION = 1;
export const SIMULATION_RULES_VERSION = 1;

/** @param {unknown} raw @returns {SimulationState} */
export function validateSimulationState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid simulation state.');
  const value = /** @type {Record<string, unknown>} */ (raw);
  if (value.schemaVersion !== SIMULATION_SCHEMA_VERSION || value.rulesVersion !== SIMULATION_RULES_VERSION) {
    throw new Error('Unsupported simulation schemaVersion or rulesVersion; save was not migrated.');
  }
  const { scenarioId, date, revision } = value;
  if (Object.keys(value).length !== 6
    || typeof scenarioId !== 'string' || !scenarioId.trim() || scenarioId !== scenarioId.trim()
    || typeof date !== 'string' || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date)
    || !Number.isFinite(Date.parse(date + 'T00:00:00Z'))
    || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date
    || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('Invalid simulation header fields.');
  }
  return { schemaVersion: 1, rulesVersion: 1, scenarioId, date, revision, rng: validateRandomState(value.rng) };
}

/** @param {{scenarioId: string, date: string, seed: number}} options @returns {SimulationState} */
export function createSimulationState({ scenarioId, date, seed }) {
  return validateSimulationState({ schemaVersion: 1, rulesVersion: 1, scenarioId, date, revision: 0, rng: createRandomState(seed) });
}

/**
 * Absence means legacy mode. Never silently reset, migrate or enable a simulation.
 * @param {unknown} world
 * @returns {SimulationState | undefined}
 */
export function readWorldSimulation(world) {
  if (!world || typeof world !== 'object' || !Object.hasOwn(world, 'simulation')) return undefined;
  return validateSimulationState(/** @type {{simulation: unknown}} */ (world).simulation);
}
