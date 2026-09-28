# 0003. Store jobs in SQLite via `node:sqlite`, behind an async repository

- Status: Accepted
- Date: 2026-09-28

## Context

Jobs lived in a `Map` and were lost on every restart (R4). A client holding a `jobId` from a `202` would get `404` after a deploy. We need durable jobs and logs on a single node, with little operational cost, and without blocking a later move to a networked database.

## Options considered

1. **JSON file**: no dependency. But no atomic partial updates, whole-file rewrites, and corruption on crash unless we reimplement a database.
2. **`better-sqlite3`**: mature and fast. A native addon: a compile step or prebuilt binaries per platform, and another package allowed to run install scripts.
3. **`node:sqlite`** (built into Node): no dependency and no native build. Marked *experimental* (it prints an `ExperimentalWarning`) and needs Node ≥ 22.13.
4. **Postgres**: what we'd eventually want for multiple processes. Too much to run for a single-node service today.

## Decision

Option 3, behind the `JobRepository` interface in [`jobs.ts`](../../src/jobs.ts):

- **The interface is async**, even though `node:sqlite` is synchronous and the in-memory version needs no awaits. Changing an interface's *shape* and its *implementation* at the same time is how migrations go wrong. Making it async now means Postgres later is an implementation swap, not a refactor of every caller.
- **One contract test suite** ([`jobs.test.ts`](../../src/jobs.test.ts)) runs against both `InMemoryJobRepository` and `SqliteJobRepository`. That's what makes it safe for other tests to use the in-memory one.
- **Schema migrations** are an append-only list, tracked with `PRAGMA user_version`.
- **WAL mode, `synchronous = NORMAL`, `busy_timeout`**: the standard settings for a single-writer service. A power loss can drop the last few transactions, but not corrupt the file.
- A `CHECK` constraint on `status` means the database itself rejects impossible values.
- `engines.node` is raised to `>=22.13`, and the `start`, `dev`, and `test` scripts pass `--disable-warning=ExperimentalWarning`.

## Consequences

- **Breaking for Node 20 users.** Documented in the changelog.
- `node:sqlite` calls block the event loop briefly. Every statement is single-row and indexed, so this is microseconds. A chatty build appends log chunks in a transaction per chunk, which is fine at our volumes and the first thing to batch if profiling says otherwise.
- The API is experimental and could change in a Node release. The repository boundary contains that risk to one file.
- `DATABASE_PATH=:memory:` gives the old non-durable behaviour for throwaway runs.

## Revisit when

- We run more than one process (see ADR-0002): move to Postgres behind the same interface and contract tests.
- `node:sqlite` changes incompatibly, or profiling shows event-loop blocking.
