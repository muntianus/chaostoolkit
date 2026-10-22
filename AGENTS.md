# AGENTS.md — chaostoolkit

Org-wide rules: [`muntianus/.github/AGENT_POLICY.md`](https://github.com/muntianus/.github/blob/main/AGENT_POLICY.md)
and the [Repository Standard](https://github.com/muntianus/.github/blob/main/docs/standards/REPOSITORY_STANDARD.md).

## Repo-local rules

- **Zero dependencies.** Node ≥ 20 standard library only (`node:http`, `node:test`);
  adding an npm dependency needs an ADR.
- **Contract first.** A route change updates `ROUTES` in `src/server.js` and
  `docs/api/openapi.json` in the same commit; `tests/openapi-contract.test.js` fails on drift.
- **Config is env-only.** Every variable the code reads is listed in `.env.example`;
  never commit `.env`.
- **`GET /health` stays dependency-free** (liveness only).
- **Injection stays local by default.** `assertLocalTarget` (loopback or `CHAOS_ALLOWED_HOSTS`) and the demo-directory guard for `process_kill` are the safety model; any change to them needs tests proving production hosts and arbitrary scripts are still refused.
- Before pushing: `npm test`.
- Conventional commits; branch `feat/*` / `fix/*` / `chore/*`; never push to `main`.
