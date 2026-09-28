# Changelog

All notable changes to CloudForge. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/). While the version is `0.x`, minor releases may include breaking changes, and they are always listed under **Breaking**.

## [Unreleased]: reliable single-node build service

### Breaking

- **Node.js ≥ 22.13 is required** (was ≥ 20) for the built-in `node:sqlite`. See [ADR-0003](docs/adr/0003-sqlite-job-store.md).
- **The initial job status is `queued`** (was `accepted`), and the `POST /deploy` response now says `"status": "queued"`. Clients that matched on `accepted` must update. See [ADR-0004](docs/adr/0004-job-state-machine.md).
- **The server binds to `127.0.0.1` by default** (was all interfaces). Set `HOST=0.0.0.0` to listen on all interfaces. There's still no authentication.
- **`repoUrl` must use an allow-listed host** (default `github.com`, `gitlab.com`, `bitbucket.org`). Configure `ALLOWED_GIT_HOSTS`, or set it to `*` to allow any host.
- **Image tags use the full job id** (`cloudforge-<32 hex>`, was the first 8 hex characters).
- **Request bodies over 16 KB** are rejected with `413`.

### Added

- Durable job and log storage in SQLite (`DATABASE_PATH`, default `.data/cloudforge.db`).
- Bounded concurrency (`MAX_CONCURRENT_BUILDS`, default 2) and a bounded queue (`MAX_QUEUED_BUILDS`, default 50). A full queue returns `503` with `Retry-After`. See [ADR-0002](docs/adr/0002-in-process-scheduler.md).
- `GET /jobs/:jobId/logs?after=&limit=` for incremental log reads. See [ADR-0007](docs/adr/0007-log-storage.md).
- `GET /ready` readiness endpoint (store, scheduler, Docker). See [ADR-0005](docs/adr/0005-observability.md).
- `commitSha`, `imageTag`, `logTruncated`, `createdAt`, and `updatedAt` on job responses, and a `Location` header on `202`.
- Graceful shutdown on `SIGTERM`/`SIGINT` (`SHUTDOWN_GRACE_MS`, default 25 s), plus startup recovery: interrupted builds fail clearly, queued jobs resume, leftover clone directories are swept. See [ADR-0006](docs/adr/0006-restart-and-shutdown.md).
- Log cap per job (`MAX_LOG_BYTES`, default 5 MiB).
- Structured JSON logs with stable event names.
- CI on GitHub Actions: type-check (including tests), test, build.
- Architecture Decision Records in [`docs/adr/`](docs/adr/README.md).

### Security

- `dockerfilePath` is validated at the API and re-checked after cloning with symlinks resolved. This closes arbitrary host-file reads (S1) and the `-f -` stdin hang (R1).
- `repoUrl` rejects embedded credentials (S4), and non-allow-listed hosts are rejected (S3).
- git and docker receive an allow-listed environment. git runs without prompts, global or system config, or credential helpers (S5, R6).
- Every git and docker step has a timeout (`CLONE_TIMEOUT_MS`, `BUILD_TIMEOUT_MS`).
- Malformed or oversized request bodies return the JSON error envelope, never an HTML stack trace (S7).

### Fixed

- The state machine is enforced, so a finished job can no longer change state (R8).
- Logs are stored before a job reports a terminal status, so a finished job's logs are complete.
- Invalid numeric configuration (e.g. `PORT=abc`) stops the server at startup instead of being silently replaced.

## [0.1.0]: build worker

- `POST /deploy` clones a repository and runs `docker build` in the background. `GET /jobs/:jobId` reports status and logs. Jobs are in memory.
