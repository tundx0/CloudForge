# CloudForge

Point CloudForge at a git repo and a Dockerfile. It builds the image and deploys it.

**Status:** build worker. The HTTP API clones the repo, runs `docker build`, and exposes job status plus logs. Shipping the image to a cloud target is not implemented yet.

Jobs live in memory for this milestone; a process restart discards them.

## Pipeline

1. **Accept** a deploy request (`repoUrl` + optional `dockerfilePath`)
2. **Build** the image (shallow clone + `docker build`)
3. **Deploy** the result

This repo covers steps 1–2. Step 3 is next.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 20+, TypeScript |
| HTTP | Express |
| Packages | pnpm |
| Builds | Docker (`docker build` in a temp clone) |
| Jobs | In-process map (lost on restart) |

## Quick start

Requires Node.js 20+, [pnpm](https://pnpm.io/installation), git, and a running Docker daemon.

```bash
pnpm install
pnpm build
pnpm start
```

Listens on `http://localhost:3000`. Override with `PORT`. Clone directories go under `WORK_DIR` (default `.work`).

| Script | Command | Purpose |
| --- | --- | --- |
| Dev | `pnpm dev` | Run TypeScript directly |
| Test | `pnpm test` | API and worker checks (no Docker daemon required) |
| Build | `pnpm build` | Compile to `dist/` |
| Start | `pnpm start` | Run the compiled server |

## API

Base URL: `http://localhost:3000`

### `GET /health`

Liveness. `200`

```json
{ "status": "ok" }
```

```bash
curl -s http://localhost:3000/health
```

### `POST /deploy`

Validates the payload, stores a job, returns `202 Accepted`, then clones and builds in the background.

Request:

```json
{
  "repoUrl": "https://github.com/example/app",
  "dockerfilePath": "Dockerfile"
}
```

`dockerfilePath` is optional; default is `Dockerfile`.

`202 Accepted`:

```json
{
  "jobId": "3f2c1a4e-8b91-4d2a-9c0e-1a2b3c4d5e6f",
  "status": "accepted",
  "repoUrl": "https://github.com/example/app",
  "dockerfilePath": "Dockerfile",
  "message": "Deploy job accepted. Image build started; cloud deploy is not implemented yet."
}
```

`400` when `repoUrl` is missing or not an `http(s)` URL:

```json
{ "error": "invalid_request", "message": "..." }
```

```bash
curl -X POST http://localhost:3000/deploy \
  -H 'Content-Type: application/json' \
  -d '{"repoUrl":"https://github.com/example/app","dockerfilePath":"Dockerfile"}'
```

### `GET /jobs/:jobId`

Job status and accumulated build logs. `200`

Status moves `accepted` → `cloning` → `building` → `succeeded` or `failed`. On failure, `error` is a short message (for example when Docker is missing or the daemon is unreachable).

```json
{
  "jobId": "3f2c1a4e-8b91-4d2a-9c0e-1a2b3c4d5e6f",
  "status": "building",
  "repoUrl": "https://github.com/example/app",
  "dockerfilePath": "Dockerfile",
  "logs": "Cloning https://github.com/example/app (shallow) into .work/...\n",
  "error": null
}
```

`404` when the id is unknown:

```json
{ "error": "not_found", "message": "Unknown jobId" }
```

```bash
curl -s http://localhost:3000/jobs/3f2c1a4e-8b91-4d2a-9c0e-1a2b3c4d5e6f
```

## Sample image

The root `Dockerfile` is a hello-world Node service for docs and demos. The build worker runs the same `docker build` shape against whatever repo you post.

```bash
docker build -t cloudforge-sample .
docker run --rm -p 8080:8080 cloudforge-sample
```

## Roadmap

| Milestone | Scope |
| --- | --- |
| Scaffold | Runnable server, `/health`, stub `/deploy` |
| **Build worker** ← now | Clone repo, `docker build`, job status and logs |
| **Deploy target** | Run the container or push to a registry |
| **Auth + projects** | API keys, project records, status history |
