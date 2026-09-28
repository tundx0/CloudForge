# Exercises

Hands-on changes, ordered from warm-up to system design. Each one fixes a real finding from the [production readiness review](production-readiness.md), so you learn by improving the actual project.

**Ground rules**

- Work on a branch. Every exercise ends with `pnpm test` and `pnpm build` both passing.
- **Write the failing test first.** For bug fixes, the test proves the bug existed, and then proves it's gone.
- Keep the seams intact. If you find yourself importing `child_process` into `buildWorker.ts` or `express` into `jobs.ts`, step back.
- Hints are hidden behind `<details>`. Try for 20 minutes before you open one.
- Exercises marked ✅ are already implemented. For those, read the solution, answer the study questions, and try the stretch goal. Reading a good solution carefully is its own skill.

---

## Level 1: Warm-up

### 1. A consistent error envelope ✅ *implemented: study it*

**Fixed:** [S7](production-readiness.md#s7-malformed-json-returns-an-html-stack-trace). The solution is `errorHandler` in [`app.ts`](../src/app.ts), and the test is `POST /deploy returns a JSON error for malformed JSON`.

**Study questions:**
1. Delete the `_next` parameter and run the tests. What breaks, and why does Express care how many parameters the function declares?
2. Move `app.use(errorHandler)` above the routes. What happens and why?
3. Why is `err.message` passed to the client only when `err.expose` is true?

**Stretch:** The body limit is now 16 KB (`express.json({ limit: "16kb" })`), and a test asserts the JSON `413`. Why is a small limit a good default for this API specifically? What would you log when it's hit?

### 2. Validate `dockerfilePath` ✅ *implemented: study it*

**Fixed:** [S1](production-readiness.md#s1-arbitrary-host-file-read-via-dockerfilepath), and the `-` case of [R1](production-readiness.md#r1-no-timeouts-a-single-request-can-hang-a-job-forever). The syntactic check is `validateDockerfilePath` in [`validation.ts`](../src/validation.ts), and the filesystem check is `resolveInside` in [`buildRunner.ts`](../src/buildRunner.ts).

**Study questions:**
1. Why can't the API layer catch a `Dockerfile` symlink pointing at `/etc/shadow`? Which test covers it?
2. `validateDockerfilePath("app/../Dockerfile")` is accepted and returns `"Dockerfile"`. Is that right? What would be the argument for rejecting any `..` at all?
3. Why does `docker build` get the *resolved absolute* path rather than the user's relative one? Give two reasons.

**Stretch:** `resolveInside` accepts a Dockerfile that is a symlink to *another file inside the repo*. Write a test proving that works.

### 3. Give failures a machine-readable code

`errorMessage` in [`buildWorker.ts`](../src/buildWorker.ts) flattens every failure to a string, and the error classes (`DockerUnavailableError`, `CommandTimeoutError`, `CommandAbortedError`) are thrown away at that point. Keep that information for clients. Add `errorCode: "docker_unavailable" | "git_unavailable" | "timeout" | "interrupted" | "clone_failed" | "build_failed" | "internal" | null` to `Job` and `JobResponse`. That needs a schema migration: add migration 2 to `MIGRATIONS`, never edit migration 1.

**Acceptance:** A clone failure, a build failure, and a timeout produce different codes. Existing assertions on `error` still pass. The repository contract suite covers the new column, and an existing database file upgrades cleanly (test it: create a database with migration 1 only, then open it with the new code).

**You'll learn:** Why clients need stable codes and humans need messages, and why you shouldn't make either one do the other's job.

---

## Level 2: Reliability

### 4. Concurrency limit with a `queued` state ✅ *implemented: study it*

**Fixed:** [R2](production-readiness.md#r2-unbounded-concurrency). See [`scheduler.ts`](../src/scheduler.ts), `POST /deploy` in [`app.ts`](../src/app.ts), and [ADR-0002](adr/0002-in-process-scheduler.md).

The hint suggested a semaphore. The implementation became a **scheduler with reservations** instead.

**Study questions:**
1. A plain semaphore would limit *running* builds. What else does the scheduler limit, and why does an unbounded waiting line defeat the purpose?
2. Walk through twenty simultaneous `POST /deploy` requests against `maxQueued: 5` if the handler did `if (hasRoom()) { await create(); enqueue(); }`. How many get queued? Why does `reserve()` fix it?
3. Why `503` + `Retry-After` rather than `429`?
4. The scheduler knows nothing about builds (`execute(id, signal)`). What did that buy in [`scheduler.test.ts`](../src/scheduler.test.ts)?

**Stretch:** Add per-client fairness, so one client can't fill the whole queue. Where does the client identity come from, given there's no auth yet?

### 5. Enforce the state machine ✅ *implemented: study it*

**Fixed:** [R8](production-readiness.md#r8-the-state-machine-is-not-enforced). See `TRANSITIONS` and `transition` in [`jobs.ts`](../src/jobs.ts), the SQL in [`sqliteJobRepository.ts`](../src/sqliteJobRepository.ts), and [ADR-0004](adr/0004-job-state-machine.md).

**Study questions:**
1. Why does an *illegal* transition throw, while a *stale* one returns `false`?
2. `UPDATE jobs SET status = ? WHERE job_id = ? AND status = ?`: why is this safe with two concurrent writers, when "read the status, check it, then write" is not?
3. How does the first transition (`queued → cloning`) make `runBuildJob` idempotent? Find the test that proves it.

**Stretch:** Add a `cancelled` state and `POST /jobs/:id/cancel`. Which transitions does it need? How does cancel reach a running `docker build`? (Hint: the scheduler already holds an `AbortController` per running job.)

### 6. Timeouts and a clean child environment ✅ *implemented: study it*

**Fixed:** [R1](production-readiness.md#r1-no-timeouts-a-single-request-can-hang-a-job-forever), [R6](production-readiness.md#r6-git-can-block-on-a-credential-prompt), [S5](production-readiness.md#s5-the-server-lends-its-own-git-credentials). See `runCommand`, `childEnv`, `GIT_ENV`, and `GIT_SAFE_CONFIG` in [`buildRunner.ts`](../src/buildRunner.ts).

**Study questions:**
1. Trace what happens, event by event, when a timeout fires on a process that ignores `SIGTERM`. Which code path rejects the promise, and when?
2. Why is `settle` guarded by a `settled` flag, even though a promise ignores a second `reject`?
3. Why must `HOME` and `DOCKER_*` be passed through to the docker CLI? (Hint: where does Docker keep its *context* setting?) What would break without them?
4. Killing the `docker` CLI may not stop the build inside the daemon. How would you find out? How would you make cancellation reliable?

**Stretch:** Run each job's child processes in their own *process group* (`detached: true`, then `process.kill(-pid)`), so a timeout also kills grandchildren such as git's `git-remote-https` helper.

### 7. Bounded logs and incremental reads ✅ *implemented: study it*

**Fixed:** [R3](production-readiness.md#r3-unbounded-memory-growth). See `planLogAppend` in [`jobs.ts`](../src/jobs.ts), `GET /jobs/:id/logs` in [`app.ts`](../src/app.ts), and [ADR-0007](adr/0007-log-storage.md).

The exercise asked to *drop the oldest* chunks. The implementation *keeps the head* instead.

**Study questions:**
1. Why does dropping the oldest chunks break `?after=<seq>` cursors? What does keeping the head give up, and what covers for it?
2. Why must the logs endpoint read the job's status *before* its logs? Construct the interleaving that goes wrong the other way round.
3. `runBuildJob` chains log writes (`logWrites = logWrites.then(...)`) and flushes before terminal transitions. Which test fails if you replace the chain with independent `appendLog` calls?

**Stretch:** Add Server-Sent Events as [exercise 11](#11-live-logs-over-server-sent-events) describes, using `seq` as the event id.

### 8. Graceful shutdown and startup recovery ✅ *implemented: study it*

**Fixed:** [R4](production-readiness.md#r4-no-durability-no-graceful-shutdown). See [`index.ts`](../src/index.ts), `shutdown` in [`scheduler.ts`](../src/scheduler.ts), [`recovery.ts`](../src/recovery.ts), and [ADR-0006](adr/0006-restart-and-shutdown.md).

The exercise said "on startup, delete everything under `WORK_DIR`". **The implementation deliberately refuses to.**

**Study questions:**
1. What could "delete everything under `WORK_DIR`" do if someone set `WORK_DIR=$HOME`? What does `sweepWorkDir` do instead?
2. Why are interrupted builds *failed* on restart, but queued jobs *resumed*?
3. Graceful shutdown and startup recovery overlap. Why is recovery the one you can't skip?
4. Signal tests in this repo's development sandbox "failed": the handler never ran. Read the "Verified outside the suite" section of [testing.md](testing.md#verified-outside-the-suite). What was actually wrong?

**Stretch:** Write an automated test that spawns the built server, sends `SIGTERM` mid-build to the Node PID, and asserts the exit code and job states. (A fake repo served over `file://` won't pass validation. How would you make it testable without weakening the allow-list?)

---

## Level 3: Architecture

### 9. A durable job repository ✅ *implemented: study it*

**Fixed:** [R4](production-readiness.md#r4-no-durability-no-graceful-shutdown), as described in [Evolving the system, step 1](evolving-the-system.md#step-1-make-the-store-an-interface-then-make-it-durable). See [`sqliteJobRepository.ts`](../src/sqliteJobRepository.ts), `repositoryContract` in [`jobs.test.ts`](../src/jobs.test.ts), and [ADR-0003](adr/0003-sqlite-job-store.md).

**Study questions:**
1. The interface is async although both implementations are synchronous inside. What migration mistake does that prevent?
2. What does the contract suite check that a test of SQLite alone would not?
3. Why is `appendLog` wrapped in `BEGIN IMMEDIATE`, not a plain `BEGIN`?
4. `node:sqlite` is experimental. Where is that risk contained, and what would it cost to switch to `better-sqlite3`?

**Stretch:** see [exercise 13](#13-a-postgres-repository).

### 10. An opt-in integration test

Write `src/integration.test.ts`, skipped unless `CLOUDFORGE_INTEGRATION=1`. It uses the default runner to build this repository's own URL and asserts `succeeded`, then removes the image. See [Testing](testing.md#known-gaps). Consider how you'd run it in CI: which job, how often, on which runners?

### 11. Live logs over Server-Sent Events

Add `GET /jobs/:id/logs/stream` with `Content-Type: text/event-stream`. Send each chunk as an event with `id: <seq>`, honour the `Last-Event-ID` header on reconnect, and close the stream when the job reaches a terminal state. Test it with `curl -N`.

### 12. Write an ADR: choosing the deploy target

No code. Write `docs/adr/0008-deploy-target.md` (the next free number; see the [ADR index](adr/README.md)) choosing a first deploy target for the next milestone (e.g. local `docker run`, Fly.io, Cloud Run, or ECS). Include:

- **Context:** what the users need and the constraints (cost, ops burden, the team's existing skills)
- **Options considered:** at least three, with honest pros and cons
- **Decision** and **consequences**, including what becomes harder
- **How you'd reverse it:** what would it take to add a second target later? (Hint: the `DeployTarget` interface.)

**You'll learn:** The most senior skill on this list, making a decision under uncertainty and writing it down so others can challenge it.

---

---

## Level 4: The next milestones

These have no solution in the repo yet. Each one is real roadmap work, so write an ADR first if the decision isn't obvious.

### 13. A Postgres repository

Implement `PostgresJobRepository`, add it to `repositoryContract`, and run the suite against a disposable Postgres (a CI service container). Then replace the in-process queue claim with `SELECT … FOR UPDATE SKIP LOCKED` plus a `lease_expires_at` column and a heartbeat. **Acceptance:** two server processes against one database never build the same job, and killing one process mid-build lets the other pick the job up after the lease expires.

### 14. Build a chosen ref

Accept an optional `ref` (branch, tag, or full commit SHA). Validate it (what characters can a ref contain, and which values would be dangerous as git arguments?). Branches and tags can use `git clone --branch`; a bare SHA can't. Record the resolved `commitSha` as today. Fixes the rest of [R7](production-readiness.md#r7-builds-are-not-reproducible).

### 15. Metrics

Expose `GET /metrics` in Prometheus format: jobs by terminal status (counter), build duration (histogram), queue depth and running builds (gauges). Decide whether `/metrics` needs protecting, and justify it in an ADR.

### 16. Retention and image garbage collection

Delete jobs and their logs older than `JOB_RETENTION_DAYS`, and remove their images. How do you delete in batches without long write locks? What if an image is in use by a running container?

### 17. Retries as attempts

Add automatic retries for *infrastructure* failures (Docker unreachable, timeout) but not *user* failures (bad Dockerfile). Model each try as an `attempt` row rather than moving a job backwards through the state machine (see [ADR-0004](adr/0004-job-state-machine.md#revisit-when)). How does a client see attempt history?

### 18. Isolated builds (design only)

Write a design doc and ADR for running builds off the API host in throwaway sandboxes (rootless BuildKit, Kaniko, or microVMs). Cover the network egress policy, per-build resource limits, cache sharing, how logs get back to the API, and how `BuildRunner` changes (hopefully not at all). This is [S2](production-readiness.md#s2-untrusted-builds-run-on-the-hosts-docker-daemon), the biggest open risk.

---

## Self-assessment

After finishing Levels 1–2, you should be able to answer these without looking at the code:

1. Why does `POST /deploy` return 202 and not 201 or 200?
2. Why is it safe to mutate the same `Job` object from the worker and read it from a request handler, and what change would make it unsafe?
3. Name two ways `docker build -f <user input>` is dangerous, beyond shell injection.
4. Why is cleanup in `finally` wrapped in its own `try`?
5. What's the difference between a liveness check and a readiness check, and which one should call `docker info`?
6. Why deploy by digest rather than by tag?
7. What property must `runBuildJob` have before you put a queue with at-least-once delivery in front of it? How does it have it today?
8. Why does `POST /deploy` call `scheduler.reserve()` *before* awaiting the database?
9. Why is startup recovery more important than graceful shutdown?
10. Why is `JobRepository` async when nothing that implements it needs to be?
