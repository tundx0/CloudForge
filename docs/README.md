# CloudForge Documentation

CloudForge is small on purpose: about a dozen source files and 1,500 lines of TypeScript. Yet it touches most of the hard parts of building a platform: accepting work over HTTP, queueing it with backpressure, running it asynchronously, surviving restarts, shelling out to other programs and handling their failures, and deciding what to do with code you don't trust.

These docs treat the codebase as a **teaching project**. They explain what the code does and also *why* it is shaped that way, what a senior engineer would question, and where it breaks.

## Reading order

| # | Document | You will learn |
| --- | --- | --- |
| 1 | [Setup](setup.md) | Get it running, try a real build, fix common problems |
| 2 | [Architecture](architecture.md) | The modules, the request lifecycle, the job state machine, and the failure model |
| 2½ | [Decision records](adr/README.md) | *Why* each significant choice was made, what was rejected, and when to revisit it |
| 3 | [Code walkthrough](code-walkthrough.md) | A guided, file-by-file read of the source with the reasoning behind each line that matters |
| 4 | [Testing](testing.md) | How the design makes the code testable without Docker, and where the tests are thin |
| 5 | [Production readiness review](production-readiness.md) | A senior-level review: verified security and reliability problems, ranked, with fixes |
| 6 | [Evolving the system](evolving-the-system.md) | How to get from this prototype to a real deploy platform without a rewrite |
| 7 | [Exercises](exercises.md) | Hands-on changes, ordered from warm-up to system design |

If you only have 30 minutes, read **Architecture**, then **Production readiness review**, then any two ADRs. Together they are the "senior thinking" core.

The project's own process docs are at the repo root: [CONTRIBUTING.md](../CONTRIBUTING.md) (how changes should look, and the review checklist) and [CHANGELOG.md](../CHANGELOG.md) (what changed, with breaking changes called out).

## How to read the "senior lens" callouts

Throughout the docs you'll see blocks like this:

> **Senior lens:** A question or trade-off an experienced engineer would raise here, and why.

They are the point of these docs. Code is easy to read line by line. The hard skill is noticing what the code *assumes*: what happens under load, under attack, on restart, or when a dependency misbehaves.

## Glossary

| Term | Meaning in this codebase |
| --- | --- |
| **Job** | One request to build a repo. Has an id, a status, the commit it built, capped logs, and an optional error. See [`src/jobs.ts`](../src/jobs.ts). |
| **State machine** | The table of allowed status moves: `queued → cloning → building → succeeded`, or `→ failed` from any non-final state. |
| **Compare-and-set (CAS)** | "Change the status from X to Y *only if it's still X*." How two actors can race on a job safely. |
| **Job repository** | The `JobRepository` interface for storing jobs and logs. Implemented in memory (tests) and in SQLite (production). |
| **Contract test** | One test suite run against every implementation of an interface, so fakes can't drift from the real thing. |
| **Scheduler** | `BuildScheduler`: runs at most N builds at once and holds a bounded waiting line. |
| **Reservation** | A claim on a queue slot, taken *before* any `await` so concurrent requests can't overfill the queue. |
| **Backpressure / load shedding** | Refusing new work (`503` + `Retry-After`) when full, rather than accepting work you can't do. |
| **Worker** | `runBuildJob`: claims a queued job, clones, builds, records the outcome, cleans up. Idempotent. |
| **Idempotent** | Safe to run more than once with the same effect as running once. |
| **Runner** | The `BuildRunner` interface: `clone`, `build`, `cleanup`. The real one runs hardened `git`/`docker`; tests use a fake. |
| **Composition root** | [`src/index.ts`](../src/index.ts), the one place real dependencies are created and wired together. |
| **Recovery** | What startup does with jobs a previous process left behind: fail interrupted ones, re-queue never-started ones. |
| **Graceful shutdown** | On `SIGTERM`: stop accepting, let running builds finish within a grace period, abort the rest, exit cleanly. |
| **Liveness / readiness** | `/health` means "the process is up" (restart if not); `/ready` means "it can do work now" (route traffic only if so). |
| **ADR** | Architecture Decision Record: a short, immutable note of one decision, its alternatives, and its trade-offs. |
| **Seam** | A place where you can swap behaviour by passing a different implementation: `createApp(options)`, `JobRepository`, `BuildRunner`, `RunCommand`, the scheduler's `execute`, readiness checks, `Logger`. |

## Keeping these docs honest

Links point at files and symbols rather than line numbers where possible, because line numbers go stale. The production-readiness review deliberately keeps its original analysis of commit `961c7ef`, with a status note on each fixed finding. ADRs are never edited once accepted; a new ADR supersedes an old one. If you change the code, update the docs in the same PR. A doc that describes old behaviour is worse than no doc.

Every claim in the production-readiness review was checked by running code, and each finding says how. Keep that standard when adding findings.
