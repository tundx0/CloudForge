# Production Readiness Review

This is the review a senior engineer would write before letting CloudForge accept traffic from anyone other than its author. It's meant to teach **how to review a system**, not just what's wrong with this one.

The code is a well-structured prototype, and many of these findings are expected for its milestone. The purpose is to make every gap *visible* so that each one is either fixed or explicitly accepted.

## How to read this

- **Severity** reflects impact if CloudForge were reachable by untrusted users. For a laptop-only prototype, most of these are acceptable, and you should be able to say *why*.
- **Status** tracks fixes made after the review. The finding text describes the code as originally reviewed (commit `961c7ef`), and each fixed finding opens with a note on what changed. Keeping the original analysis is deliberate: the *before* is what teaches.
- **Evidence** says how each finding was established. *Verified* means it was reproduced by running code. *Reasoned* means it follows from reading the code and documented tool behaviour but wasn't reproduced. Keeping those two apart is a habit worth copying.

## Summary

| ID | Finding | Severity | Evidence | Status |
| --- | --- | --- | --- | --- |
| [S1](#s1-arbitrary-host-file-read-via-dockerfilepath) | `dockerfilePath` can read any file on the host into public logs | **Critical** | Verified | ✅ Fixed |
| [S2](#s2-untrusted-builds-run-on-the-hosts-docker-daemon) | Untrusted Dockerfiles run on the host's Docker daemon | **Critical** (by design) | Reasoned | Open |
| [S3](#s3-ssrf-via-repourl) | `repoUrl` can target internal networks (SSRF) | High | Verified (accepted by API) | 🟡 Mitigated |
| [S4](#s4-credentials-in-repourl-leak-into-public-logs) | Credentials embedded in `repoUrl` leak into logs | High | Verified | ✅ Fixed |
| [S5](#s5-the-server-lends-its-own-git-credentials) | Child processes inherit the server's env and git credentials | Medium–High | Reasoned | ✅ Fixed |
| [S6](#s6-no-authentication-or-authorization) | No authentication or authorization | High (outside localhost) | Verified | 🟡 Mitigated |
| [S7](#s7-malformed-json-returns-an-html-stack-trace) | Malformed JSON returns an HTML stack trace | Low–Medium | Verified | ✅ Fixed |
| [R1](#r1-no-timeouts-a-single-request-can-hang-a-job-forever) | No timeouts; `dockerfilePath: "-"` hangs a build forever | High | Verified | ✅ Fixed |
| [R2](#r2-unbounded-concurrency) | Unlimited concurrent builds | High | Reasoned | ✅ Fixed |
| [R3](#r3-unbounded-memory-growth) | Jobs and logs grow in memory forever | Medium | Reasoned | ✅ Fixed |
| [R4](#r4-no-durability-no-graceful-shutdown) | No durability, no graceful shutdown, orphaned clone dirs | Medium | Reasoned | ✅ Fixed |
| [R5](#r5-image-tag-collisions-and-unbounded-image-growth) | 32-bit image tags collide; images never pruned | Low–Medium | Reasoned (math) | 🟡 Mostly fixed |
| [R6](#r6-git-can-block-on-a-credential-prompt) | git can block on a credential prompt | Medium | Reasoned | ✅ Fixed |
| [R7](#r7-builds-are-not-reproducible) | Builds aren't pinned to a commit | Medium | Reasoned | 🟡 Partly fixed |
| [R8](#r8-the-state-machine-is-not-enforced) | State transitions aren't enforced | Low | Reasoned | ✅ Fixed |
| [O1](#o1-observability) | No structured logs, metrics, or readiness check | Medium | Reasoned | 🟡 Mostly fixed |

---

## Security

### S1. Arbitrary host file read via `dockerfilePath`

> **Status: fixed** on `fix/security-hardening`. [`validation.ts`](../src/validation.ts) rejects absolute paths, paths that leave the repo, and a leading `-`. [`resolveInside`](../src/buildRunner.ts) re-checks after cloning with symlinks resolved, and `docker build` receives the resolved absolute path. Both layers have tests.

**What:** `dockerfilePath` is passed straight to `docker build -f`. It's resolved relative to the clone directory, so `../` escapes the clone. Modern Docker (BuildKit) happily reads a Dockerfile from **outside** the build context. When the file isn't a valid Dockerfile, the parser error **prints the offending line**, and that output goes into the job logs, which `GET /jobs/:id` returns to anyone.

**Evidence (verified):** A file outside the build context, containing `secret-line-1: TOPSECRET`, was used with `docker build -f ../outside.txt .`. Docker's output:

```
outside.txt:1
--------------------
   1 | >>> secret-line-1: TOPSECRET
--------------------
ERROR: failed to build: failed to solve: dockerfile parse error on line 1: unknown instruction: secret-line-1:
```

The API also accepts `{"dockerfilePath": "../../../etc/passwd"}` with `202`. An absolute path like `/etc/passwd` passes validation too, and should behave the same way (reasoned, not reproduced).

**Why it's bad:** Any readable file on the host (config, `.env`, SSH keys) can be leaked, at least its first lines, by one unauthenticated request.

**Fix:** Validate `dockerfilePath` at the boundary. It must be relative, must not start with `-`, and after `path.posix.normalize` must not start with `..`. Then, in the runner, resolve it against the clone dir and check that it stays inside, **after resolving symlinks** (`fs.realpath`), because the repo itself can contain a symlink named `Dockerfile` pointing at `/etc/shadow`. That symlink case is why checking only at the API layer isn't enough. This is [exercise 2](exercises.md).

> **Senior lens:** "User input becomes a CLI argument" is always a question of *how the tool interprets that argument*, not just "is there shell injection". Read the tool's docs for every flag you pass user data to.

### S2. Untrusted builds run on the host's Docker daemon

**What:** `docker build` runs every `RUN` instruction in the Dockerfile. Those instructions come from whatever repo the caller chooses.

**Why it's bad:**
- `RUN` steps have **network access** by default. They can reach the host's internal network, cloud metadata endpoints, and other services.
- The build uses the **host's daemon**, so it shares its image cache (and can poison cached layers used by other builds), its disk, and its CPU.
- Access to the Docker daemon is effectively **root on the host**. Anyone who can talk to the daemon can run a container that mounts `/`. CloudForge doesn't expose the socket to builds, but the daemon is a very high-value neighbour.
- A malicious build can simply consume unlimited resources ([R2](#r2-unbounded-concurrency)).

**Fix:** This is architectural, not a patch. Real build platforms run untrusted builds in **isolation**: rootless BuildKit, Kaniko or Buildah in unprivileged containers, or better, a throwaway microVM (Firecracker, gVisor) per build on dedicated build hosts, with egress controls. See [Evolving the system: isolate the builder](evolving-the-system.md#step-3-isolate-the-builder).

> **Senior lens:** The most important security question for any "we run your code" product is *where does the code run, and what can it reach*. Everything else is secondary.

### S3. SSRF via `repoUrl`

> **Status: mitigated.** `repoUrl` must point at a host in `ALLOWED_GIT_HOSTS` (default `github.com`, `gitlab.com`, `bitbucket.org`). Setting `ALLOWED_GIT_HOSTS=*` brings the full risk back. The IP-range checks described below are still needed if arbitrary hosts are ever allowed.

**What:** Validation checks that the protocol is `http(s)` but not where the URL points. `http://169.254.169.254/latest/meta-data/` (the cloud metadata service), `http://localhost:6379`, and `http://10.0.0.5/admin` are all accepted, and the server makes git fetch them.

**Evidence (verified):** `POST /deploy {"repoUrl":"http://169.254.169.254/latest"}` returns `202`, and the runner receives the URL.

**Why it's bad:** *Server-Side Request Forgery.* The server makes requests to places the attacker can't reach directly. Git's error output, which goes into public logs, can reveal what's there. Git also follows HTTP redirects, so validating only the hostname isn't enough.

**Fix:** Resolve the hostname and reject private, loopback, link-local, and metadata ranges. Pin the resolved IP for the actual connection (otherwise DNS rebinding gets around the check). Better still, allow-list git hosts (`github.com`, `gitlab.com`, …) until there's a reason not to, and set `-c http.followRedirects=false`. Network egress policy at the infrastructure level is the backstop.

### S4. Credentials in `repoUrl` leak into public logs

> **Status: fixed.** URLs with a username or password are rejected with `400`. Log redaction was not added, because nothing with credentials can get that far.

**What:** A user who wants to build a private repo will naturally try `https://user:TOKEN@github.com/org/repo`. The worker logs `Cloning <repoUrl>…` verbatim. The token also appears in the returned `repoUrl` field and in any git error message, `git clone … exited with code 128`.

**Evidence (verified):** Posting `https://user:ghp_SECRET@github.com/x/y` produced job logs containing `ghp_SECRET`.

**Fix:** Reject URLs with `url.username` or `url.password` at validation time, and add a proper credentials mechanism later (stored secrets, a GitHub App). As defence in depth, redact `//user:pass@` from anything written to logs or errors.

### S5. The server lends its own git credentials

> **Status: fixed.** Children get an allow-listed environment (`childEnv`). git runs with `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `-c credential.helper=`, and `-c core.askPass=`. Verified: cloning a nonexistent GitHub repo on a machine with `osxkeychain` configured now fails at once with `terminal prompts disabled`. Running as a dedicated service user is still recommended.

**What:** `spawn(..., { env: process.env })` gives git and docker the server's entire environment, and git also reads the server user's `~/.gitconfig`. If that config has a credential helper (on macOS, `osxkeychain` is common, and it's configured on the machine where these docs were written), **git will authenticate using the server operator's stored credentials**.

**Why it's bad:** It's a *confused deputy*. An anonymous caller can ask CloudForge to clone a private repo that *the operator* can access, and then read the source through build logs, or run it via `RUN`. Environment variables such as cloud keys are also visible to the child processes.

**Fix:** Build a minimal env for children (`PATH`, `HOME` pointing at an empty dir, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`) and pass `-c credential.helper=`. Run the service as a dedicated user with no personal credentials.

### S6. No authentication or authorization

> **Status: mitigated.** The server binds to `127.0.0.1` by default (`HOST`). Authentication is still open and belongs to the Auth + projects milestone.

**What:** Anyone who can reach the port can start builds and read any job whose id they know.

The job id is a random UUIDv4 (122 random bits), so guessing one isn't practical. The id works as a *capability*. That's acceptable for reads, but ids leak through logs, browser history, and screenshots, and nothing limits who can *create* jobs.

**Fix:** This is the "Auth + projects" milestone: API keys, jobs owned by a project, authorization checks on `GET`. Until then, bind to `127.0.0.1` rather than all interfaces. `app.listen(port)` binds to every interface by default.

### S7. Malformed JSON returns an HTML stack trace

> **Status: fixed.** An error middleware in [`app.ts`](../src/app.ts) returns the standard JSON envelope for malformed bodies and a generic `500` for unexpected errors, without stack traces.

**Evidence (verified):** `POST /deploy` with body `{oops` returns `400` with `Content-Type: text/html` and a `<pre>SyntaxError: … at JSON.parse …</pre>` body containing file paths from `node_modules`. The stack trace is also written to stderr.

**Why it's bad:** It breaks the API's own `{error, message}` contract, so clients can't parse it, and it leaks internal paths. Express hides stack traces only when `NODE_ENV=production`, and nothing sets that.

**Fix:** Add an error-handling middleware (4 arguments) after the routes that maps `err.type === "entity.parse.failed"` to `400 {error:"invalid_request"}` and everything else to `500 {error:"internal"}`, and run with `NODE_ENV=production`. This is [exercise 1](exercises.md).

---

## Reliability

### R1. No timeouts: a single request can hang a job forever

> **Status: fixed.** `stdio` is `["ignore", "pipe", "pipe"]`, so children see EOF on stdin, and every git and docker call has a timeout (`CLONE_TIMEOUT_MS`, `BUILD_TIMEOUT_MS`) that sends `SIGTERM` and then `SIGKILL` after 5 s. Verified live: with a 50 ms clone timeout, the job failed with `git timed out after 50ms` and no git process remained. **Caveat, not verified:** stopping the `docker` CLI may not stop a build already running inside the daemon.

**What:** `runCommand` waits for `close` with no deadline. `spawn` leaves stdin as an open pipe. Any child that waits for input, or just runs slowly, blocks its job indefinitely.

**Evidence (verified):** `docker build -f - -t probe .` spawned the same way as `runCommand` (stdin a pipe, never closed) was **still running after 8 seconds**, waiting to read a Dockerfile from stdin. With CloudForge, `{"dockerfilePath": "-"}` would leave the job in `building` permanently. A slow clone or a build that runs `sleep infinity` has the same effect.

**Fix:**
- Set `stdio: ["ignore", "pipe", "pipe"]` so children get EOF on stdin immediately.
- Add a per-step timeout using an `AbortSignal`: `spawn(cmd, args, { signal: AbortSignal.timeout(ms) })`, then `SIGKILL` if the process ignores `SIGTERM`.
- Reject `dockerfilePath` values starting with `-` ([S1](#s1-arbitrary-host-file-read-via-dockerfilepath)).
- Note that killing the `docker` CLI doesn't necessarily stop the build inside the daemon. Robust cancellation needs the daemon API or BuildKit's own cancellation.

> **Senior lens:** Every call to something outside your process needs a timeout. "It'll finish eventually" is not an operating model.

### R2. Unbounded concurrency

> **Status: fixed** ([ADR-0002](adr/0002-in-process-scheduler.md)). `MAX_CONCURRENT_BUILDS` (default 2) run at once and `MAX_QUEUED_BUILDS` (default 50) wait. Beyond that, `POST /deploy` returns `503` with `Retry-After: 30`. Capacity is reserved before any `await`, so concurrent requests can't overfill the queue. Verified live and in tests. Per-client rate limiting is still open and belongs with auth.

**What:** Every `POST /deploy` starts a clone and a build immediately. A hundred requests start a hundred `docker build`s on one machine.

**Why it's bad:** CPU, memory, disk, and file descriptors run out, and *every* build slows down or fails, not only the extra ones. It's also trivially abusable ([S6](#s6-no-authentication-or-authorization)).

**Fix:** Add a `queued` status and a concurrency limit (a semaphore). Jobs over the limit wait. Expose queue depth. Add per-client rate limiting and a maximum queue length that returns `429` or `503` when full (*load shedding*). This is [exercise 4](exercises.md).

### R3. Unbounded memory growth

> **Status: fixed** ([ADR-0007](adr/0007-log-storage.md)). Logs are stored as sequenced chunks in SQLite, capped per job by `MAX_LOG_BYTES` (default 5 MiB; head kept, marker added). `GET /jobs/:id/logs?after=` returns only new chunks. Jobs live on disk, not in memory. Deleting old jobs (retention) is still open.

- The `JobStore` `Map` never evicts. Every job ever created lives until restart.
- `job.logs` grows without limit, and `runCommand` keeps a second full copy in `combined` for the duration of each command.
- `GET /jobs/:id` sends the full log on every poll (O(n²) bytes over a build), and serialising a multi-megabyte string blocks the event loop.

**Fix:** Cap logs (keep the last N KB, or better, stream them to a file or object storage), keep only a bounded tail for error sniffing, evict or persist finished jobs, and add `?since=<offset>` to the job endpoint.

### R4. No durability, no graceful shutdown

> **Status: fixed** ([ADR-0003](adr/0003-sqlite-job-store.md), [ADR-0006](adr/0006-restart-and-shutdown.md)). Jobs survive restarts in SQLite. On startup, UUID-named clone directories are swept, in-flight jobs are failed with a clear message, and queued jobs resume in order. `SIGTERM`/`SIGINT` trigger graceful shutdown with a grace period, then abort. Both shutdown paths and the restart were verified live against real git and Docker.

- A restart (deploy, crash, OOM) loses every job. Clients polling get `404` for jobs that really did exist.
- In-flight builds are orphaned. The `docker build` may keep running in the daemon, and `.work/<jobId>` directories are never swept.
- There's no `SIGTERM` handler. Orchestrators like Kubernetes send `SIGTERM` and wait (30 s by default) before killing. A well-behaved service stops accepting new work, finishes or checkpoints current work, then exits.

**Fix:** Persist jobs (SQLite is enough for one node), mark jobs that were in flight at startup as `failed: "interrupted"`, sweep `WORK_DIR` at startup, and add graceful shutdown ([exercise 8](exercises.md)).

### R5. Image tag collisions and unbounded image growth

> **Status: mostly fixed.** Tags use the full job id (122 random bits). Image garbage collection and deploy-by-digest are still open (the digest belongs to the Deploy target milestone).

`imageTagFor` keeps 8 hex characters of the UUID, which is **32 bits**. By the birthday bound, the chance of at least one collision passes 50% at about √(2 · ln 2 · 2³²) ≈ **77,000 jobs**. A collision silently repoints the tag at a different build. Separately, images are never removed, so disk fills up.

**Fix:** Use the full job id in the tag (or a project name plus a counter). When you deploy, **deploy by digest** (`image@sha256:…`) rather than by tag, since tags are mutable pointers. Add image garbage collection.

### R6. git can block on a credential prompt

> **Status: fixed** as part of S5 (`GIT_TERMINAL_PROMPT=0`).

For a private or non-existent repo over HTTPS, git may try to prompt for a username. If CloudForge was started from a terminal, git can open `/dev/tty` and **wait for input nobody will give**, the same failure mode as R1. Setting `GIT_TERMINAL_PROMPT=0` makes git fail fast instead.

### R7. Builds are not reproducible

> **Status: partly fixed.** Every build records the exact `commitSha` it built (verified live against GitHub's `HEAD`). Choosing a branch, tag, or commit (`ref`) is still open.

There's no `ref` or commit SHA in the request, so the same `POST` builds whatever the default branch is at that moment. Nothing records which commit was actually built. For a deploy platform, "what exactly is running?" must always have an answer.

**Fix:** Accept an optional `ref`, record the resolved commit SHA (`git rev-parse HEAD` after cloning), and return it in the job.

### R8. The state machine is not enforced

> **Status: fixed** ([ADR-0004](adr/0004-job-state-machine.md)). A transition table in `jobs.ts`; `transition(id, from, to)` is compare-and-set in both repositories (`UPDATE … WHERE status = ?` in SQLite); terminal states are final; illegal moves throw. The worker claims jobs by CAS, which makes it idempotent.

`JobStore.setStatus` accepts any transition. Today the worker calls it in the right order, but the model doesn't *guarantee* that. `fail` would also overwrite `succeeded`. Once you add retries, cancellation, or a second worker, unenforced transitions turn into real bugs: a slow worker can mark a cancelled job as `succeeded`.

**Fix:** A transition table (`allowed: Record<JobStatus, JobStatus[]>`) checked in `setStatus` and `fail`, where terminal states are final. With a database, do it as a conditional update: `UPDATE jobs SET status='building' WHERE id=? AND status='cloning'`.

---

## Operability

### O1. Observability

> **Status: mostly fixed** ([ADR-0005](adr/0005-observability.md)). JSON-lines logs with stable event names and `jobId` on every job event; request logs (method, path, status, duration; never bodies); `/ready` checks the store, the scheduler, and Docker, and returns `503` with details. Metrics (Prometheus) are still open.

- **Logs:** a single `console.log` at startup. There's no request logging, no structured (JSON) logs, and no correlation between a request and the job it created.
- **Metrics:** none. You can't answer "how many builds are running?", "what's the p95 build time?", or "what's the failure rate?".
- **Health:** `/health` is a *liveness* check (the process is up). There's no *readiness* check (the process can do useful work, e.g. `docker info` succeeds). An orchestrator can't tell "alive but broken" from healthy.

**Fix:** A structured logger (pino) with the `jobId` on every line, and counters and histograms for jobs by status and build duration. Add `/ready`, which checks Docker reachability and that the queue is below capacity.

---

## If you had one week

*All five days below are done, except the IP-range checks for arbitrary hosts (an allow-list was chosen instead; see [ADR-0001](adr/0001-security-defaults.md)). The plan is kept as written so you can compare what was planned with what was built, including where the design changed along the way (e.g. an in-process scheduler rather than a semaphore, and graceful shutdown with abort rather than wait-only).*

Prioritise by *risk reduced per hour of work*:

1. **Day 1:** Bind to localhost. Validate `dockerfilePath` (relative, no `..`, no leading `-`), reject credentials in URLs, add a JSON error middleware. *(S1, S4, S7, R1-partial)*
2. **Day 2:** Minimal child env, `GIT_TERMINAL_PROMPT=0`, stdin ignored, per-step timeouts. *(S5, R1, R6)*
3. **Day 3:** Concurrency limit with a `queued` state, and a log size cap. *(R2, R3)*
4. **Day 4:** SQLite-backed store behind the existing `JobStore` interface, startup recovery, graceful shutdown. *(R4, R8)*
5. **Day 5:** Structured logging, basic metrics, `/ready`, a host allow-list for `repoUrl`. *(O1, S3)*

S2 (isolation) doesn't fit in the week. Record it as an explicit, dated risk acceptance ("only trusted internal users until isolated builders ship") and plan it as its own project. **Knowing which problems can't be patched is part of the job.**
