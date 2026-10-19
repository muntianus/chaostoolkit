# PerfOps ChaosToolkit — Resilience & Fault Injection Service

Chaos Engineering Experiment Runner, Steady-State Hypothesis Verifier, and LaunchGate Resilience Scoring API for the **PerfOps** ecosystem (`api.globlex.pro`, `aco.perfops.shop`, and `launchgate-core`).

## Features

- **Declarative ChaosToolkit Experiments (`experiments/*.json`)**:
  - `globex-api-degradation`: Verifies steady-state health & graceful fallback resilience of `globlex.pro` / `api.globlex.pro` under simulated `+250ms` CBR/DaData upstream timeout and PostgreSQL connection pool saturation (`92%`).
  - `vps-cgroup-memory-pressure`: Verifies Docker container `unless-stopped` restart policies and cgroup v2 OOM memory headroom across `ops-grafana`, `ops-cadvisor`, and `globex-backend-1`.
  - `caddy-zero-downtime-reload`: Verifies zero dropped HTTP requests during Caddy config reload and `@perfops_bot` anti-flapping debounce window (`15s`).
  - `local-http-fault-injection`: Real `http_latency` + `http_error` injection against the loopback demo target; safe in CI and locally.
- **Real local fault injection (`src/faults.js`)**:
  - `http_latency` — in-process HTTP proxy that adds configurable latency/jitter and measures the real baseline-vs-injected delta.
  - `http_error` — proxy that returns `5xx` or destroys the socket to simulate a timeout.
  - `process_kill` — spawns a repository-local demo script and terminates that child with `SIGTERM` (`SIGKILL` fallback). It never signals processes it did not spawn.
- **Steady-state effect verification**:
  - Each real injection must declare (or inherit a default) `expected_effect`. If the injected metric does not deviate as expected, the run is `failed`, the LaunchGate verdict is `INJECTION_NOT_VERIFIED`, and promotion is blocked.
  - Live HTTP probes are strict by default: an unreachable target is a failed probe, not a simulated pass.
- **Safety guard**:
  - Real injection targets must be loopback (`localhost`, `127.0.0.0/8`, `::1`) or explicitly listed in `CHAOS_ALLOWED_HOSTS`.
  - Owned production domains (`globlex.pro`, `perfops.tech`, `perfops.shop` and their subdomains) are denied even if allowlisted.
  - `process_kill` scripts are restricted to `demo/` and `tests/fixtures/` inside this repository.
- **Dual Execution Modes (`src/runner.js`)**:
  - `live_probe` (default): executes real injection actions and live steady-state probes.
  - `dry_run`: deterministic simulation for CI/CD gates. Selected explicitly with `--dry-run`; never touches the network or a child process.
- **LaunchGate Integration**:
  - Calculates a composite **Resilience Score (`0–100`)**, grade (`A–F`), MTTR budget adherence, and `PASS` / `BLOCK` recommendation for `launchgate-core`.

## HTTP API (`src/server.js`, default `PORT=4060`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns `{"status":"ok","service":"perfops-chaostoolkit","version":"1.0.0"}` |
| `GET` | `/api/v1/experiments` | Lists all registered chaos experiments and steady-state hypotheses |
| `POST` | `/api/v1/experiments/run` | Runs a named (`experiment_id`) or custom (`experiment`) chaos experiment. Defaults to `live_probe`; pass `"mode":"dry_run"` (or `"dry_run":true`) for simulation |
| `GET` | `/api/v1/runs` | Lists executed experiment journals and resilience reports |

## Quick Start

```bash
# Run tests
npm test
# or
node --test tests/chaos.test.js

# Start the API server (default port 4060)
npm start

# Explicit legacy simulation (no network, no injections)
npm run chaos -- --experiment globex-api-degradation --dry-run

# Real local injection is the default; production targets are blocked
node src/cli.js --experiment globex-api-degradation || echo "blocked as expected"

# Trigger an experiment run through the API (simulation)
curl -s -X POST http://localhost:4060/api/v1/experiments/run \
  -H "Content-Type: application/json" \
  -d '{"experiment_id":"globex-api-degradation","mode":"dry_run"}' | jq .

# Start the local demo target used by process_kill / local experiments
npm run demo:service -- --port 4061

# Run the real localhost experiment (latency + 5xx injection)
npm run chaos -- --experiment local-http-fault-injection
```

## Real Injection Actions

Custom experiments use the standard ChaosToolkit `method`/`provider` shape. Only
the following `provider.func` values are executed in `live_probe` mode; any other
action fails the run instead of being reported as a simulated success.

```json
{
  "type": "action",
  "name": "inject-http-latency-150ms",
  "provider": {
    "type": "fault_injection",
    "func": "http_latency",
    "arguments": {
      "target_url": "http://127.0.0.1:4061/health",
      "latency_ms": 150,
      "jitter_ms": 20,
      "samples": 5
    }
  },
  "expected_effect": { "metric": "latency_delta_ms", "min": 100 }
}
```

| Action | Arguments | Default effect check |
| --- | --- | --- |
| `http_latency` | `target_url`, `latency_ms`, `jitter_ms`, `samples`, `timeout_ms` | `latency_delta_ms >= max(10, latency_ms / 2)` |
| `http_error` | `target_url`, `status_code` (500–599), `error_mode` (`status`/`timeout`), `timeout_ms`, `samples` | `error_rate >= 0.9` |
| `process_kill` | `script` (under `demo/` or `tests/fixtures/`), `args`, `grace_ms`, `wait_for_stdout` | `exited === true` |

`expected_effect` can be placed on the action or inside `provider.arguments`. If
the metric does not reach the declared bounds, the action is `failed`, the run
status is `failed`, and `launchgate_report.recommendation` is `BLOCK`.

## Safety Model & Limitations

- Real injection is restricted to loopback unless `CHAOS_ALLOWED_HOSTS` contains
  an explicit hostname (comma-separated, `*.example.test` wildcards supported).
  The allowlist is process configuration only; per-request `overrides` cannot
  widen it.
- `process_kill` only spawns Node demo scripts from `demo/` or `tests/fixtures/`
  and only signals the child it created. It never accepts a PID or a shell command.
- This implementation uses an in-process HTTP proxy rather than `tc`/`toxiproxy`,
  so it is portable to macOS and GitHub-hosted runners. A proxy fault is scoped
  to the action's measurement window and then removed; it does not alter host
  networking, cgroups, Docker, or database pools.
- Catalog experiments that reference production hosts are intentionally blocked
  in `live_probe` mode. Use `--dry-run` for their legacy simulation, or author a
  localhost experiment for real injection.
- Live metric probes (Docker/cgroup/alert-gate) are not implemented as real
  collectors; only HTTP probes and the three actions above perform real I/O.

## Contact / Support

PerfOps official Telegram contact: [@perfops_ai_manager](https://t.me/perfops_ai_manager).

For security vulnerabilities, use private vulnerability reporting rather than public Telegram messages.
