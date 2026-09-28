# CloudForge

Point CloudForge at a git repo and a Dockerfile. It builds the image and deploys it.

**Status:** reliable single-node build service. The HTTP API queues build jobs, clones the repo at a recorded commit, runs `docker build` with bounded concurrency, and stores job state and logs in SQLite, so jobs survive restarts. Shipping the image to a cloud target is the next milestone.

> **Trust boundary:** builds run on the host's Docker daemon, and there's no authentication. Only let people you trust reach CloudForge. That's why it listens on `127.0.0.1` by default. See the [production readiness review](docs/production-readiness.md) (S2, S6).

## Documentation

In-depth docs live in [`docs/`](docs/README.md). They're written to teach, covering the reasoning and trade-offs as well as the usage.

- [Setup](docs/setup.md): prerequisites, running a real build, troubleshooting
- [Architecture](docs/architecture.md): modules, request lifecycle, job state machine, failure model
- [Decision records](docs/adr/README.md): why each significant choice was made, and when to revisit it
- [Code walkthrough](docs/code-walkthrough.md): a guided, file-by-file read
- [Testing](docs/testing.md): the test strategy, contract tests, and how concurrency is tested deterministically
- [Production readiness review](docs/production-readiness.md): verified security and reliability gaps, ranked, with fix status
- [Evolving the system](docs/evolving-the-system.md): the road to multi-node, isolation, deploy targets, and auth
- [Exercises](docs/exercises.md): hands-on improvements, warm-up to system design

Also: [CONTRIBUTING.md](CONTRIBUTING.md) and [CHANGELOG.md](CHANGELOG.md).

## Pipeline

1. **Accept** a deploy request (`repoUrl` + optional `dockerfilePath`) and queue it
2. **Build** the image (shallow clone, record the commit, `docker build`)
3. **Deploy** the result: *next milestone*

## Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js ≥ 22.13, TypeScript (strict) | `node:sqlite` is built in ([ADR-0003](docs/adr/0003-sqlite-job-store.md)) |
| HTTP | Express 5 | Async handlers forward errors to one JSON error handler |
| Jobs | SQLite (WAL) behind an async repository interface | Durable on one node; replaceable with Postgres ([ADR-0003](docs/adr/0003-sqlite-job-store.md)) |
| Scheduling | In-process bounded queue | Backpressure without new infrastructure ([ADR-0002](docs/adr/0002-in-process-scheduler.md)) |
| Builds | `git` + `docker` CLIs, hardened | Timeouts, minimal env, no credential helpers ([ADR-0001](docs/adr/0001-security-defaults.md)) |
| Packages | pnpm | Pinned via `packageManager` |

## Quick start

