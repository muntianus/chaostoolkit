import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChaosRunner } from '../src/runner.js';
import { startServer } from '../src/server.js';
import { latencyAction, localExperiment, startLocalTarget } from './helpers/chaos-fixtures.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const STUB_FETCH = pathToFileURL(fileURLToPath(new URL('./helpers/stub-fetch.mjs', import.meta.url))).href;

function recordingFetch(calls) {
  return async (url, options) => {
    calls.push(String(url));
    return globalThis.fetch(url, options);
  };
}

async function withEnv(value, fn) {
  const previous = process.env.CHAOS_LIVE_ENABLED;
  if (value === undefined) delete process.env.CHAOS_LIVE_ENABLED;
  else process.env.CHAOS_LIVE_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CHAOS_LIVE_ENABLED;
    else process.env.CHAOS_LIVE_ENABLED = previous;
  }
}

async function postRun(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/experiments/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function getRuns(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/runs`);
  return res.json();
}

async function closeServer(started) {
  await new Promise((resolve) => started.server.close(resolve));
}

function runCli(args, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.CHAOS_LIVE_ENABLED;
  delete childEnv.CHAOS_ALLOWED_HOSTS;
  Object.assign(childEnv, env);
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', STUB_FETCH, 'src/cli.js', ...args],
      { cwd: REPO_ROOT, env: childEnv },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code : 0, stdout, stderr });
      },
    );
  });
}

describe('dry_run is the default execution mode', () => {
  it('runner: no mode means dry_run, even when live is authorised, and nothing is touched', async () => {
    const target = await startLocalTarget();
    try {
      const calls = [];
      const runner = new ChaosRunner({ liveEnabled: true, fetchImpl: recordingFetch(calls) });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [latencyAction(target.url, 150)]),
      });

      assert.equal(report.mode, 'dry_run');
      assert.equal(report.safety.dry_run, true);
      assert.equal(report.safety.injection_enabled, false);
      assert.equal(report.injection.real_injections, 0);
      assert.equal(report.run[0].simulated_only, true);
      assert.equal(report.run[0].network_touched, false);
      assert.equal(report.run[0].process_touched, false);
      assert.deepEqual(calls, []);
      assert.deepEqual(target.requests, []);
    } finally {
      await target.close();
    }
  });

  it('runner: no mode needs no kill switch (the default never throws)', async () => {
    const runner = new ChaosRunner({ liveEnabled: false });
    const report = await runner.runExperiment({ experimentId: 'globex-api-degradation' });
    assert.equal(report.mode, 'dry_run');
    assert.equal(report.status, 'completed');
  });

  it('runner: an unknown mode is still rejected as invalid', async () => {
    const runner = new ChaosRunner({ liveEnabled: true });
    await assert.rejects(
      () => runner.runExperiment({ experimentId: 'globex-api-degradation', mode: 'yolo' }),
      /Invalid execution mode/,
    );
  });

  it('API: POST without mode runs as dry_run and never contacts the target', async () => {
    const target = await startLocalTarget();
    const started = await startServer(0, { liveEnabled: true });
    try {
      const experiment = localExperiment(target.url, [latencyAction(target.url, 150)]);
      for (const body of [{ experiment }, { experiment, dry_run: true }]) {
        const { status, body: report } = await postRun(started.port, body);
        assert.equal(status, 200);
        assert.equal(report.mode, 'dry_run');
        assert.equal(report.safety.injection_enabled, false);
        assert.equal(report.run[0].simulated_only, true);
      }
      assert.deepEqual(target.requests, []);
    } finally {
      await closeServer(started);
      await target.close();
    }
  });

  it('CLI: no flags runs as dry_run and never calls fetch', async () => {
    const result = await runCli(['--experiment', 'globex-api-degradation']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, 'dry_run');
    assert.doesNotMatch(result.stderr, /STUB_FETCH_CALLED/);
  });

  it('CLI: CHAOS_LIVE_ENABLED=true alone does not turn the default into live', async () => {
    const result = await runCli(['--experiment', 'local-http-fault-injection'], {
      CHAOS_LIVE_ENABLED: 'true',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, 'dry_run');
    assert.doesNotMatch(result.stderr, /STUB_FETCH_CALLED/);
  });
});

describe('live_probe requires the CHAOS_LIVE_ENABLED kill switch', () => {
  it('runner: refuses live before any probe, injection or journal entry', async () => {
    const target = await startLocalTarget();
    try {
      for (const options of [{ liveEnabled: false }, {}]) {
        await withEnv(undefined, async () => {
          const calls = [];
          const runner = new ChaosRunner({ ...options, fetchImpl: recordingFetch(calls) });
          await assert.rejects(
            () =>
              runner.runExperiment({
                experiment: localExperiment(target.url, [latencyAction(target.url, 150)]),
                mode: 'live_probe',
              }),
            (err) =>
              err.code === 'LIVE_MODE_DISABLED' &&
              err.name === 'LiveModeDisabledError' &&
              /CHAOS_LIVE_ENABLED/.test(err.message),
          );
          assert.deepEqual(calls, [], 'fetch must not be called');
          assert.deepEqual(runner.listRuns(), [], 'a refused run must not be journaled');
        });
      }
      assert.deepEqual(target.requests, [], 'target must not receive any request');
    } finally {
      await target.close();
    }
  });

  it('runner: only an explicit "true" authorises live', async () => {
    const accepted = ['true', 'TRUE', ' true '];
    const refused = ['false', '0', '1', 'yes', 'on', 'enabled', ''];
    for (const value of accepted) {
      await withEnv(value, async () => {
        assert.equal(new ChaosRunner().liveEnabled, true, `value ${JSON.stringify(value)}`);
      });
    }
    for (const value of refused) {
      await withEnv(value, async () => {
        assert.equal(new ChaosRunner().liveEnabled, false, `value ${JSON.stringify(value)}`);
      });
    }
    await withEnv(undefined, async () => {
      assert.equal(new ChaosRunner().liveEnabled, false);
    });
  });

  it('runner: the switch is process configuration; a request cannot enable it', async () => {
    const target = await startLocalTarget();
    try {
      const calls = [];
      const runner = new ChaosRunner({ liveEnabled: false, fetchImpl: recordingFetch(calls) });
      await assert.rejects(
        () =>
          runner.runExperiment({
            experiment: localExperiment(target.url, [latencyAction(target.url, 150)]),
            mode: 'live_probe',
            liveEnabled: true,
            overrides: { liveEnabled: true, live_enabled: true, allow_live: true },
          }),
        (err) => err.code === 'LIVE_MODE_DISABLED',
      );
      assert.deepEqual(calls, []);
      assert.deepEqual(target.requests, []);
    } finally {
      await target.close();
    }
  });

  it('runner: live runs with the switch on and a loopback target on the allowlist', async () => {
    const target = await startLocalTarget();
    try {
      const calls = [];
      const runner = new ChaosRunner({
        liveEnabled: true,
        allowedHosts: ['127.0.0.1'],
        fetchImpl: recordingFetch(calls),
      });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [latencyAction(target.url, 150)]),
        mode: 'live_probe',
      });

      assert.equal(report.mode, 'live_probe');
      assert.equal(report.status, 'completed');
      assert.equal(report.safety.injection_enabled, true);
      assert.equal(report.run[0].simulated_only, false);
      assert.equal(report.run[0].network_touched, true);
      assert.ok(calls.length > 0, 'live probes must use the network');
      assert.ok(target.requests.length > 0, 'target must have been contacted');
    } finally {
      await target.close();
    }
  });

  it('runner: the switch is read from the environment when no option is given', async () => {
    const target = await startLocalTarget();
    try {
      await withEnv('true', async () => {
        const runner = new ChaosRunner({ allowedHosts: ['127.0.0.1'] });
        const report = await runner.runExperiment({
          experiment: localExperiment(target.url, [latencyAction(target.url, 150)]),
          mode: 'live_probe',
        });
        assert.equal(report.mode, 'live_probe');
        assert.equal(report.status, 'completed');
      });
    } finally {
      await target.close();
    }
  });

  it('runner: the switch does not relax the host allowlist', async () => {
    const target = await startLocalTarget();
    try {
      const calls = [];
      const runner = new ChaosRunner({ liveEnabled: true, fetchImpl: recordingFetch(calls) });
      const report = await runner.runExperiment({
        experiment: localExperiment(target.url, [
          latencyAction('http://internal.example.test:9', 250),
        ]),
        mode: 'live_probe',
      });

      assert.equal(report.status, 'failed');
      assert.equal(report.injection.blocked, 1);
      assert.equal(report.run[0].status, 'blocked');
      assert.equal(report.run[0].error, 'TARGET_NOT_ALLOWED');
      assert.equal(
        calls.some((url) => url.includes('internal.example.test')),
        false,
        `non-allowlisted target was contacted: ${calls.join(', ')}`,
      );
    } finally {
      await target.close();
    }
  });

  it('API: live_probe without the switch is 403 LIVE_MODE_DISABLED and touches nothing', async () => {
    const target = await startLocalTarget();
    const started = await startServer(0, { liveEnabled: false });
    try {
      const experiment = localExperiment(target.url, [latencyAction(target.url, 150)]);
      const attempts = [
        { experiment, mode: 'live_probe' },
        { experiment, dry_run: false },
        { experiment, mode: 'live_probe', live_enabled: true, overrides: { live_enabled: true } },
      ];
      for (const body of attempts) {
        const { status, body: payload } = await postRun(started.port, body);
        assert.equal(status, 403, JSON.stringify(body));
        assert.equal(payload.code, 'LIVE_MODE_DISABLED');
        assert.match(payload.error, /CHAOS_LIVE_ENABLED/);
      }
      assert.deepEqual(target.requests, [], 'target must not receive any request');
      assert.equal((await getRuns(started.port)).count, 0, 'refused runs are not journaled');
    } finally {
      await closeServer(started);
      await target.close();
    }
  });

  it('API: live_probe runs when the switch is on; dry_run:false requests live explicitly', async () => {
    const target = await startLocalTarget();
    const started = await startServer(0, { liveEnabled: true, allowedHosts: ['127.0.0.1'] });
    try {
      const experiment = localExperiment(target.url, [latencyAction(target.url, 150)]);
      for (const body of [
        { experiment, mode: 'live_probe' },
        { experiment, dry_run: false },
      ]) {
        const { status, body: report } = await postRun(started.port, body);
        assert.equal(status, 200, JSON.stringify(body));
        assert.equal(report.mode, 'live_probe');
        assert.equal(report.status, 'completed');
      }
      assert.ok(target.requests.length > 0);
    } finally {
      await closeServer(started);
      await target.close();
    }
  });

  it('CLI: --live without the switch exits 3, prints no report and never calls fetch', async () => {
    const result = await runCli(['--experiment', 'local-http-fault-injection', '--live']);
    assert.equal(result.code, 3, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /LIVE_MODE_DISABLED/);
    assert.match(result.stderr, /CHAOS_LIVE_ENABLED/);
    assert.doesNotMatch(result.stderr, /STUB_FETCH_CALLED/);
  });

  it('CLI: --live with the switch on passes the gate and reaches the (stubbed) network', async () => {
    const result = await runCli(['--experiment', 'local-http-fault-injection', '--live'], {
      CHAOS_LIVE_ENABLED: 'true',
    });
    assert.notEqual(result.code, 3, result.stderr);
    assert.doesNotMatch(result.stderr, /LIVE_MODE_DISABLED/);
    assert.match(result.stderr, /STUB_FETCH_CALLED/);
  });

  it('CLI: --live together with --dry-run is a usage error', async () => {
    const result = await runCli(['--experiment', 'globex-api-degradation', '--live', '--dry-run']);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /STUB_FETCH_CALLED/);
  });
});

describe('documented configuration', () => {
  it('.env.example lists CHAOS_LIVE_ENABLED and leaves it off', () => {
    const env = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    assert.match(env, /^CHAOS_LIVE_ENABLED=false$/m);
  });
});
