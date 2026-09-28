# 0006. Define what happens to jobs on restart and shutdown

- Status: Accepted
- Date: 2026-09-28

## Context

With durable jobs (ADR-0003), a restart no longer erases state, so we have to decide what each surviving state *means*. Orchestrators stop processes with `SIGTERM`, then `SIGKILL` after a grace period (30 s in Kubernetes by default). Without a handler, in-flight builds died mid-step, and their clone directories stayed on disk forever (R4).

## Options considered

For jobs found in `cloning` or `building` at startup:

1. **Retry automatically**: friendliest when it works. But the process may have died *because* of that build (OOM, a runaway step), so retrying can crash-loop the service. It's also a product decision (how many times? with backoff?).
2. **Fail with a clear message**: simple and safe, and the user can resubmit.

For jobs found in `queued`:

1. **Fail them**: simple, but breaks the promise made by the `202`. Nothing has happened to them yet.
2. **Re-queue in creation order**: honours the promise at no risk, because no work has started.

## Decision

- **Startup** ([`recovery.ts`](../../src/recovery.ts)), in order, *before* listening:
  1. Sweep `WORK_DIR`, deleting **only UUID-named directories**. A misconfigured `WORK_DIR=$HOME` must not be able to delete anything CloudForge didn't create.
  2. In-flight jobs → `failed` with `Interrupted: the server stopped during this build`.
  3. Queued jobs → re-queued oldest first, bypassing the queue limit, because this work was already accepted.
- **Shutdown** ([`index.ts`](../../src/index.ts)) on `SIGTERM` or `SIGINT`, the reverse of startup:
  1. Stop accepting connections, and have `/ready` start failing.
  2. Stop starting queued jobs. They stay `queued` in the database for the next start.
  3. Wait up to `SHUTDOWN_GRACE_MS` (default 25 s, under Kubernetes' 30 s) for running builds.
  4. Abort what's left through `AbortSignal`. Each running `git` or `docker` gets `SIGTERM`, then `SIGKILL`, and the job is recorded as `failed: … interrupted by shutdown`.
  5. Close the database and exit 0.

## Consequences

- A deploy with a long grace period lets short builds finish. A short grace period trades lost builds for faster rollouts. It's one setting, and the trade-off is explicit.
- **Aborting the `docker` CLI may not stop a build inside the Docker daemon.** Not verified. Robust cancellation needs the daemon API or BuildKit's own cancellation.
- `SIGKILL` (OOM, `kill -9`) skips all of this. Startup recovery is the backstop for that case.

## Revisit when

- Users ask for automatic retries: model them as attempts with a max count and backoff (see ADR-0004, "revisit when").
- Builds routinely outlast the grace period: consider draining (stop taking new work well before shutdown) rather than a longer grace.
