# Setup

This page gets you from a fresh clone to a real image build, and explains what each piece of tooling is doing so you can debug it when it goes wrong.

## Prerequisites

| Tool | Version | Why it's needed | Check |
| --- | --- | --- | --- |
| Node.js | **≥ 22.13** (`.nvmrc` says 22) | Runtime. The job store uses the built-in `node:sqlite` ([ADR-0003](adr/0003-sqlite-job-store.md)). | `node --version` |
| pnpm | 10.x | Package manager, pinned via `packageManager` in `package.json` | `pnpm --version` |
| git | any recent | The worker runs `git clone --depth 1` | `git --version` |
| Docker | daemon running | The worker runs `docker build` | `docker info` |

**Getting pnpm:** the easiest route is Corepack, which ships with Node:

```bash
corepack enable
```

Corepack reads `"packageManager": "pnpm@10.33.3"` and downloads that exact version the first time you run `pnpm`. Everyone on the team then uses the same pnpm, which keeps `pnpm-lock.yaml` stable.

**Docker is only needed for real builds.** The test suite replaces git and Docker with fakes, so `pnpm test` works on a machine without either. That is deliberate; [Testing](testing.md) explains how.

## Install, test, build, run

```bash
pnpm install
```

```bash
pnpm check
```

That runs type-check, tests, and build, the same gates as CI. Every test should pass (`fail 0`), and none of them needs git or Docker.

```bash
pnpm start
```

The server logs JSON lines. Look for `"event":"startup.listening"` with `"url":"http://127.0.0.1:3000"`. It only accepts connections from this machine unless you set `HOST`. Stop it with Ctrl-C: that sends `SIGINT`, which triggers the graceful shutdown path (`shutdown.started` … `shutdown.done`).

### What each script actually does

