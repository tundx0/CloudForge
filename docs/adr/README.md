# Architecture Decision Records

An ADR records one significant decision: the context, the options considered, what was chosen, and what it costs. Code shows *what* was decided. Only an ADR shows what was rejected and why, which is what a future maintainer needs before changing it.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-security-defaults.md) | Secure-by-default input handling and process isolation | Accepted |
| [0002](0002-in-process-scheduler.md) | In-process scheduler with a bounded queue | Accepted |
| [0003](0003-sqlite-job-store.md) | SQLite via `node:sqlite` behind an async repository | Accepted |
| [0004](0004-job-state-machine.md) | Explicit job state machine with compare-and-set transitions | Accepted |
| [0005](0005-observability.md) | JSON event logs, and separate liveness and readiness | Accepted |
| [0006](0006-restart-and-shutdown.md) | Restart recovery and graceful shutdown semantics | Accepted |
| [0007](0007-log-storage.md) | Job logs as sequenced chunks with a head-keeping cap | Accepted |

## When to write one

Write an ADR when a decision is **hard to reverse**, **surprising**, or **has a real alternative** someone will propose again later. Don't write one for choices with an obvious conventional answer.

## Rules

- ADRs are **immutable once accepted**. To change a decision, write a new ADR that supersedes the old one, and set the old one's status to `Superseded by NNNN`. The history of *why things changed* is the point.
- Keep them short. If an ADR runs past about a page, it's probably more than one decision.
- Put the "revisit when" trigger in every ADR. A decision without an expiry condition turns into dogma.

## Template

```markdown
# NNNN. Title in the imperative ("Use X for Y")

- Status: Proposed | Accepted | Superseded by NNNN
- Date: YYYY-MM-DD

## Context
What forces are at play? What constraint or problem makes a decision necessary now?

## Options considered
1. **Option A**: pros / cons
2. **Option B**: pros / cons

## Decision
What we chose, in one or two sentences.

## Consequences
What becomes easier, what becomes harder, and what we must now watch for.

## Revisit when
The concrete signal that this decision should be reopened.
```
