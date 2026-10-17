export {
  ChaosRunner,
  loadExperiments,
  evaluateTolerance,
  computeResilienceScore,
} from './src/runner.js';
export { createChaosServer, startServer } from './src/server.js';

// Backward-compatible steady-state hypothesis descriptor
export const steadyStateHypothesis = {
  title: 'API p95 < 300ms under latency injection',
  tolerance: true,
};
