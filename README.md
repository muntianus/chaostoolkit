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
  - Dry-run is the default everywhere (runner, HTTP API, CLI). Live injection (`live_probe`) is refused unless the operator sets `CHAOS_LIVE_ENABLED=true` in the service environment.
  - Real injection targets must be loopback (`localhost`, `127.0.0.0/8`, `::1`) or explicitly listed in `CHAOS_ALLOWED_HOSTS`.
  - Owned production domains (`globlex.pro`, `perfops.tech`, `perfops.shop` and their subdomains) are denied even if allowlisted.
  - `process_kill` scripts are restricted to `demo/` and `tests/fixtures/` inside this repository.
- **Dual Execution Modes (`src/runner.js`)**:
  - `dry_run` (default): deterministic simulation for CI/CD gates. Never touches the network or a child process.
  - `live_probe` (opt-in): executes real injection actions and live steady-state probes. Needs an explicit request (`"mode":"live_probe"`, `"dry_run":false` or CLI `--live`) **and** `CHAOS_LIVE_ENABLED=true`; otherwise it is refused before any probe, injection or child process (HTTP `403` / `LIVE_MODE_DISABLED`, CLI exit `3`).
- **LaunchGate Integration**:
  - Calculates a composite **Resilience Score (`0–100`)**, grade (`A–F`), MTTR budget adherence, and `PASS` / `BLOCK` recommendation for `launchgate-core`.

## HTTP API (`src/server.js`, default `PORT=4060`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns `{"status":"ok","service":"perfops-chaostoolkit","version":"1.0.0"}` |
| `GET` | `/api/v1/experiments` | Lists all registered chaos experiments and steady-state hypotheses |
| `POST` | `/api/v1/experiments/run` | Runs a named (`experiment_id`) or custom (`experiment`) chaos experiment. Defaults to `dry_run`. `"mode":"live_probe"` (or `"dry_run":false`) is refused with `403 {"code":"LIVE_MODE_DISABLED"}` unless the service runs with `CHAOS_LIVE_ENABLED=true` |
| `GET` | `/api/v1/runs` | Lists executed experiment journals and resilience reports |

## Quick Start

```bash
# Run tests
npm test
# or
node --test tests/chaos.test.js

# Start the API server (default port 4060)
npm start

# Simulation is the default (no network, no injections); --dry-run is accepted as an explicit no-op
npm run chaos -- --experiment globex-api-degradation

# Live injection needs --live AND the kill switch. Without it: exit code 3, nothing is touched.
node src/cli.js --experiment globex-api-degradation --live || echo "refused (exit $?)"

# Trigger an experiment run through the API (simulation by default)
curl -s -X POST http://localhost:4060/api/v1/experiments/run \
  -H "Content-Type: application/json" \
  -d '{"experiment_id":"globex-api-degradation"}' | jq .

# Start the local demo target used by process_kill / local experiments
npm run demo:service -- --port 4061

# Run the real localhost experiment (latency + 5xx injection): opt-in twice
CHAOS_LIVE_ENABLED=true npm run chaos -- --experiment local-http-fault-injection --live
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

- **Dry-run by default, live by explicit authorisation.** `mode` defaults to
  `dry_run` in the runner, the HTTP API and the CLI. `live_probe` additionally needs
  the process-level kill switch `CHAOS_LIVE_ENABLED=true` (only the literal `true`
  counts). Without it a live request is refused before any probe, injection or
  child process: HTTP `403` with `code: "LIVE_MODE_DISABLED"`, CLI exit code `3`,
  and nothing is journaled. The switch is environment-only; a request body,
  `overrides` or CLI flag cannot enable it. The host allowlist below is an
  additional gate, not a substitute.
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
  in `live_probe` mode. Their default `dry_run` simulation is unaffected; author a
  localhost experiment for real injection.
- The target guard covers fault *injections*. Live steady-state HTTP probes are plain
  `GET`s against the experiment's `provider.url` and are not yet filtered by it, so
  only enable `CHAOS_LIVE_ENABLED` for experiments whose probe URLs you trust.
- Live metric probes (Docker/cgroup/alert-gate) are not implemented as real
  collectors; only HTTP probes and the three actions above perform real I/O.

## API contract, CI & deploy

- **Contract:** [`docs/api/openapi.json`](docs/api/openapi.json) (OpenAPI 3.1).
  `tests/openapi-contract.test.js` fails when `ROUTES` in `src/server.js` and the spec disagree.
- **Tests:** `npm test` — Node's built-in runner, no dependencies. CI runs it on every pull request;
  GitGuardian scans each one for secrets.
- **Config:** every environment variable is listed in [`.env.example`](.env.example).
- **Deploy:** `docker build -t chaostoolkit . && docker run -p 4060:4060 chaostoolkit` — `node:22-alpine`,
  non-root, `HEALTHCHECK` on `GET /health`. The portfolio port map lives in
  [`muntianus/architecture`](https://github.com/muntianus/architecture).

## Contact / Support

PerfOps official Telegram contact: [@perfops_ai_manager](https://t.me/perfops_ai_manager).

For security vulnerabilities, use private vulnerability reporting rather than public Telegram messages.
