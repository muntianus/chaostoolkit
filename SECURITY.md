# Security Policy

chaostoolkit is an internal PerfOps microservice (default port 4060).

- **Report a vulnerability:** open a private security advisory on this repo
  (GitHub → Security → Advisories) or contact the owner listed in
  [`muntianus/.github`](https://github.com/muntianus/.github/blob/main/SECURITY.md).
- **Secrets:** none are required. Never commit `.env`; only `.env.example`
  (placeholder values) is tracked. CI runs gitleaks via the org security gate.
- `POST /api/v1/experiments/run` performs **real** fault injection unless `dry_run` is set, and the API is unauthenticated. Targets are limited to loopback (plus `CHAOS_ALLOWED_HOSTS`) and `process_kill` only spawns scripts from the bundled demo directories — keep the service on loopback and never add production hosts to the allowlist.
