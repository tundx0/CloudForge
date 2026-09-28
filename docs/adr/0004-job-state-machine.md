# 0004. Enforce the job state machine with compare-and-set transitions

- Status: Accepted
- Date: 2026-09-28

## Context

`setStatus` accepted any status at any time (R8). That was harmless with one caller in one process. With a scheduler, shutdown aborts, startup recovery, and a safety-net error handler, several code paths can now try to move the same job. Without rules, a slow path could overwrite `failed` with `succeeded`, or a recovered job could run twice.

## Options considered

1. **Trust the callers**: keep `setStatus`. Every new code path has to be correct by convention.
2. **Transition table only**: reject illegal moves, but still write unconditionally. Stops `succeeded → building`, but not two callers racing through legal moves.
3. **Transition table plus compare-and-set**: `transition(id, from, to)` applies only if the job is *currently* `from`, and returns whether it did.

## Decision

Option 3.

```
queued ──► cloning ──► building ──► succeeded
   │          │           │
   └──────────┴───────────┴──────► failed
```

- `succeeded` and `failed` are terminal. Nothing leaves them.
- An **illegal** move (not in the table) **throws** `IllegalTransitionError`. That's a bug in our code and should be loud.
- A **stale** move (legal, but the job is no longer in `from`) **returns `false`**. That's a lost race, which is normal under concurrency, and the caller decides what to do. The worker's rule: whoever moves a job out of `queued` owns it. Everyone else does nothing.
- In SQLite this is `UPDATE … WHERE job_id = ? AND status = ?` plus a check on the changed-row count. That same statement is what makes multiple workers safe later.
- **`queued` replaces `accepted`** as the initial state, because jobs can now wait. This is a breaking API change, called out in the changelog (0.x semver).

## Consequences

- `runBuildJob` is **idempotent**: calling it twice for one job does the work once. That's the property at-least-once queues need (ADR-0002, "revisit when").
- Code that fails a job without knowing its state uses `failJob`, which reads the status and retries once on a lost race.
- Adding a state (e.g. `cancelled`, `pushing`) means editing one table, and the tests that assert the table catch accidental changes.

## Revisit when

- A job needs to go back to an earlier state (retries). Model it as a new *attempt* record rather than a backwards edge, so history stays readable.
