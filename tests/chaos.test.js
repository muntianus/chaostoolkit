import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ChaosRunner } from '../src/runner.js';
import { startServer } from '../src/server.js';
import {
  assertLocalTarget,
  injectHttpError,
  injectHttpLatency,
  killDemoProcess,
} from '../src/faults.js';
import { latencyAction, localExperiment, startLocalTarget } from './helpers/chaos-fixtures.js';

describe('PerfOps ChaosToolkit Runner & Experiment Catalog', () => {
  const runner = new ChaosRunner();

  it('lists all 4 registered chaos experiments with steady-state hypotheses', () => {
    const experiments = runner.listExperiments();
    assert.equal(experiments.length, 4);
    const ids = experiments.map((e) => e.id).sort();
    assert.deepEqual(ids, [
      'caddy-zero-downtime-reload',
      'globex-api-degradation',
      'local-http-fault-injection',
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
    assert.equal(report.safety.dry_run, true);
    assert.equal(report.safety.injection_enabled, false);
    assert.equal(
      report.run.filter((step) => step.type === 'action').every((step) => step.simulated_only === true),
      true,
    );
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
    const liveRunner = new ChaosRunner({ liveEnabled: true, fetchImpl: mockFetch });
    const report = await liveRunner.runExperiment({
      experiment: {
        id: 'custom-live-probe',
        title: 'Custom live probe',
        'steady-state-hypothesis': {
          title: 'Endpoint answers 200',
          probes: [
            {
              type: 'probe',
              name: 'custom-health',
              tolerance: { type: 'status', status: 200 },
              provider: { type: 'http', url: 'http://127.0.0.1:9/health', timeout: 500 },
            },
          ],
        },
        method: [],
        rollbacks: [],
      },
      mode: 'live_probe',
    });

    assert.equal(report.mode, 'live_probe');
    assert.equal(report.status, 'completed');
    assert.equal(report.steady_states.before.probes[0].output.live_probed, true);
  });

  it('fails a live probe instead of silently falling back to simulation', async () => {
    const offlineRunner = new ChaosRunner({
      liveEnabled: true,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    const report = await offlineRunner.runExperiment({
      experiment: {
        id: 'custom-offline-probe',
        title: 'Offline live probe',
        'steady-state-hypothesis': {
          title: 'Endpoint answers 200',
          probes: [
            {
              type: 'probe',
              name: 'offline-health',
              tolerance: { type: 'status', status: 200 },
              provider: {
                type: 'http',
                url: 'http://127.0.0.1:9/health',
                timeout: 500,
                simulation: { before: { status: 200, latency_ms: 5 } },
              },
            },
          ],
        },
        method: [],
        rollbacks: [],
      },
      mode: 'live_probe',
    });

    assert.equal(report.status, 'aborted');
    assert.equal(report.steady_states.before.steady_state_met, false);
    assert.equal(report.steady_states.before.probes[0].tolerance_met, false);
    assert.match(report.steady_states.before.probes[0].tolerance_reason, /Live HTTP probe failed/);
  });
});

describe('PerfOps ChaosToolkit real fault injection', () => {
  it('http_latency really increases latency and verifies the expected effect', async () => {
    const target = await startLocalTarget();
    try {
      const runner = new ChaosRunner({ liveEnabled: true, fetchImpl: globalThis.fetch });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [latencyAction(target.url, 150)]),
        mode: 'live_probe',
      });

      assert.equal(report.status, 'completed');
      assert.equal(report.injection.verified, true);
      assert.equal(report.injection.real_injections, 1);
      assert.equal(report.launchgate_report.recommendation, 'PASS');

      const action = report.run[0];
      assert.equal(action.status, 'succeeded');
      assert.equal(action.simulated_only, false);
      assert.equal(action.network_touched, true);
      assert.equal(action.effect_verified, true);
      assert.equal(action.output.injection, 'http_latency');
      assert.ok(action.output.latency_delta_ms >= 100, `delta=${action.output.latency_delta_ms}`);
      assert.ok(action.output.injected_latency_ms >= 150);
      assert.equal(action.output.target_guard, 'loopback');
    } finally {
      await target.close();
    }
  });

  it('http_error injects 5xx responses and observes request errors', async () => {
    const target = await startLocalTarget();
    try {
      const runner = new ChaosRunner({ liveEnabled: true, fetchImpl: globalThis.fetch });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [
          {
            type: 'action',
            name: 'inject-http-503',
            provider: {
              type: 'fault_injection',
              func: 'http_error',
              arguments: {
                target_url: `${target.url}/health`,
                status_code: 503,
                samples: 3,
              },
            },
          },
        ]),
        mode: 'live_probe',
      });

      assert.equal(report.status, 'completed');
      assert.equal(report.injection.verified, true);
      const action = report.run[0];
      assert.equal(action.status, 'succeeded');
      assert.equal(action.effect_verified, true);
      assert.equal(action.output.injection, 'http_error');
      assert.equal(action.output.error_rate, 1);
      assert.deepEqual(action.output.statuses, [503, 503, 503]);
      assert.ok(action.output.failed_samples >= 3);
    } finally {
      await target.close();
    }
  });

  it('blocks external/production targets before any network call', async () => {
    const target = await startLocalTarget();
    const requestedUrls = [];
    try {
      const runner = new ChaosRunner({
        liveEnabled: true,
        fetchImpl: async (url, options) => {
          requestedUrls.push(String(url));
          return globalThis.fetch(url, options);
        },
      });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [
          latencyAction('https://api.globlex.pro', 250),
        ]),
        mode: 'live_probe',
      });

      assert.equal(report.status, 'failed');
      assert.equal(report.deviated, true);
      assert.equal(report.injection.verified, false);
      assert.equal(report.injection.blocked, 1);
      assert.equal(report.resilience.verdict, 'INJECTION_NOT_VERIFIED');
      assert.equal(report.launchgate_report.recommendation, 'BLOCK');

      const action = report.run[0];
      assert.equal(action.status, 'blocked');
      assert.equal(action.error, 'TARGET_NOT_ALLOWED');
      assert.match(action.error_message, /Refusing real fault injection/);
      assert.match(action.error_message, /production domain/);
      assert.equal(
        requestedUrls.some((url) => url.includes('globex')),
        false,
        `external target was contacted: ${requestedUrls.join(', ')}`,
      );
    } finally {
      await target.close();
    }
  });

  it('dry_run never touches the network or a child process', async () => {
    const runner = new ChaosRunner({
      fetchImpl: async () => {
        throw new Error('network must not be touched in dry_run');
      },
    });
    const report = await runner.runExperiment({
      experiment: {
        id: 'dry-run-isolation',
        title: 'Dry-run isolation',
        'steady-state-hypothesis': {
          title: 'Simulated health',
          probes: [
            {
              type: 'probe',
              name: 'simulated-health',
              tolerance: { type: 'status', status: 200 },
              provider: {
                type: 'http',
                url: 'http://127.0.0.1:9/health',
                simulation: {
                  before: { status: 200, latency_ms: 5 },
                  after: { status: 200, latency_ms: 5 },
                },
              },
            },
          ],
        },
        method: [latencyAction('http://127.0.0.1:9', 500)],
        rollbacks: [],
      },
      mode: 'dry_run',
    });

    assert.equal(report.status, 'completed');
    assert.equal(report.safety.dry_run, true);
    assert.equal(report.injection.real_injections, 0);
    assert.equal(report.run[0].simulated_only, true);
    assert.equal(report.run[0].network_touched, false);
    assert.equal(report.run[0].process_touched, false);
    assert.equal(report.run[0].effect_verified, null);
  });

  it('fails the experiment when injection produces no expected deviation', async () => {
    const target = await startLocalTarget();
    try {
      const runner = new ChaosRunner({ liveEnabled: true, fetchImpl: globalThis.fetch });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [
          latencyAction(target.url, 5, {
            expected_effect: { metric: 'latency_delta_ms', min: 100 },
          }),
        ]),
        mode: 'live_probe',
      });

      assert.equal(report.status, 'failed');
      assert.equal(report.deviated, true);
      assert.equal(report.injection.verified, false);
      assert.equal(report.resilience.verdict, 'INJECTION_NOT_VERIFIED');
      assert.equal(report.resilience.score, 30);
      assert.equal(report.launchgate_report.recommendation, 'BLOCK');

      const action = report.run[0];
      assert.equal(action.status, 'failed');
      assert.equal(action.error, 'expected_effect_not_observed');
      assert.equal(action.effect_verified, false);
    } finally {
      await target.close();
    }
  });

  it('process_kill terminates only the child process spawned by the runner', async () => {
    const target = await startLocalTarget();
    try {
      const runner = new ChaosRunner({ liveEnabled: true, fetchImpl: globalThis.fetch });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [
          {
            type: 'action',
            name: 'kill-local-demo-service',
            provider: {
              type: 'fault_injection',
              func: 'process_kill',
              arguments: {
                script: 'demo/local-service.js',
                args: ['--port', '0'],
                wait_for_stdout: 'READY',
                grace_ms: 2000,
              },
            },
          },
        ]),
        mode: 'live_probe',
      });

      assert.equal(report.status, 'completed');
      assert.equal(report.injection.verified, true);
      const action = report.run[0];
      assert.equal(action.status, 'succeeded');
      assert.equal(action.effect_verified, true);
      assert.equal(action.output.injection, 'process_kill');
      assert.equal(action.output.exited, true);
      assert.equal(action.output.signal_sent, true);
      assert.equal(action.output.ready, true);
      assert.ok(action.output.pid > 0);
      assert.equal(action.output.process_touched, true);
    } finally {
      await target.close();
    }
  });

  it('rejects process scripts outside demo/fixture directories', async () => {
    await assert.rejects(
      () => killDemoProcess({ script: 'package.json', wait_for_stdout: false }),
      /outside the allowed demo directories/,
    );
  });

  it('allows explicit allowlisted internal hosts but still rejects prod domains', () => {
    const guarded = assertLocalTarget('http://internal.example.test:8080/health', {
      allowedHosts: ['internal.example.test'],
    });
    assert.equal(guarded.reason, 'allowlist');
    assert.throws(
      () => assertLocalTarget('https://api.globlex.pro/health'),
      /production domain/,
    );
    assert.throws(
      () =>
        assertLocalTarget('https://api.globlex.pro/health', {
          allowedHosts: ['api.globlex.pro'],
        }),
      (err) => err.code === 'TARGET_NOT_ALLOWED' && /production domain/.test(err.message),
    );
    assert.throws(
      () =>
        assertLocalTarget('https://evil.example/health', {
          allowedHosts: ['internal.example.test'],
        }),
      /only localhost\/allowlist targets are allowed/,
    );
  });

  it('does not run unsupported legacy actions as simulated successes in live mode', async () => {
    const target = await startLocalTarget();
    try {
      const runner = new ChaosRunner({ liveEnabled: true, fetchImpl: globalThis.fetch });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [
          {
            type: 'action',
            name: 'legacy-upstream-latency',
            provider: {
              type: 'fault_injection',
              func: 'inject_upstream_latency',
              arguments: { targets: ['cbr.ru'], latency_ms: 250 },
            },
          },
        ]),
        mode: 'live_probe',
      });

      assert.equal(report.status, 'failed');
      assert.equal(report.injection.verified, false);
      assert.equal(report.run[0].status, 'failed');
      assert.equal(report.run[0].simulated_only, false);
      assert.equal(report.run[0].error, 'unsupported_fault_action');
    } finally {
      await target.close();
    }
  });

  it('measures latency and errors through the injectors directly', async () => {
    const target = await startLocalTarget();
    try {
      const latency = await injectHttpLatency({
        targetUrl: `${target.url}/health`,
        latencyMs: 120,
        samples: 2,
      });
      assert.ok(latency.latency_delta_ms >= 80, `delta=${latency.latency_delta_ms}`);
      assert.equal(latency.target_guard, 'loopback');
      assert.equal(latency.network_touched, true);

      const errors = await injectHttpError({
        targetUrl: `${target.url}/health`,
        statusCode: 502,
        samples: 2,
      });
      assert.equal(errors.error_rate, 1);
      assert.deepEqual(errors.statuses, [502, 502]);

      const timeouts = await injectHttpError({
        targetUrl: `${target.url}/health`,
        errorMode: 'timeout',
        timeoutMs: 150,
        samples: 2,
      });
      assert.equal(timeouts.error_mode, 'timeout');
      assert.equal(timeouts.error_rate, 1);
      assert.ok(timeouts.errors.length >= 1);
    } finally {
      await target.close();
    }
  });
});

describe('PerfOps ChaosToolkit HTTP API Server', () => {
  let serverInstance;
  let baseUrl;
  let target;

  before(async () => {
    target = await startLocalTarget();
    const started = await startServer(0);
    serverInstance = started.server;
    baseUrl = `http://127.0.0.1:${started.port}`;
  });

  after(async () => {
    if (serverInstance) {
      await new Promise((resolve) => serverInstance.close(resolve));
    }
    if (target) {
      await target.close();
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
    assert.equal(body.count, 4);
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

  it('blocks external targets through the API when live mode is authorised', async () => {
    const live = await startServer(0, { liveEnabled: true });
    try {
      const experiment = localExperiment(target.url, [
        latencyAction('https://api.globlex.pro', 250),
      ]);
      const res = await fetch(`http://127.0.0.1:${live.port}/api/v1/experiments/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ experiment, mode: 'live_probe' }),
      });
      assert.equal(res.status, 200);
      const report = await res.json();
      assert.equal(report.mode, 'live_probe');
      assert.equal(report.status, 'failed');
      assert.equal(report.injection.blocked, 1);
      assert.equal(report.launchgate_report.recommendation, 'BLOCK');
    } finally {
      await new Promise((resolve) => live.server.close(resolve));
    }
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