| Script | Command | Notes |
| --- | --- | --- |
| `pnpm dev` | `tsx watch … src/index.ts` | Runs TypeScript directly via [tsx](https://tsx.is) and restarts on change. **Does not type-check.** |
| `pnpm typecheck` | `tsc` | Type-checks source **and tests** using `tsconfig.json` (`noEmit`) |
| `pnpm test` | `tsx --test … 'src/**/*.test.ts'` | Node's built-in test runner (`node:test`), with tsx handling TypeScript. Each test file runs in its own subprocess. |
| `pnpm build` | `tsc -p tsconfig.build.json` | Compiles `src/` to `dist/`, excluding tests and `testSupport.ts` |
| `pnpm start` | `node … dist/index.js` | Runs the compiled output. Needs `pnpm build` first. |
| `pnpm check` | typecheck → test → build | What CI runs. Run it before pushing. |

`start`, `dev`, and `test` pass `--disable-warning=ExperimentalWarning`, because `node:sqlite` prints a warning on every start and it would otherwise drown out real warnings. The trade-off is in [ADR-0003](adr/0003-sqlite-job-store.md).

> **Senior lens:** `pnpm dev` and `pnpm test` both skip type-checking, because tsx strips types without checking them. That's why `typecheck` is its own gate, and why it covers the test files. The original single `tsconfig.json` excluded tests, so for a while nothing type-checked them at all.

### Why `pnpm.onlyBuiltDependencies` is in `package.json`

pnpm 10 blocks dependency install scripts (`postinstall` and friends) by default, because they're a common supply-chain attack vector. esbuild, which tsx uses, needs its install script to fetch a platform-specific binary, so it is explicitly allow-listed. If you add a dependency that needs a build step, you will have to allow-list it too. Check what the script does before you do.

## Configuration

Configuration comes from environment variables, read once at startup by [`loadConfig`](../src/config.ts). **An invalid value stops the server with an error**; it is never silently replaced by a default.

| Variable | Default | Read in | Effect |
| --- | --- | --- | --- |
| `PORT` | `3000` | `config.ts` | HTTP listen port, 0–65535. `0` asks the OS for any free port. |
| `HOST` | `127.0.0.1` | `config.ts` | Listen address. Loopback only by default, because there's no auth. Use `0.0.0.0` to listen on all interfaces, e.g. inside a container. |
| `WORK_DIR` | `.work` | `config.ts` | Parent directory for temporary clones. **Relative paths resolve against the process's current directory**, not the repo root. |
| `ALLOWED_GIT_HOSTS` | `github.com,gitlab.com,bitbucket.org` | `config.ts` | Hosts `repoUrl` may point at, compared exactly and case-insensitively. `*` allows any host, **including internal ones**; only use it on a trusted network. |
| `DATABASE_PATH` | `.data/cloudforge.db` | `config.ts` | SQLite file for jobs and logs. Its directory is created if missing. `:memory:` keeps nothing across restarts. |
| `CLONE_TIMEOUT_MS` | `120000` (2 min) | `config.ts` | `git clone` is stopped after this long and the job fails |
| `BUILD_TIMEOUT_MS` | `900000` (15 min) | `config.ts` | `docker build` is stopped after this long and the job fails |
| `MAX_CONCURRENT_BUILDS` | `2` | `config.ts` | Builds running at once (1–64). Size it to CPU and memory: each `docker build` can use a lot of both. |
| `MAX_QUEUED_BUILDS` | `50` | `config.ts` | Builds waiting to start. When full, `POST /deploy` returns `503` + `Retry-After`. |
| `MAX_LOG_BYTES` | `5242880` (5 MiB) | `config.ts` | Per-job log cap (min 1024). The start of the log is kept and a marker is added. |
| `SHUTDOWN_GRACE_MS` | `25000` | `config.ts` | On `SIGTERM`/`SIGINT`, how long running builds get before they're aborted. Keep it below your orchestrator's kill timeout. |

There is no `.env` loading. Set variables in your shell:

```bash
PORT=4000 WORK_DIR=/tmp/cloudforge pnpm start
```

## Try a real build end to end

With the server running and Docker up, submit this repository itself. Its root `Dockerfile` is a tiny hello-world service.

```bash
curl -s -X POST http://localhost:3000/deploy -H 'Content-Type: application/json' -d '{"repoUrl":"https://github.com/tundx0/CloudForge"}'
```

The response is `202` with `"status":"queued"` and a `Location` header. Copy the `jobId` and poll it:

```bash
curl -s http://localhost:3000/jobs/<jobId>
```

You'll see `status` move through `queued` → `cloning` → `building` → `succeeded`, and `commitSha` appear once the clone finishes. To follow only the *new* log output, page through the logs endpoint, passing back `nextSeq` each time until `done` is `true`:

```bash
curl -s "http://localhost:3000/jobs/<jobId>/logs?after=0"
```

To check the server can build at all (Docker reachable, store healthy, queue open):

```bash
curl -s http://localhost:3000/ready
```

The image is tagged `cloudforge-` plus the job id without dashes:

```bash
docker images 'cloudforge-*'
```

Run the image you just built:

```bash
docker run --rm -p 8080:8080 cloudforge-<jobId without dashes>
```

**CloudForge never deletes images.** Clean them up yourself when you're done:

```bash
docker images -q 'cloudforge-*' | xargs docker rmi
```

## Where things live on disk

```
.data/cloudforge.db     ← DATABASE_PATH: jobs and logs (plus -wal/-shm files), git-ignored
.work/                  ← WORK_DIR, git-ignored
  <jobId>/              ← shallow clone, exists only while the job runs
dist/                   ← build output, git-ignored
```

To start from a clean slate, stop the server and delete `.data/`. That erases all job history.

The clone directory is deleted before cloning and again in a `finally` block, so it's removed on success and failure. If the process is **killed** mid-build, the next start sweeps it. Only directories named like job ids (UUIDs) are removed, so nothing else in `WORK_DIR` is touched.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Job `failed`, error `Docker is not installed or not on PATH` | `spawn("docker")` returned `ENOENT` | Install Docker, or make sure `docker` is on the `PATH` of the process running CloudForge (GUI-launched shells can differ from your terminal) |
| Job `failed`, error `Docker daemon is unreachable…` | The CLI exists but can't reach the daemon | Start Docker Desktop, OrbStack, or `dockerd`, then check `docker info` |
| Job `failed`, error `Git is not installed or not on PATH` | `spawn("git")` returned `ENOENT` | Install git |
| Job `failed`, logs show `terminal prompts disabled` | The repo is private or doesn't exist. git runs with prompts and credential helpers disabled (see [S5](production-readiness.md#s5-the-server-lends-its-own-git-credentials)). | Use a public repo; private repos aren't supported yet |
| Job `failed`, error `… timed out after …ms` | A step ran past its timeout | Raise `CLONE_TIMEOUT_MS` / `BUILD_TIMEOUT_MS` for large repos or slow builds |
| `400 repoUrl host must be one of: …` | The host isn't in `ALLOWED_GIT_HOSTS` | Add it, e.g. `ALLOWED_GIT_HOSTS=github.com,git.example.com` |
| `400 dockerfilePath must …` | The path is absolute, leaves the repo, or starts with `-` | Use a path relative to the repo root, e.g. `docker/Dockerfile` |
| Job `failed`, `Dockerfile not found in repository` | The path doesn't exist in the cloned default branch | Check the path and the branch |
| Server exits at startup with `… must be an integer …` | An invalid config value | Fix the variable named in the message |
| `GET /jobs/:id` returns 404 after a restart | `DATABASE_PATH` is `:memory:`, or the server was started from a different directory (the default path is relative) | Use an absolute `DATABASE_PATH` |
| `503 Build queue is full…` | More than `MAX_QUEUED_BUILDS` jobs are waiting | Retry after the `Retry-After` seconds, or raise the limits if the machine can take more |
| Job `failed`, error `Interrupted: the server stopped during this build` | The process died mid-build; startup recovery marked it | Resubmit. Check why the process died (OOM?) |
| Job `failed`, error `… stopped: interrupted by shutdown` | `SIGTERM` arrived and the build outlasted `SHUTDOWN_GRACE_MS` | Resubmit, or raise the grace period |
| `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` or `No such built-in module` | Node is older than 22.13 | `nvm use` (reads `.nvmrc`) or upgrade Node |
| `/ready` returns 503 with `docker: {ok:false}` | The daemon isn't reachable from the server's environment | Same as the daemon-unreachable row above |
| `ERR_MODULE_NOT_FOUND` after adding a file | Relative imports need a `.js` extension under `"module": "NodeNext"` | Write `import { x } from "./thing.js"` even though the file is `thing.ts`. The [code walkthrough](code-walkthrough.md#why-imports-end-in-js) explains why. |
| `EADDRINUSE` | Port already taken | `PORT=3001 pnpm start` |

## The sample Dockerfile

The root [`Dockerfile`](../Dockerfile) is **not** how CloudForge itself is packaged. It is a demo target: a one-line Node HTTP server that answers `hello from CloudForge sample`. It exists so there's always a known-good repo to point the worker at. Containerising CloudForge itself is harder than it looks, because the worker needs its own Docker access; see [Evolving the system](evolving-the-system.md#step-3-isolate-the-builder).
