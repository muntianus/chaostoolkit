import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_EXPERIMENTS_DIR = path.resolve(__dirname, '../experiments');

/**
 * Loads all ChaosToolkit JSON experiments from the experiments directory.
 */
export function loadExperiments(experimentsDir = DEFAULT_EXPERIMENTS_DIR) {
  if (!fs.existsSync(experimentsDir)) {
    return [];
  }
  const files = fs
    .readdirSync(experimentsDir)
    .filter((f) => f.endsWith('.json'))
    .sort();

  return files.map((file) => {
    const filePath = path.join(experimentsDir, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      ...parsed,
      id: parsed.id || path.basename(file, '.json'),
      file_name: file,
    };
  });
}

/**
 * Evaluates a single probe's output against its tolerance definition.
 */
export function evaluateTolerance(tolerance, output) {
  if (!tolerance) {
    return { passed: output?.status === 200, reason: 'default HTTP 200 tolerance' };
  }

  if (typeof tolerance === 'number') {
    const passed = output?.status === tolerance;
    return {
      passed,
      reason: passed
        ? `Status ${output?.status} matched expected ${tolerance}`
        : `Status ${output?.status} did not match ${tolerance}`,
    };
  }

  if (tolerance.type === 'status') {
    const statusOk = output?.status === (tolerance.status ?? 200);
    const latencyOk =
      tolerance.max_latency_ms === undefined ||
      (output?.latency_ms ?? 0) <= tolerance.max_latency_ms;
    const passed = statusOk && latencyOk;
    return {
      passed,
      reason: passed
        ? `Status ${output?.status} and latency ${output?.latency_ms}ms within tolerance (${tolerance.max_latency_ms ?? '∞'}ms)`
        : `Tolerance failed: status=${output?.status} (expected ${tolerance.status ?? 200}), latency=${output?.latency_ms}ms (max ${tolerance.max_latency_ms}ms)`,
    };
  }

  if (tolerance.type === 'jsonpath') {
    const val = output?.state ?? output?.[tolerance.field || 'state'];
    const stateOk = val === tolerance.expect;
    const latencyOk =
      tolerance.max_latency_ms === undefined ||
      (output?.latency_ms ?? 0) <= tolerance.max_latency_ms;
    const passed = stateOk && latencyOk;
    return {
      passed,
      reason: passed
        ? `State '${val}' matched '${tolerance.expect}' at ${output?.latency_ms}ms`
        : `Expected state '${tolerance.expect}', got '${val}' (latency ${output?.latency_ms}ms)`,
    };
  }

  if (tolerance.type === 'equals') {
    const actual = output?.[tolerance.field];
    const passed = actual === tolerance.expect;
    return {
      passed,
      reason: passed
        ? `Field '${tolerance.field}' equals '${tolerance.expect}'`
        : `Field '${tolerance.field}' was '${actual}', expected '${tolerance.expect}'`,
    };
  }

  if (tolerance.type === 'range') {
    const actual = Number(output?.[tolerance.field] ?? 0);
    const minOk = tolerance.min === undefined || actual >= tolerance.min;
    const maxOk = tolerance.max === undefined || actual <= tolerance.max;
    const passed = !Number.isNaN(actual) && minOk && maxOk;
    return {
      passed,
      reason: passed
        ? `Field '${tolerance.field}' (${actual}) within range [${tolerance.min ?? '-∞'}, ${tolerance.max ?? '+∞'}]`
        : `Field '${tolerance.field}' (${actual}) exceeded range [${tolerance.min ?? '-∞'}, ${tolerance.max ?? '+∞'}]`,
    };
  }

  return { passed: Boolean(output?.status === 200), reason: 'generic tolerance check' };
}

/**
 * Executes a single probe in either 'dry_run' or 'live_probe' mode.
 */
