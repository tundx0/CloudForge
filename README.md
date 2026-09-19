# CloudForge

A Node/TypeScript deploy platform: point at a git repo + Dockerfile, and CloudForge builds and deploys it.

**Status:** early scaffold. The first slice is a runnable API stub for the deploy path — not a full orchestrator yet.

## What it does

1. Accept a deploy request (`repoUrl` + optional `dockerfilePath`)
2. Build the image
3. Deploy the result

Right now only the API shape and local health check exist. `POST /deploy` acknowledges the job and returns a `jobId`; it does not clone, build, or ship anything. Real build/deploy comes next.

## Stack

- Node.js 20+ and TypeScript
- HTTP API (Express)
- Docker (target runtime for builds; not invoked in this milestone)

## Quick start

```bash
npm install
npm run build
npm start
```

The server listens on `http://localhost:3000` (override with `PORT`).

For local development without a compile step:

```bash
npm run dev
```

## Verify locally

With the server running:

```bash
curl -s http://localhost:3000/health
```

Expected:

```json
{"status":"ok"}
```

Automated checks (no running server required):

```bash
npm test
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness. Returns `200` `{ "status": "ok" }`. |
| `POST` | `/deploy` | Accept a deploy job. Stub only — queues/acknowledges, does not build. |

### `POST /deploy`

Request body:

```json
{
  "repoUrl": "https://github.com/example/app",
  "dockerfilePath": "Dockerfile"
}
```

`dockerfilePath` is optional and defaults to `Dockerfile`.

Successful stub response (`202 Accepted`):

```json
{
  "jobId": "3f2c1a4e-8b91-4d2a-9c0e-1a2b3c4d5e6f",
  "status": "accepted",
  "repoUrl": "https://github.com/example/app",
  "dockerfilePath": "Dockerfile",
  "message": "Deploy job accepted. Image build and cloud deploy are not implemented in this scaffold."
}
```

Missing or invalid `repoUrl` returns `400` with `{ "error": "invalid_request", "message": "..." }`.

Example:

```bash
curl -X POST http://localhost:3000/deploy \
  -H 'Content-Type: application/json' \
  -d '{"repoUrl":"https://github.com/example/app","dockerfilePath":"Dockerfile"}'
```

## Sample Dockerfile

The repository root `Dockerfile` is a hello-world Node service for documentation and demos. CloudForge does not build or run it yet. You can still try it yourself:

```bash
docker build -t cloudforge-sample .
docker run --rm -p 8080:8080 cloudforge-sample
```

## Roadmap (visible milestones)

1. **Scaffold** — runnable server, README, `/health` + stub `/deploy` ← this repo
2. **Build worker** — clone repo, `docker build`, stream logs
3. **Deploy target** — run container / push to a registry and ship
4. **Auth + multi-project** — API keys, project records, status history
