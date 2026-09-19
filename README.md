# CloudForge

A Node/TypeScript deploy platform: point at a git repo + Dockerfile, and CloudForge builds and deploys it.

**Status:** early scaffold. The first slice is a runnable API stub for the deploy path — not a full orchestrator yet.

## What it does

1. Accept a deploy request (`repo` + `Dockerfile`)
2. Build the image
3. Deploy the result

Right now only the API shape and local health check exist. Real build/deploy comes next.

## Stack

- Node.js + TypeScript
- HTTP API (Express)
- Docker (target runtime for builds)

## Quick start

```bash
npm install
npm run build
npm start
```

## Health check:

curl http://localhost:3000/health
Deploy path (current stub)

Method	Path	Purpose
GET	/health	Liveness
POST	/deploy	Accept a deploy job (stub — queues/acknowledges only)
Example:

curl -X POST http://localhost:3000/deploy \
  -H 'Content-Type: application/json' \
  -d '{"repoUrl":"https://github.com/example/app","dockerfilePath":"Dockerfile"}'
  
## Roadmap (visible milestones)
Scaffold — runnable server, README, /health + stub /deploy ← this repo
Build worker — clone repo, docker build, stream logs
Deploy target — run container / push to a registry and ship
Auth + multi-project — API keys, project records, status history