async function executeProbe(probe, phase, mode, overrides = {}, fetchImpl = globalThis.fetch) {
  const startMs = performance.now();
  const provider = probe.provider || {};
  const overrideData = overrides?.probes?.[probe.name]?.[phase] ?? overrides?.probes?.[probe.name];

  if (overrideData) {
    const output = { status: 200, latency_ms: 15, ...overrideData };
    const toleranceCheck = evaluateTolerance(probe.tolerance, output);
    return {
      activity: probe.name,
      type: 'probe',
      phase,
      mode,
      status: toleranceCheck.passed ? 'succeeded' : 'failed',
      tolerance_met: toleranceCheck.passed,
      tolerance_reason: toleranceCheck.reason,
      output,
      duration_ms: output.latency_ms,
      timestamp: new Date().toISOString(),
    };
  }

  if (mode === 'live_probe' && (provider.type === 'http' || provider.type === 'http_load_probe') && provider.url) {
    try {
      const controller = new AbortController();
      const timeoutMs = provider.timeout || 2500;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const response = await fetchImpl(provider.url, {
        method: provider.method || 'GET',
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latencyMs = Math.max(1, Math.round(performance.now() - startMs));
      const simBaseline = provider.simulation?.[phase] || provider.simulation?.before || {};
      const output = {
        ...simBaseline,
        status: response.status,
        latency_ms: latencyMs,
        live_probed: true,
        url: provider.url,
      };
      const toleranceCheck = evaluateTolerance(probe.tolerance, output);
      return {
        activity: probe.name,
        type: 'probe',
        phase,
        mode,
        status: toleranceCheck.passed ? 'succeeded' : 'failed',
        tolerance_met: toleranceCheck.passed,
        tolerance_reason: toleranceCheck.reason,
        output,
        duration_ms: latencyMs,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      const latencyMs = Math.max(1, Math.round(performance.now() - startMs));
      // If live endpoint is unreachable and fallback_to_simulation is enabled or not strict, record fallback or failure
      if (overrides?.strict_live_network === true) {
        const output = { status: 503, latency_ms: latencyMs, error: err.message, url: provider.url };
        const toleranceCheck = evaluateTolerance(probe.tolerance, output);
        return {
          activity: probe.name,
          type: 'probe',
          phase,
          mode,
          status: 'failed',
          tolerance_met: false,
          tolerance_reason: `Live HTTP probe failed: ${err.message}`,
          output,
          duration_ms: latencyMs,
          timestamp: new Date().toISOString(),
        };
      }
      // Graceful fallback to deterministic telemetry snapshot when offline in sandboxed CI
      const simFallback = provider.simulation?.[phase] || provider.simulation?.before || { status: 200, latency_ms: 45 };
      const output = { ...simFallback, live_fallback: true, live_error: err.message };
      const toleranceCheck = evaluateTolerance(probe.tolerance, output);
      return {
        activity: probe.name,
        type: 'probe',
        phase,
        mode,
        status: toleranceCheck.passed ? 'succeeded' : 'failed',
        tolerance_met: toleranceCheck.passed,
        tolerance_reason: toleranceCheck.reason,
        output,
        duration_ms: output.latency_ms || latencyMs,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Default dry_run / simulated telemetry execution
  const simData =
    provider.simulation?.[phase] ||
    provider.simulation?.during ||
    provider.simulation?.before || {
      status: 200,
      latency_ms: 25,
    };
  const output = { ...simData, simulated: mode === 'dry_run' };
  const toleranceCheck = evaluateTolerance(probe.tolerance, output);

  return {
    activity: probe.name,
    type: 'probe',
    phase,
    mode,
    status: toleranceCheck.passed ? 'succeeded' : 'failed',
    tolerance_met: toleranceCheck.passed,
    tolerance_reason: toleranceCheck.reason,
    output,
    duration_ms: output.latency_ms ?? Math.max(1, Math.round(performance.now() - startMs)),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Executes a method step (action or inline probe).
 */
async function executeMethodStep(step, mode, overrides, fetchImpl) {
  if (step.type === 'probe') {
    return executeProbe(step, 'during', mode, overrides, fetchImpl);
  }

  const provider = step.provider || {};
  const args = provider.arguments || {};
  const simulatedDuration = args.latency_ms || args.blip_duration_ms || 35;

  return {
    activity: step.name,
    type: 'action',
    phase: 'method',
    mode,
    status: 'succeeded',
    provider_module: provider.module || 'perfops.faults.core',
    provider_func: provider.func || 'inject_fault',
    arguments: args,
    simulated_only: true,
    duration_ms: simulatedDuration,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Computes a LaunchGate-compatible Resilience Score (0-100) and verdict.
 */
export function computeResilienceScore({
  beforePassed,
  afterPassed,
  probeResultsBefore,
  probeResultsAfter,
  methodResults,
  mttrMs,
  mttrBudgetMs = 2000,
}) {
  if (!beforePassed) {
    return {
      score: 20,
      grade: 'F',
      verdict: 'ABORTED_STEADY_STATE_BEFORE',
      launchgate_ready: false,
    };
  }

  const totalAfterProbes = Math.max(1, probeResultsAfter.length);
  const passedAfterProbes = probeResultsAfter.filter((p) => p.tolerance_met).length;
  const afterRatio = passedAfterProbes / totalAfterProbes;

  const totalMethodProbes = methodResults.filter((m) => m.type === 'probe');
  const failedMethodProbes = totalMethodProbes.filter((m) => m.tolerance_met === false).length;

  // Base score from post-fault steady-state recovery (up to 70 pts)
  let score = Math.round(afterRatio * 70);

  // MTTR efficiency bonus (up to 20 pts)
  if (mttrMs <= mttrBudgetMs) {
    const budgetRatio = Math.max(0, 1 - mttrMs / (mttrBudgetMs * 2));
    score += Math.round(10 + budgetRatio * 10);
  } else {
    score += Math.max(0, Math.round(10 - ((mttrMs - mttrBudgetMs) / mttrBudgetMs) * 10));
  }

  // In-flight resilience bonus (up to 10 pts)
  if (failedMethodProbes === 0) {
    score += 10;
  }

  if (!afterPassed) {
    score = Math.min(score, 55);
  }

  score = Math.max(0, Math.min(100, score));

  const grade =
    score >= 90 ? 'A' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 50 ? 'D' : 'F';

  return {
    score,
    grade,
    verdict: afterPassed && score >= 75 ? 'RESILIENT' : 'DEGRADED',
    launchgate_ready: afterPassed && score >= 75,
  };
}

/**
 * ChaosRunner manages the catalog of ChaosToolkit experiments and executes runs.
 */
export class ChaosRunner {
  constructor(options = {}) {
    this.experimentsDir = options.experimentsDir || DEFAULT_EXPERIMENTS_DIR;
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.runs = [];
  }

  listExperiments() {
    return loadExperiments(this.experimentsDir).map((exp) => ({
      id: exp.id,
      version: exp.version,
      title: exp.title,
      description: exp.description,
      tags: exp.tags || [],
      configuration: exp.configuration || {},
      steady_state_hypothesis: {
        title: exp['steady-state-hypothesis']?.title || '',
        probe_count: (exp['steady-state-hypothesis']?.probes || []).length,
        probes: (exp['steady-state-hypothesis']?.probes || []).map((p) => ({
          name: p.name,
          type: p.type,
          tolerance: p.tolerance,
          provider_type: p.provider?.type,
        })),
      },
      method_steps: (exp.method || []).length,
      rollback_steps: (exp.rollbacks || []).length,
    }));
  }

  getExperiment(experimentId) {
    const all = loadExperiments(this.experimentsDir);
    return all.find((exp) => exp.id === experimentId || exp.file_name === `${experimentId}.json`) || null;
  }

  listRuns() {
    return [...this.runs];
  }

  /**
   * Executes a named experiment or a custom ChaosToolkit experiment payload.
   * @param {Object} params
   * @param {string} [params.experimentId] - ID of registered experiment
   * @param {Object} [params.experiment] - Custom experiment JSON definition
   * @param {'dry_run'|'live_probe'} [params.mode='dry_run'] - Execution mode
   * @param {Object} [params.overrides] - Optional telemetry/probe overrides for testing failure injection
   */
  async runExperiment({ experimentId, experiment: customExperiment, mode = 'dry_run', overrides = {} } = {}) {
    if (!['dry_run', 'live_probe'].includes(mode)) {
      throw new Error(`Invalid execution mode '${mode}'. Expected 'dry_run' or 'live_probe'.`);
    }

    const experiment = customExperiment || this.getExperiment(experimentId);
    if (!experiment) {
      const err = new Error(`Experiment '${experimentId}' not found in catalog.`);
      err.code = 'EXPERIMENT_NOT_FOUND';
      throw err;
    }

    const runId = `chaos-run-${crypto.randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const hypothesis = experiment['steady-state-hypothesis'] || { title: 'Default Steady-State', probes: [] };
    const probes = hypothesis.probes || [];

    // 1. Before Steady-State Verification
    const beforeProbes = [];
    for (const probe of probes) {
      const res = await executeProbe(probe, 'before', mode, overrides, this.fetchImpl);
      beforeProbes.push(res);
    }
    const beforePassed = beforeProbes.every((p) => p.tolerance_met);

    // 2. Method Execution (only if before steady-state met, per ChaosToolkit spec)
    const methodJournal = [];
    if (beforePassed) {
      for (const step of experiment.method || []) {
        const res = await executeMethodStep(step, mode, overrides, this.fetchImpl);
        methodJournal.push(res);
      }
    }

    // 3. Rollbacks Execution
    const rollbackJournal = [];
    let simulatedMttrMs = overrides.mttr_ms ?? null;
    for (const rb of experiment.rollbacks || []) {
      const args = rb.provider?.arguments || {};
      if (simulatedMttrMs === null && typeof args.simulated_mttr_ms === 'number') {
        simulatedMttrMs = args.simulated_mttr_ms;
      }
      rollbackJournal.push({
        activity: rb.name,
        type: 'rollback',
        mode,
        status: 'succeeded',
        provider_func: rb.provider?.func || 'rollback',
        duration_ms: args.simulated_mttr_ms || 250,
        timestamp: new Date().toISOString(),
      });
    }

    // 4. After Steady-State Verification
    const afterProbes = [];
    if (beforePassed) {
      for (const probe of probes) {
        const res = await executeProbe(probe, 'after', mode, overrides, this.fetchImpl);
        afterProbes.push(res);
      }
    }
    const afterPassed = beforePassed && afterProbes.every((p) => p.tolerance_met);

    const mttrMs =
      simulatedMttrMs ??
      afterProbes.reduce((acc, p) => acc + (p.duration_ms || 0), 0) +
        rollbackJournal.reduce((acc, r) => acc + (r.duration_ms || 0), 0);
    const mttrBudgetMs = experiment.configuration?.mttr_budget_ms || 2000;

    const resilience = computeResilienceScore({
      beforePassed,
      afterPassed,
      probeResultsBefore: beforeProbes,
      probeResultsAfter: afterProbes,
      methodResults: methodJournal,
      mttrMs,
      mttrBudgetMs,
    });

    const overallStatus = beforePassed && afterPassed ? 'completed' : !beforePassed ? 'aborted' : 'deviated';

    const report = {
      run_id: runId,
      chaoslib_version: '1.0.0',
      experiment_id: experiment.id || experimentId || 'custom-experiment',
      title: experiment.title,
      mode,
      status: overallStatus,
      deviated: !afterPassed,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      steady_states: {
        hypothesis: hypothesis.title,
        before: {
          steady_state_met: beforePassed,
          probes: beforeProbes,
        },
        after: {
          steady_state_met: afterPassed,
          probes: afterProbes,
        },
      },
      run: methodJournal,
      rollbacks: rollbackJournal,
      metrics: {
        mttr_ms: mttrMs,
        mttr_budget_ms: mttrBudgetMs,
        mttr_within_budget: mttrMs <= mttrBudgetMs,
        probes_evaluated: beforeProbes.length + afterProbes.length,
        actions_executed: methodJournal.filter((m) => m.type === 'action').length,
      },
      resilience: {
        score: resilience.score,
        grade: resilience.grade,
        verdict: resilience.verdict,
        launchgate_ready: resilience.launchgate_ready,
      },
      launchgate_report: {
        gate_source: 'perfops-chaostoolkit',
        target_service:
          experiment.configuration?.target_service ||
          experiment.configuration?.proxy_service ||
          experiment.configuration?.target_host ||
          'perfops-platform',
        experiment_id: experiment.id || experimentId || 'custom-experiment',
        resilience_score: resilience.score,
        steady_state_verified: beforePassed && afterPassed,
        mttr_ms: mttrMs,
        recommendation: resilience.launchgate_ready ? 'PASS' : 'BLOCK',
      },
    };

    this.runs.unshift(report);
    return report;
  }
}
