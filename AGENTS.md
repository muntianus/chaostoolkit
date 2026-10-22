# AGENTS.md — chaostoolkit

> Canon: `~/github/vault/personal/agent-config/AGENTS.md`
> Org policy: [`muntianus/.github/AGENT_POLICY.md`](https://github.com/muntianus/.github/blob/main/AGENT_POLICY.md) ·
> [Repository Standard](https://github.com/muntianus/.github/blob/main/docs/standards/REPOSITORY_STANDARD.md)

## Repo-local rules

- **Zero dependencies.** Node ≥ 20 standard library only (`node:http`, `node:test`);
  adding an npm dependency needs an ADR.
- **Contract first.** A route change updates `ROUTES` in `src/server.js` and
  `docs/api/openapi.json` in the same commit; `tests/openapi-contract.test.js` fails on drift.
- **Config is env-only.** Every variable the code reads is listed in `.env.example`;
  never commit `.env`.
- **`GET /health` stays dependency-free** (liveness only).
- **Dry-run by default; live needs the kill switch.** `mode` defaults to `dry_run` in `src/runner.js`, `src/server.js` and `src/cli.js`. `live_probe` is refused (`LiveModeDisabledError`, HTTP 403 `LIVE_MODE_DISABLED`, CLI exit 3) unless `CHAOS_LIVE_ENABLED=true` is set in the process environment, and the check runs before any probe, injection or child process. Never read the switch from a request body, `overrides` or a flag; any change to this gate needs tests proving a refused run touches nothing.
- **Injection stays local by default.** `assertLocalTarget` (loopback or `CHAOS_ALLOWED_HOSTS`) and the demo-directory guard for `process_kill` are the safety model (on top of the kill switch above); any change to them needs tests proving production hosts and arbitrary scripts are still refused.
- Before pushing: `npm test`.
- Conventional commits; branch `feat/*` / `fix/*` / `chore/*`; never push to `main`.
