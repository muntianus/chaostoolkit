import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  SAFE_INJECTIONS,
  evaluateExpectedEffect,
  injectHttpError,
  injectHttpLatency,
  killDemoProcess,
  parseAllowedHosts,
} from './faults.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_EXPERIMENTS_DIR = path.resolve(__dirname, '../experiments');

export const EXECUTION_MODES = Object.freeze(['dry_run', 'live_probe']);
// Safe by default: simulation never touches the network or a child process.
export const DEFAULT_MODE = 'dry_run';
// Process-level kill switch that authorises `live_probe`. Never a request field.
export const LIVE_ENABLED_ENV = 'CHAOS_LIVE_ENABLED';

/**
 * Thrown (before any probe, injection or child process) when `live_probe` is
 * requested but the operator has not authorised live injection.
 */
export class LiveModeDisabledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveModeDisabledError';
    this.code = 'LIVE_MODE_DISABLED';
  }
}

/**
 * Only an explicit `true` (boolean or case-insensitive "true" string) authorises
 * live injection. Anything else - unset, "1", "yes", "on" - leaves it off.
 */
export function parseLiveEnabled(value) {
  if (value === true) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

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
      // Live mode is strict by default: an offline target is a failed probe, not
      // a simulated pass. Explicit opt-in is required to restore old fallback.
      const allowFallback =
        overrides?.allow_live_fallback === true || overrides?.strict_live_network === false;
      if (!allowFallback) {
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
      // Explicit fallback to deterministic telemetry snapshot when offline in sandboxed CI
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

function resolveInjectionName(step) {
  const provider = step.provider || {};
  const args = provider.arguments || {};
  const candidates = [provider.func, provider.injection, provider.type, args.injection, args.action];
  return (
    candidates.find(
      (candidate) => typeof candidate === 'string' && SAFE_INJECTIONS.includes(candidate),
    ) || null
  );
}

function defaultExpectedEffect(injection, args) {
  if (injection === 'http_latency') {
    const configured = Number(args.latency_ms ?? 100);
    return {
      metric: 'latency_delta_ms',
      min: Math.max(10, Math.round(configured * 0.5)),
    };
  }
  if (injection === 'http_error') {
    return { metric: 'error_rate', min: 0.9 };
  }
  if (injection === 'process_kill') {
    return { metric: 'exited', equals: true };
  }
  return null;
}

async function executeInjection(step, injection, { fetchImpl, allowedHosts }) {
  const args = step.provider?.arguments || {};
  const samples = Math.max(1, Math.min(Number(args.samples) || 5, 20));

  if (injection === 'http_latency') {
    return injectHttpLatency({
      targetUrl: args.target_url || args.url || args.target,
      latencyMs: Number(args.latency_ms ?? 100),
      jitterMs: Number(args.jitter_ms ?? 0),
      samples,
      timeoutMs: Number(args.timeout_ms ?? 2500),
      fetchImpl,
      allowedHosts,
    });
  }

  if (injection === 'http_error') {
    return injectHttpError({
      targetUrl: args.target_url || args.url || args.target,
      statusCode: Number(args.status_code ?? 503),
      errorMode: args.error_mode || 'status',
      timeoutMs: Number(args.timeout_ms ?? 300),
      samples,
      fetchImpl,
      allowedHosts,
    });
  }

  if (injection === 'process_kill') {
    const waitForStdout =
      args.wait_for_stdout === false
        ? null
        : typeof args.wait_for_stdout === 'string'
          ? args.wait_for_stdout
          : 'READY';
    return killDemoProcess({
      script: args.script,
      args: args.args,
      graceMs: Number(args.grace_ms ?? 2000),
      runMs: Number(args.run_ms ?? 250),
      waitForStdout,
      startupTimeoutMs: Number(args.startup_timeout_ms ?? 3000),
    });
  }

  throw new Error(`Unsupported fault injection '${injection}'.`);
}

/**
 * Executes a method step (action or inline probe).
 */
async function executeMethodStep(step, mode, overrides, fetchImpl, allowedHosts = []) {
  if (step.type === 'probe') {
    return executeProbe(step, 'during', mode, overrides, fetchImpl);
  }

  const provider = step.provider || {};
  const args = provider.arguments || {};
  const injection = resolveInjectionName(step);
  const simulatedDuration = args.latency_ms || args.blip_duration_ms || 35;
  const base = {
    activity: step.name,
    type: 'action',
    phase: 'method',
    mode,
    provider_module: provider.module || 'perfops.faults.core',
    provider_func: provider.func || 'inject_fault',
    arguments: args,
    injection,
    timestamp: new Date().toISOString(),
  };

  // Dry-run keeps the historical deterministic simulation and never touches
  // the network or a child process.
  if (mode === 'dry_run') {
    return {
      ...base,
      status: 'succeeded',
      simulated_only: true,
      network_touched: false,
      process_touched: false,
      effect_verified: null,
      effect_reason: 'dry_run simulation (no real fault injected)',
      duration_ms: simulatedDuration,
    };
  }

  // Live mode must not silently simulate unknown actions: that is exactly the
  // false-positive behaviour this runner is meant to prevent.
  if (!injection) {
    return {
      ...base,
      status: 'failed',
      simulated_only: false,
      network_touched: false,
      process_touched: false,
      effect_verified: false,
      error: 'unsupported_fault_action',
      error_message: `Action '${step.name}' is not implemented for real injection. Supported: ${SAFE_INJECTIONS.join(', ')}.`,
      duration_ms: Math.max(1, Math.round(simulatedDuration)),
    };
  }

  const started = performance.now();
  let output;
  try {
    output = await executeInjection(step, injection, { fetchImpl, allowedHosts });
  } catch (err) {
    const blocked = err?.code === 'TARGET_NOT_ALLOWED' || err?.code === 'SCRIPT_NOT_ALLOWED';
    return {
      ...base,
      status: blocked ? 'blocked' : 'failed',
      simulated_only: false,
      network_touched: false,
      process_touched: false,
      effect_verified: false,
      error: err?.code || 'injection_failed',
      error_message: err?.message || String(err),
      output: { error: err?.code || 'injection_failed', message: err?.message || String(err) },
      duration_ms: Math.max(1, Math.round(performance.now() - started)),
    };
  }

  const expected = step.expected_effect || args.expected_effect || defaultExpectedEffect(injection, args);
  const effect = evaluateExpectedEffect(expected, output);

  return {
    ...base,
    status: effect.verified ? 'succeeded' : 'failed',
    simulated_only: false,
    network_touched: Boolean(output.network_touched),
    process_touched: Boolean(output.process_touched),
    output,
    expected_effect: expected,
    effect_verified: effect.verified,
    effect_reason: effect.reason,
    error: effect.verified ? undefined : 'expected_effect_not_observed',
    duration_ms: Math.max(1, Math.round(performance.now() - started)),
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
  injectionVerified = true,
}) {
  if (!beforePassed) {
    return {
      score: 20,
      grade: 'F',
      verdict: 'ABORTED_STEADY_STATE_BEFORE',
      launchgate_ready: false,
    };
  }

  if (!injectionVerified) {
    return {
      score: 30,
      grade: 'F',
      verdict: 'INJECTION_NOT_VERIFIED',
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
    // The allowlist is process configuration, never a per-request override.
    this.allowedHosts = parseAllowedHosts(
      options.allowedHosts ?? process.env.CHAOS_ALLOWED_HOSTS ?? '',
    );
    // Same for the live kill switch: set by the operator (CHAOS_LIVE_ENABLED),
    // never widened by a request body, override or CLI flag.
    this.liveEnabled = parseLiveEnabled(options.liveEnabled ?? process.env[LIVE_ENABLED_ENV]);
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
   * @param {'dry_run'|'live_probe'} [params.mode='dry_run'] - Execution mode. `live_probe` is refused with
   *   LiveModeDisabledError unless the runner was authorised (CHAOS_LIVE_ENABLED=true).
   * @param {Object} [params.overrides] - Optional telemetry/probe overrides for testing failure injection
   */
  async runExperiment({ experimentId, experiment: customExperiment, mode = DEFAULT_MODE, overrides = {} } = {}) {
    if (!EXECUTION_MODES.includes(mode)) {
      throw new Error(`Invalid execution mode '${mode}'. Expected 'dry_run' or 'live_probe'.`);
    }

    // Kill switch: must be the first gate, ahead of experiment lookup, probes,
    // injections and child processes, so a refused request has no side effects.
    if (mode === 'live_probe' && !this.liveEnabled) {
      throw new LiveModeDisabledError(
        `Live fault injection is disabled: mode 'live_probe' requires ${LIVE_ENABLED_ENV}=true in the service environment ` +
          "(it cannot be enabled per request). Use mode 'dry_run' for simulation.",
      );
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
        const res = await executeMethodStep(
          step,
          mode,
          overrides,
          this.fetchImpl,
          this.allowedHosts,
        );
        methodJournal.push(res);
        // A failed/blocked real injection invalidates the run; do not execute
        // the remaining method steps as if the fault had been applied.
        if (res.type === 'action' && res.status !== 'succeeded') break;
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

    const actionResults = methodJournal.filter((m) => m.type === 'action');
    const injectionResults = actionResults.filter(
      (m) => m.injection && m.simulated_only === false,
    );
    // In live mode every action must be a real injection whose expected effect
    // was observed. Dry-run keeps the historical simulated verdict.
    const injectionVerified = !beforePassed
      ? false
      : mode === 'dry_run'
        ? true
        : actionResults.every(
            (action) => action.status === 'succeeded' && action.effect_verified === true,
          );

    const resilience = computeResilienceScore({
      beforePassed,
      afterPassed,
      probeResultsBefore: beforeProbes,
      probeResultsAfter: afterProbes,
      methodResults: methodJournal,
      mttrMs,
      mttrBudgetMs,
      injectionVerified,
    });

    const overallStatus = !beforePassed
      ? 'aborted'
      : !injectionVerified
        ? 'failed'
        : !afterPassed
          ? 'deviated'
          : 'completed';
    const deviated = beforePassed && (!afterPassed || !injectionVerified);

    const report = {
      run_id: runId,
      chaoslib_version: '1.0.0',
      experiment_id: experiment.id || experimentId || 'custom-experiment',
      title: experiment.title,
      mode,
      status: overallStatus,
      deviated,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      safety: {
        dry_run: mode === 'dry_run',
        injection_enabled: mode === 'live_probe',
        target_guard: 'loopback-or-allowlist',
        allowed_hosts: this.allowedHosts,
        supported_injections: SAFE_INJECTIONS,
      },
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
      injection: {
        verified: injectionVerified,
        attempted: actionResults.length,
        real_injections: injectionResults.length,
        effects_verified: actionResults.filter((action) => action.effect_verified === true).length,
        blocked: actionResults.filter((action) => action.status === 'blocked').length,
        unsupported: actionResults.filter((action) => action.error === 'unsupported_fault_action')
          .length,
      },
      metrics: {
        mttr_ms: mttrMs,
        mttr_budget_ms: mttrBudgetMs,
        mttr_within_budget: mttrMs <= mttrBudgetMs,
        probes_evaluated: beforeProbes.length + afterProbes.length,
        actions_executed: actionResults.length,
        injections_attempted: actionResults.length,
        real_injections: injectionResults.length,
        injection_effects_verified: actionResults.filter((action) => action.effect_verified === true)
          .length,
        injections_blocked: actionResults.filter((action) => action.status === 'blocked').length,
        injection_verified: injectionVerified,
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
        steady_state_verified: beforePassed && afterPassed && injectionVerified,
        mttr_ms: mttrMs,
        recommendation: resilience.launchgate_ready ? 'PASS' : 'BLOCK',
      },
    };

    this.runs.unshift(report);
    return report;
  }
}
