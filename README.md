# PerfOps ChaosToolkit — Resilience & Fault Injection Service

Chaos Engineering Experiment Runner, Steady-State Hypothesis Verifier, and LaunchGate Resilience Scoring API for the **PerfOps** ecosystem (`api.globlex.pro`, `aco.perfops.shop`, and `launchgate-core`).

## Features

- **Declarative ChaosToolkit Experiments (`experiments/*.json`)**:
  - `globex-api-degradation`: Verifies steady-state health & graceful fallback resilience of `globlex.pro` / `api.globlex.pro` under simulated `+250ms` CBR/DaData upstream timeout and PostgreSQL connection pool saturation (`92%`).
  - `vps-cgroup-memory-pressure`: Verifies Docker container `unless-stopped` restart policies and cgroup v2 OOM memory headroom across `ops-grafana`, `ops-cadvisor`, and `globex-backend-1`.
  - `caddy-zero-downtime-reload`: Verifies zero dropped HTTP requests during Caddy config reload and `@perfops_bot` anti-flapping debounce window (`15s`).
- **Dual Execution Modes (`src/runner.js`)**:
  - `dry_run`: Deterministic simulation mode for CI/CD gates and pre-release resilience verification.
  - `live_probe`: Executes real HTTP steady-state probes against target endpoints while measuring MTTR and tolerance compliance.
- **LaunchGate Integration**:
  - Calculates a composite **Resilience Score (`0–100`)**, grade (`A–F`), MTTR budget adherence, and `PASS` / `BLOCK` recommendation for `launchgate-core`.

## HTTP API (`src/server.js`, default `PORT=4060`)

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Returns `{"status":"ok","service":"perfops-chaostoolkit","version":"1.0.0"}` |
| `GET` | `/api/v1/experiments` | Lists all registered chaos experiments and steady-state hypotheses |
| `POST` | `/api/v1/experiments/run` | Runs a named (`experiment_id`) or custom (`experiment`) chaos experiment in `dry_run` or `live_probe` mode |
| `GET` | `/api/v1/runs` | Lists executed experiment journals and resilience reports |

## Quick Start

```bash
# Run tests
npm test
# or
node --test tests/chaos.test.js

# Start the API server (default port 4060)
npm start

# Trigger an experiment run
curl -s -X POST http://localhost:4060/api/v1/experiments/run \
  -H "Content-Type: application/json" \
  -d '{"experiment_id":"globex-api-degradation","mode":"dry_run"}' | jq .
```
