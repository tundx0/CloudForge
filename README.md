# CloudForge

Point CloudForge at a git repo and a Dockerfile. It builds the image and deploys it.

**Status:** scaffold. The HTTP API runs locally; `POST /deploy` accepts a job and returns a `jobId`. Clone, image build, and ship are not implemented yet.

## Pipeline

1. **Accept** a deploy request (`repoUrl` + optional `dockerfilePath`)
2. **Build** the image (`docker build`)
3. **Deploy** the result

This repo covers step 1 as a stub. Steps 2–3 are next.

## Stack

| Layer | Choice |
| --- | --- |
| Runtime | Node.js 20+, TypeScript |
| HTTP | Express |
| Packages | pnpm |
| Builds | Docker (target runtime; not invoked yet) |

## Quick start

Requires Node.js 20+ and [pnpm](https://pnpm.io/installation).

```bash
pnpm install
pnpm build
pnpm start
```

Listens on `http://localhost:3000`. Override with `PORT`.

| Script | Command | Purpose |
| --- | --- | --- |
| Dev | `pnpm dev` | Run TypeScript directly |
| Test | `pnpm test` | API checks (no server required) |
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

**Stub.** Validates the payload, assigns a `jobId`, returns `202 Accepted`. Does not clone the repo, build an image, or deploy anything.

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
  "message": "Deploy job accepted. Image build and cloud deploy are not implemented in this scaffold."
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

## Sample image

The root `Dockerfile` is a hello-world Node service for docs and demos. CloudForge does not build or run it.

```bash
docker build -t cloudforge-sample .
docker run --rm -p 8080:8080 cloudforge-sample
```

## Roadmap

| Milestone | Scope |
| --- | --- |
| **Scaffold** ← now | Runnable server, `/health`, stub `/deploy` |
| **Build worker** | Clone repo, `docker build`, stream logs |
| **Deploy target** | Run the container or push to a registry |
| **Auth + projects** | API keys, project records, status history |
