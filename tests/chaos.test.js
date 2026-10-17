import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChaosRunner } from '../src/runner.js';
import { startServer } from '../src/server.js';

describe('PerfOps ChaosToolkit Runner & Experiment Catalog', () => {
  const runner = new ChaosRunner();

  it('lists all 3 registered chaos experiments with steady-state hypotheses', () => {
    const experiments = runner.listExperiments();
    assert.equal(experiments.length, 3);
    const ids = experiments.map((e) => e.id).sort();
    assert.deepEqual(ids, [
      'caddy-zero-downtime-reload',
      'globex-api-degradation',
      'vps-cgroup-memory-pressure',
    ]);

    for (const exp of experiments) {
      assert.ok(exp.title.length > 0);
      assert.ok(exp.steady_state_hypothesis.title.length > 0);
      assert.ok(exp.steady_state_hypothesis.probe_count >= 2);
    }
  });

  it('runs globex-api-degradation in dry_run mode and verifies LaunchGate resilience score', async () => {
    const report = await runner.runExperiment({
      experimentId: 'globex-api-degradation',
      mode: 'dry_run',
    });

    assert.equal(report.experiment_id, 'globex-api-degradation');
    assert.equal(report.status, 'completed');
    assert.equal(report.deviated, false);
    assert.equal(report.steady_states.before.steady_state_met, true);
    assert.equal(report.steady_states.after.steady_state_met, true);
    assert.equal(report.steady_states.before.probes.length, 3);
    assert.equal(report.steady_states.after.probes.length, 3);
    assert.ok(report.resilience.score >= 85);
    assert.equal(report.resilience.verdict, 'RESILIENT');
    assert.equal(report.launchgate_report.recommendation, 'PASS');
    assert.equal(report.launchgate_report.target_service, 'api.globlex.pro');
  });

  it('runs vps-cgroup-memory-pressure and verifies unless-stopped policy & OOM headroom', async () => {
    const report = await runner.runExperiment({
      experimentId: 'vps-cgroup-memory-pressure',
      mode: 'dry_run',
    });

    assert.equal(report.experiment_id, 'vps-cgroup-memory-pressure');
    assert.equal(report.status, 'completed');
    assert.equal(report.steady_states.before.steady_state_met, true);
    assert.equal(report.steady_states.after.steady_state_met, true);
    assert.ok(report.metrics.mttr_within_budget);
    assert.equal(report.resilience.launchgate_ready, true);
  });

  it('runs caddy-zero-downtime-reload and verifies @perfops_bot anti-flapping debounce', async () => {
    const report = await runner.runExperiment({
      experimentId: 'caddy-zero-downtime-reload',
      mode: 'dry_run',
    });

    assert.equal(report.experiment_id, 'caddy-zero-downtime-reload');
    assert.equal(report.status, 'completed');
    assert.equal(report.steady_states.after.steady_state_met, true);
    assert.equal(report.resilience.verdict, 'RESILIENT');
  });

  it('detects post-fault steady-state failure (deviated) and blocks LaunchGate promotion', async () => {
    const report = await runner.runExperiment({
      experimentId: 'globex-api-degradation',
      mode: 'dry_run',
      overrides: {
        probes: {
          'postgres-connection-pool-headroom': {
            after: { status: 200, latency_ms: 910, pool_wait_queue: 24 },
          },
        },
      },
    });

    assert.equal(report.status, 'deviated');
    assert.equal(report.deviated, true);
    assert.equal(report.steady_states.before.steady_state_met, true);
    assert.equal(report.steady_states.after.steady_state_met, false);
    assert.ok(report.resilience.score <= 55);
    assert.equal(report.resilience.verdict, 'DEGRADED');
    assert.equal(report.launchgate_report.recommendation, 'BLOCK');
  });

  it('aborts experiment early when before steady-state hypothesis fails', async () => {
    const report = await runner.runExperiment({
      experimentId: 'vps-cgroup-memory-pressure',
      mode: 'dry_run',
      overrides: {
        probes: {
          'verify-container-restart-policies': {
            before: { status: 200, latency_ms: 10, restart_policy: 'no' },
          },
        },
      },
    });

    assert.equal(report.status, 'aborted');
    assert.equal(report.steady_states.before.steady_state_met, false);
    assert.equal(report.run.length, 0);
    assert.equal(report.resilience.verdict, 'ABORTED_STEADY_STATE_BEFORE');
    assert.equal(report.launchgate_report.recommendation, 'BLOCK');
  });

  it('supports live_probe mode with custom fetch implementation', async () => {
    const mockFetch = async () => ({ status: 200 });
    const liveRunner = new ChaosRunner({ fetchImpl: mockFetch });
    const report = await liveRunner.runExperiment({
      experimentId: 'globex-api-degradation',
      mode: 'live_probe',
    });

    assert.equal(report.mode, 'live_probe');
    assert.equal(report.status, 'completed');
    assert.equal(report.steady_states.before.probes[0].output.live_probed, true);
  });
});

describe('PerfOps ChaosToolkit HTTP API Server', () => {
  let serverInstance;
  let baseUrl;

  before(async () => {
    const started = await startServer(0);
    serverInstance = started.server;
    baseUrl = `http://127.0.0.1:${started.port}`;
  });

  after(async () => {
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
    }
  });

  it('GET /health returns service metadata', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      status: 'ok',
      service: 'perfops-chaostoolkit',
      version: '1.0.0',
    });
  });

  it('GET /api/v1/experiments returns all registered chaos experiments', async () => {
    const res = await fetch(`${baseUrl}/api/v1/experiments`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.count, 3);
    assert.equal(Array.isArray(body.experiments), true);
  });

  it('POST /api/v1/experiments/run executes experiment and records journal in GET /api/v1/runs', async () => {
    const runRes = await fetch(`${baseUrl}/api/v1/experiments/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        experiment_id: 'globex-api-degradation',
        mode: 'dry_run',
      }),
    });
    assert.equal(runRes.status, 200);
    const report = await runRes.json();
    assert.equal(report.experiment_id, 'globex-api-degradation');
    assert.equal(report.status, 'completed');
    assert.ok(report.resilience.score >= 85);

    const listRes = await fetch(`${baseUrl}/api/v1/runs`);
    assert.equal(listRes.status, 200);
    const runsBody = await listRes.json();
    assert.equal(runsBody.count, 1);
    assert.equal(runsBody.runs[0].run_id, report.run_id);
  });

  it('returns 404 for unknown experiment ID', async () => {
    const res = await fetch(`${baseUrl}/api/v1/experiments/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ experiment_id: 'non-existent-exp' }),
    });
    assert.equal(res.status, 404);
  });
});
