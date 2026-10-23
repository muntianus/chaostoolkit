export {
  ChaosRunner,
  DEFAULT_MODE,
  LiveModeDisabledError,
  loadExperiments,
  evaluateTolerance,
  computeResilienceScore,
} from './src/runner.js';
export {
  FaultProxy,
  DEFAULT_DENIED_HOSTS,
  SAFE_INJECTIONS,
  TargetGuardError,
  ScriptGuardError,
  assertLocalTarget,
  evaluateExpectedEffect,
  injectHttpError,
  injectHttpLatency,
  isLoopbackHost,
  killDemoProcess,
  parseAllowedHosts,
  probeEndpoint,
} from './src/faults.js';
export { createChaosServer, startServer } from './src/server.js';

// Backward-compatible steady-state hypothesis descriptor
export const steadyStateHypothesis = {
  title: 'API p95 < 300ms under latency injection',
  tolerance: true,
};