Requires Node.js ≥ 22.13, [pnpm](https://pnpm.io/installation) (`corepack enable`), git, and a running Docker daemon.

```bash
pnpm install
```

```bash
pnpm check
```

```bash
pnpm start
```

`pnpm check` runs type-check, tests, and build, the same gates as CI. The tests don't need git or Docker.

### Configuration

Read from the environment at startup. **Invalid values stop the server with an error.**

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Listen address. `0.0.0.0` accepts remote connections; there's no auth yet. |
| `DATABASE_PATH` | `.data/cloudforge.db` | SQLite file for jobs and logs. `:memory:` keeps nothing across restarts. |
| `WORK_DIR` | `.work` | Parent directory for temporary clones |
| `ALLOWED_GIT_HOSTS` | `github.com,gitlab.com,bitbucket.org` | Hosts `repoUrl` may use. `*` allows any, including internal addresses. |
| `MAX_CONCURRENT_BUILDS` | `2` | Builds running at once |
| `MAX_QUEUED_BUILDS` | `50` | Builds waiting. Beyond this, `POST /deploy` returns `503`. |
| `CLONE_TIMEOUT_MS` | `120000` | `git clone` is stopped after this long |
| `BUILD_TIMEOUT_MS` | `900000` | `docker build` is stopped after this long |
| `MAX_LOG_BYTES` | `5242880` | Per-job log cap; the head is kept and a marker is added |
| `SHUTDOWN_GRACE_MS` | `25000` | On `SIGTERM`, how long running builds get to finish before they're aborted |

## API

Base URL: `http://localhost:3000`. Every error has the same shape:

```json
{ "error": "invalid_request | not_found | unavailable | internal", "message": "..." }
```

### `POST /deploy`

Validates the request, queues a build, and returns `202 Accepted` with a `Location` header pointing at the job.

```json
{ "repoUrl": "https://github.com/example/app", "dockerfilePath": "Dockerfile" }
```

- `repoUrl`: `http(s)`, no embedded credentials, host in `ALLOWED_GIT_HOSTS`. Private repos aren't supported yet.
- `dockerfilePath` (optional, default `Dockerfile`): relative to the repo root and must stay inside it. After cloning, the real file (symlinks resolved) must also be inside the clone.

`202 Accepted`, `Location: /jobs/<jobId>`:

```json
{
  "jobId": "3f2c1a4e-8b91-4d2a-9c0e-1a2b3c4d5e6f",
  "status": "queued",
  "repoUrl": "https://github.com/example/app",
  "dockerfilePath": "Dockerfile",
  "imageTag": "cloudforge-3f2c1a4e8b914d2a9c0e1a2b3c4d5e6f",
  "message": "Deploy job accepted. Image build queued; cloud deploy is not implemented yet."
}
```

| Status | When |
| --- | --- |
| `400` | Invalid JSON or an invalid field |
| `413` | Body over 16 KB |
| `503` + `Retry-After` | Queue full, or the server is shutting down |

```bash
curl -i -X POST http://localhost:3000/deploy -H 'Content-Type: application/json' -d '{"repoUrl":"https://github.com/tundx0/CloudForge"}'
```

### `GET /jobs/:jobId`

The job, with its full (capped) log. Status moves `queued` → `cloning` → `building` → `succeeded`, or to `failed` from any non-final state. `succeeded` and `failed` never change.

```json
{
  "jobId": "3f2c1a4e-8b91-4d2a-9c0e-1a2b3c4d5e6f",
  "status": "succeeded",
  "repoUrl": "https://github.com/example/app",
  "dockerfilePath": "Dockerfile",
  "imageTag": "cloudforge-3f2c1a4e8b914d2a9c0e1a2b3c4d5e6f",
  "commitSha": "961c7eff202f4cffd884773fa6c978fafd1a8004",
  "logs": "Cloning https://github.com/example/app (shallow) into ...\n",
  "logTruncated": false,
  "error": null,
  "createdAt": "2026-09-28T00:41:39.849Z",
  "updatedAt": "2026-09-28T00:41:42.573Z"
}
```

`404` when the id is unknown.

### `GET /jobs/:jobId/logs?after=<seq>&limit=<n>`

Incremental logs for following a build without re-downloading everything. Start with `after=0`, then pass back `nextSeq`. Stop when `done` is `true`, meaning the job has finished **and** every chunk has been returned. `limit` is 1–1000 (default 1000).

```json
{
  "jobId": "3f2c1a4e-...",
  "status": "building",
  "chunks": [{ "seq": 1, "text": "Cloning ...\n" }],
  "nextSeq": 1,
  "done": false
}
```

Join `text` values in order; chunk boundaries don't fall on line breaks.

### `GET /health` and `GET /ready`

- `/health` (**liveness**) returns `200 {"status":"ok"}` whenever the process can serve HTTP.
- `/ready` (**readiness**) returns `200` or `503`, with per-check results (store, scheduler, Docker daemon) and queue stats. Use it to decide whether to route traffic here.

## Operations

- **Logs** go to stdout as JSON lines with stable event names (`job.transition`, `http.request`, `shutdown.done`, …). Filter one job's history by `jobId`.
- **Shutdown:** on `SIGTERM`/`SIGINT` the server stops accepting requests, lets running builds finish for up to `SHUTDOWN_GRACE_MS`, aborts the rest (marking them `failed`), and exits 0. Queued jobs stay queued.
- **Restart:** builds that were running when the process died are marked `failed` with a clear message, queued jobs resume in order, and leftover clone directories are removed.
- **Images** are tagged `cloudforge-<jobId without dashes>` and never deleted automatically. To clean up:

```bash
docker images -q 'cloudforge-*' | xargs docker rmi
```

## Sample image

The root `Dockerfile` is a hello-world Node service for docs and demos, not a way to package CloudForge itself (see [Evolving the system](docs/evolving-the-system.md#step-3-isolate-the-builder)).

```bash
docker build -t cloudforge-sample .
```

```bash
docker run --rm -p 8080:8080 cloudforge-sample
```

## Roadmap

| Milestone | Scope |
| --- | --- |
| Scaffold | Runnable server, `/health`, stub `/deploy` |
| Build worker | Clone repo, `docker build`, job status and logs |
| **Reliable single node** ← now | Hardened inputs, durable jobs, bounded queue, graceful shutdown, observability |
| **Deploy target** | Push to a registry by digest, run the container |
| **Auth + projects** | API keys, project records, private repos |
| **Isolated builders** | Untrusted builds in sandboxes, off the API host |
