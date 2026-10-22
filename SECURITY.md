# Security Policy

chaostoolkit is an internal PerfOps microservice (default port 4060).

- **Report a vulnerability:** open a private security advisory on this repo
  (GitHub → Security → Advisories) or contact the owner listed in
  [`muntianus/.github`](https://github.com/muntianus/.github/blob/main/SECURITY.md).
- **Secrets:** none are required. Never commit `.env`; only `.env.example`
  (placeholder values) is tracked. GitGuardian scans every pull request for
  secrets.
- `POST /api/v1/experiments/run` simulates (`dry_run`) by default and performs **real** fault injection only when the request asks for `live_probe` **and** the service runs with `CHAOS_LIVE_ENABLED=true` (otherwise 403 `LIVE_MODE_DISABLED`). The API is unauthenticated, so leave the switch unset unless the service is loopback-only. Targets are limited to loopback (plus `CHAOS_ALLOWED_HOSTS`) and `process_kill` only spawns scripts from the bundled demo directories — keep the service on loopback and never add production hosts to the allowlist.
