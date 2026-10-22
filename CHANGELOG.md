# Changelog

Notable changes to this service. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Security

- **Breaking:** experiments now run in `dry_run` by default (runner, `POST /api/v1/experiments/run`,
  CLI). `live_probe` needs an explicit request and the `CHAOS_LIVE_ENABLED=true` kill switch;
  otherwise it is refused before any probe, injection or child process (HTTP 403
  `LIVE_MODE_DISABLED`, CLI exit 3). The CLI gains `--live`; `--dry-run` stays accepted.
  Refs #2.

### Changed

- Adopted the muntianus Repository Standard v1: committed OpenAPI contract
  (`docs/api/openapi.json`) with a route/spec drift test, `AGENTS.md` / `CLAUDE.md` /
  `SECURITY.md`, `.env.example`, Dependabot, a non-root Docker image with a health check,
  and CI with SHA-pinned actions, least-privilege permissions
  (secret scanning stays with GitGuardian).
