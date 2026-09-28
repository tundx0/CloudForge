# 0002. Schedule builds in-process with a bounded queue

- Status: Accepted
- Date: 2026-09-28

## Context

Every `POST /deploy` started a build immediately (R2). A burst of requests meant a burst of concurrent `docker build`s on one machine, which slows or fails *all* of them. We need a concurrency limit and backpressure. We run one process on one machine, and will for the foreseeable future.

## Options considered

1. **In-process scheduler**: a FIFO array, a running-count limit, and a waiting-count limit. No new infrastructure, trivially testable. Limits apply per process only.
2. **Database as queue** (`SELECT … FOR UPDATE SKIP LOCKED`): works across processes with leases. Needs Postgres (SQLite's single-writer model doesn't give `SKIP LOCKED` semantics) plus lease and heartbeat logic.
3. **Redis with BullMQ, or a managed queue (SQS)**: retries, delays, and dashboards out of the box. Adds a stateful service, at-least-once semantics to design for, and more to operate.

## Decision

Option 1: `BuildScheduler` in [`scheduler.ts`](../../src/scheduler.ts).

- `MAX_CONCURRENT_BUILDS` (default 2) running, and `MAX_QUEUED_BUILDS` (default 50) waiting.
- When full, `POST /deploy` returns **`503` with `Retry-After`** (load shedding) rather than accepting work it can't do soon.
- Capacity is **reserved before any `await`** (`reserve()` then `enqueue()` or `release()`). Checking capacity, awaiting the database, then enqueuing would let concurrent requests all pass the check and overfill the queue: a *check-then-act* race.
- The scheduler is generic (`execute(id, signal)`). It knows nothing about builds, so it can be tested with plain promises.

## Consequences

- A second CloudForge process would have its own limits and its own queue. **The design assumes a single process**, and the durable store (ADR-0003) doesn't change that.
- The queue order lives in memory, but queued jobs live in the database, so a restart re-queues them in creation order (ADR-0006).
- No retries or priorities. Both are product decisions to make when they're needed.

## Revisit when

- We run more than one worker process or machine. Move to option 2 (Postgres) and keep `runBuildJob` unchanged: it's already idempotent and claims jobs by compare-and-set (ADR-0004).
- We need scheduled or delayed builds, retries with backoff, or per-tenant fairness.
