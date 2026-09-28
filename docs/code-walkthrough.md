# Code Walkthrough

A guided read of the source in the order the data flows. Open each file next to this page. Short excerpts are quoted, and the links go to exact lines.

**Suggested approach:** read a section, then answer its "check yourself" questions *before* reading on. If you can't answer, re-read the code, not this page.

---

## `src/index.ts` and `src/config.ts`: the composition root

[`index.ts`](../src/index.ts) is the **one place** that builds real dependencies: the SQLite store, the real runner, the JSON logger, the Docker readiness check. Everything else receives its dependencies as parameters. That's why tests never need Docker, git, a port, or a database file, and why this file is the least unit-tested in the codebase. Keep it as boring as possible.

The **order** of its steps is the design, and each step is commented with why:

1. `loadConfig()` first, so a typo stops the process before it touches disk.
2. Open the store, then `sweepWorkDir`, which removes clones left by a crashed process.
3. Build the runner and scheduler.
4. `recoverJobs` **before** `listen`: interrupted builds are marked failed and queued jobs are re-queued, so jobs accepted before the restart stay ahead of new ones.
5. `listen`.
6. On `SIGTERM`/`SIGINT`, shut down **in reverse**: stop accepting connections, `scheduler.shutdown(grace)` (wait, then abort), close idle and remaining connections, close the database, `exit(0)`. The `shuttingDown` flag makes a second signal harmless.

[`loadConfig`](../src/config.ts) turns environment variables into a typed `Config` and **throws on bad values**. The first version read `Number(process.env.PORT) || 3000`, so `PORT=abc` silently became 3000. Now it stops the process with `PORT must be an integer between 0 and 65535; got "abc"`. Bad config should crash at startup, where it's obvious, not surface later as confusing behaviour. `loadConfig` takes `env` as a parameter (defaulting to `process.env`), which is why its tests don't touch global state.

Some defaults are safety decisions:
- `HOST=127.0.0.1`: `app.listen(port)` with no host listens on every interface, and there's no auth.
- `ALLOWED_GIT_HOSTS` names three public hosts; `*` must be set explicitly.
- `SHUTDOWN_GRACE_MS=25000` sits under Kubernetes' default 30 s, so the process finishes its own shutdown before it's killed.
- `MAX_QUEUED_BUILDS=50`: a queue with no bound is a memory leak with extra steps.

Secure, bounded defaults matter because most people never change defaults.

**Check yourself:** `index.ts` uses top-level `await`. What would go wrong if `recoverJobs` ran *after* `listen`?

---

## `src/validation.ts`: input rules as pure functions

The rules used to live inline in the route handler. They now live in their own module with no Express and no I/O, so they're **pure**: data in, a result out. That's why [`validation.test.ts`](../src/validation.test.ts) can check about 40 cases in a few milliseconds with simple tables of inputs.

### `unknown` at the boundary

```ts
export function parseDeployRequest(body: unknown, allowedHosts: readonly string[] | null): ValidationResult<DeployInput>
```

The body is whatever JSON the client sent: maybe an object, maybe `"nope"`, maybe `null`. Typing it `unknown` **forces** the code to check before use. Declaring `repoUrl: string` would compile, but it would be a lie. After a check like `typeof repoUrl !== "string"` returns early, TypeScript *narrows* the type for the rest of the function.

> **Senior lens:** Your types are only as trustworthy as the boundary that produces them. Anything from the network, disk, env vars, or another service is `unknown` until validated. At scale, teams use a schema library ([zod](https://zod.dev), [valibot](https://valibot.dev)) so the validator and the type come from one definition and can't drift apart.

### A result type instead of exceptions

```ts
type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };
```

This is a *discriminated union*. Checking `parsed.ok` narrows the type, so TypeScript knows `parsed.value` exists only on the success branch. Invalid input is an **expected** outcome, not an exceptional one. Returning it as a value keeps the control flow visible, and the compiler makes the caller handle both cases. Exceptions are kept for things that really are exceptional, like `loadConfig` failing at startup.

The function returns **the parsed value**, trimmed and normalised (`./Dockerfile` becomes `Dockerfile`), not only a yes/no. Parse, don't just validate: the rest of the code then only ever sees clean data.

### The `repoUrl` rules, and the attack each one stops

| Rule | Stops |
| --- | --- |
| Must parse as a URL with protocol `http:` or `https:` | `file://`, `ssh://`, and argument injection: `--upload-pack=…` can't parse as a URL, so it can never reach `git` as a flag |
| No `username` or `password` in the URL | Tokens leaking into public logs ([S4](production-readiness.md#s4-credentials-in-repourl-leak-into-public-logs)) |
| `hostname` must be in `ALLOWED_GIT_HOSTS` | SSRF to internal addresses such as `169.254.169.254` ([S3](production-readiness.md#s3-ssrf-via-repourl)) |

Note the host check compares `url.hostname` **exactly**. A prefix or suffix check would accept `github.com.evil.example`, which has a test.

### The `dockerfilePath` rules

| Rule | Stops |
| --- | --- |
| No leading `-` | `-` makes `docker build -f -` read stdin and hang forever; `--anything` is a flag ([R1](production-readiness.md#r1-no-timeouts-a-single-request-can-hang-a-job-forever)) |
| Not absolute (POSIX or Windows) | `/etc/passwd` |
| After `path.posix.normalize`, not `..` and not starting with `../` | `../outside.txt`, `a/../../x`: reading host files through Docker's parse errors ([S1](production-readiness.md#s1-arbitrary-host-file-read-via-dockerfilepath)) |
| No NUL bytes; not a directory | Odd edge cases that confuse path APIs |

These checks are **syntactic only**. They can't know whether the repo contains a file called `Dockerfile` that's a symlink to `/etc/shadow`. That second check has to happen after cloning, in the runner. Defence in depth isn't about paranoia. Each layer can see something the others can't.

---

## `src/app.ts`: the HTTP layer

### Handlers are thin and async

Each route only translates: parse the input, call the store or scheduler, shape the response. Handlers are `async`, and **Express 5 forwards a rejected handler promise to the error middleware**. Express 4 didn't; a thrown error in an async handler there became an unhandled rejection. That's why there's no `try/catch` around every `await`.

### `POST /deploy`: the order of operations *is* the design

```ts
const parsed = parseDeployRequest(req.body, allowedGitHosts);   // 1. validate: 400
const reservation = scheduler.reserve();                         // 2. reserve: 503 if full
try { job = await jobs.create({...}); }                          // 3. persist
catch (err) { reservation.release(); throw err; }                //    …or give the slot back
reservation.enqueue(job.jobId);                                  // 4. hand to the scheduler
res.status(202).location(`/jobs/${job.jobId}`).json(body);       // 5. only now promise anything
```

- **Reserve before the first `await`.** Between steps 2 and 4 the handler awaits the database, and other requests run in that gap. If step 2 only *checked* capacity, every request in that gap would see room. `reserve()` claims the slot synchronously, so there's nothing to race. That's the general cure for check-then-act: make the check and the claim one step.
- **Release on failure.** If `create` throws, the slot is returned; otherwise every failed insert would permanently shrink the queue. Resource acquisition and release come in pairs, and the error path is where the release gets forgotten.
- **`503` + `Retry-After`, not `429`.** `429` means *you* are sending too much; `503` means *we* are busy. The header tells well-behaved clients when to come back, rather than retrying immediately, which would make the overload worse.
- **`Location` header.** The standard way for a `202` to say where the status can be checked. Generic HTTP clients understand it.

### `GET /jobs/:jobId/logs`: read order matters

```ts
const job = await jobs.get(id);                 // status FIRST
const page = await jobs.readLogs(id, after, limit);
done = isTerminal(job.status) && page.chunks.length < limit;
```

Suppose it read the logs first and the status second. It could read logs 1–5, then the build writes line 6 and finishes, then it reads status `succeeded`, and it would report `done: true` with line 6 missing forever. Reading the status first, combined with the worker storing all logs *before* a terminal transition, makes `done` trustworthy. Two operations that are each correct can still be wrong in combination.

`readQueryInt` accepts only `^\d+$`. `Number("1e3")` is `1000` and `Number("")` is `0`; both are valid numbers, and neither is what a client meant.

### Liveness vs readiness

`/health` checks *nothing*. `/ready` checks the store, the scheduler, and Docker, each with a timeout, and returns `503` with per-check detail. The distinction is operational: orchestrators **restart** a process that fails liveness, and **stop routing** to one that fails readiness. Restarting CloudForge doesn't fix Docker being down, so Docker belongs in readiness only.

### One error envelope, including for errors you didn't raise

Every error response is `{error, message}`: validation, `404`, `503`, *and* errors Express raises itself (malformed JSON, oversized body). The error middleware:

- must declare **four parameters** (`err, req, res, _next`). Express recognises error middleware by its arity, so removing the unused `_next` silently turns it into normal middleware.
- passes a 4xx message through only when `err.expose` is true (the http-errors convention for "safe to show clients").
- turns everything else into a generic `500` and logs the stack **server-side only**.

A catch-all `404` handler before it means even unknown routes return JSON.

---

## `src/jobs.ts`: the model, the rules, and the storage contract

### The state machine is data

```ts
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["cloning", "failed"],
  cloning: ["building", "failed"],
  building: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};
```

Rules expressed as a table rather than as `if` statements scattered through the worker are easy to read, easy to test (the test prints every allowed edge and compares it with a literal list), and easy to change in one place. `isTerminal` is *derived* ("no exits") rather than listed separately, so the two can never disagree.

`JobStatus` comes from `JOB_STATUSES as const`, so the type and the runtime list (used by SQLite's `CHECK` constraint) are one definition.

### The interface is async, even though nothing needs it yet

`JobRepository` returns promises although the in-memory and SQLite implementations are both synchronous inside. A future Postgres implementation *must* be async, and changing an interface from sync to async later means changing every caller. Deciding the shape now makes the storage swap a one-file change. [ADR-0003](adr/0003-sqlite-job-store.md).

### `transition` distinguishes bugs from races

```ts
transition(jobId, from, to, patch?): Promise<boolean>
```

- Not in the table → **throws** `IllegalTransitionError`. Something in our code is wrong, and it should be loud.
- In the table, but the job isn't in `from` any more → **returns `false`**. Someone else got there first. That's normal under concurrency, not an error.

Having separate channels for "you have a bug" and "you lost a race" is a pattern worth reusing. Treating both as exceptions makes races look like crashes; treating both as `false` hides bugs.

### Copies, not references

`InMemoryJobRepository` returns `{ ...job }` from every read. A database always returns fresh objects, and an in-memory fake that returns live references lets tests pass that production would fail: a caller mutates the object and the "store" changes. The contract suite checks this.

### One log-cap rule for everyone

`planLogAppend(currentBytes, alreadyTruncated, text, maxBytes)` is a pure function both repositories call. Policy that must be identical across implementations belongs in shared code, not copied into each one. It counts **bytes** (`Buffer.byteLength`), not string length: `"é".length` is 1, but it's 2 bytes on disk.

---

## `src/sqliteJobRepository.ts`: durability

- **Migrations** are an append-only array. `PRAGMA user_version` stores how many have been applied. Each migration runs in a transaction with its version bump, so a crash can't leave a half-migrated database. *Never edit a shipped migration*; add a new one.
- **`PRAGMA journal_mode = WAL`** lets readers proceed while a write is in progress. **`synchronous = NORMAL`** is the usual pairing for WAL: a power cut may lose the last few commits, but won't corrupt the file. **`busy_timeout`** waits for a lock instead of failing at once.
- **Compare-and-set in SQL:** `UPDATE jobs SET status = ? … WHERE job_id = ? AND status = ?`, then check `changes === 1`. No read-then-write, so no window for a race.
- **`appendLog` runs in a `BEGIN IMMEDIATE` transaction**: read the byte count and last `seq`, decide with `planLogAppend`, insert the chunk, update the counters. `IMMEDIATE` takes the write lock at the start, so two writers can't both read the same `last_seq`.
- **Every value is a bound parameter** (`?`). The one exception is `PRAGMA user_version = ${i + 1}`, because PRAGMAs don't accept parameters, and it's commented to say why the interpolation is safe.
- **The schema defends itself:** `CHECK (status IN (...))`, `NOT NULL`, a foreign key with `ON DELETE CASCADE`. If application code has a bug, the database refuses to store the nonsense.

---

## `src/scheduler.ts`: a bounded queue that knows nothing about builds

`BuildScheduler` takes `execute(id, signal)` and `onError(id, err)`. It doesn't import the worker, the store, or the runner. That keeps it tiny, reusable, and testable with plain promises.

### `pump` is the whole algorithm

```ts
while (accepting && running.size < concurrency && waiting.length > 0) {
  const id = waiting.shift()!;
  const promise = this.run(id, controller.signal).finally(() => {
    running.delete(id);
    this.pump();            // a finished task makes room for the next
  });
  running.set(id, { promise, controller });
}
```

There's no polling loop and no timer. The scheduler reacts to two events, "something was added" and "something finished", and both call `pump`. `.finally` runs in a later microtask, so `running.set` always happens before the matching `delete`.

### Reservations

`reserve()` returns a small object whose `enqueue` and `release` share a `used` flag, so a reservation can be consumed once. Pending reservations count against `maxQueued`. That's what makes the `POST /deploy` check-and-claim race-free. `enqueueRecovered` skips the limit, because recovered work was already accepted.

### `run` never rejects

```ts
try { await execute(id, signal); }
catch (err) { try { await onError(id, err); } catch { /* last line of defence */ } }
```

A rejected promise nobody handles is an `unhandledRejection`, which **crashes Node by default**, taking every other running build with it. The scheduler owns these promises, so it guarantees they settle cleanly.

### `shutdown(graceMs)`

Stop accepting → race "everything finished" against a timer → abort whatever's left through each task's `AbortController` → wait for them to wind down. Queued tasks aren't touched; with a durable store they're still `queued` on the next start. Aborting doesn't *kill* anything by itself. It asks, through the signal, and the runner turns that into `SIGTERM`/`SIGKILL`.

---

## `src/buildWorker.ts`: the procedure

### Claim, or do nothing

```ts
try { await moveTo("cloning"); }
catch (err) { if (err instanceof StaleJobError) return; throw err; }
```

The first transition is the claim. If it fails, another run owns the job, and **doing nothing is correct**. That makes `runBuildJob` idempotent, the property you need before putting any at-least-once queue in front of a worker. Recovery can re-queue a job that is somehow already running, and nothing bad happens.

`moveTo` also tracks the current `status` locally, so the failure path knows the right `from` for its final `transition(status, "failed")`.

### Logs are serialised and flushed

```ts
let logWrites = Promise.resolve();
const log = (chunk) => {
  logWrites = logWrites.then(() => jobs.appendLog(jobId, chunk)).catch(...);
};
```

Child output arrives through a *synchronous* callback, but storing it is *async*. Firing each write independently would let a slow store reorder them. Chaining each write onto the previous one keeps order, and `await flushLogs()` before every terminal transition means that once a job is `succeeded` or `failed`, its logs are complete. A test with a deliberately slow store proves both. A failed log write is logged for operators but doesn't fail the build.

### Clean before and after

`runner.cleanup(destDir)` runs *before* cloning as well as in `finally`. A previous attempt that was killed mid-clone may have left the directory, and `git clone` refuses a non-empty target. Starting from a clean slate is part of being safe to retry.

### Wiring lives next to the procedure

`createBuildScheduler` connects the generic scheduler to `runBuildJob`, and supplies an `onError` that logs, appends to the job log, and calls `failJob`. This is where "a worker bug" turns into "a failed job with a message" instead of "a crashed server".

### `imageTagFor` uses the whole id

It used to keep the first 8 hex characters: 32 bits, so collisions pass 50% odds at about 77,000 jobs (birthday bound: √(2·ln2·2³²)). The full UUID has 122 random bits. When a derived identifier needs to be unique, work out its collision odds; don't guess.

---

## `src/buildRunner.ts`: the edge of the world

### The interface is the contract

```ts
export type BuildRunner = {
  clone(repoUrl, destDir, log, signal?): Promise<{ commitSha: string }>;
  build(workDir, dockerfilePath, imageTag, log, signal?): Promise<void>;
  cleanup(dir): Promise<void>;
};
```

- Each step takes a `LogSink` callback instead of returning output. **Passing a callback in, rather than getting a buffer back**, is what makes streaming work: logs show up while `docker build` is still running.
- Each step takes an optional **`AbortSignal`**, the standard way to cancel async work in JavaScript. The scheduler owns the `AbortController`s; the runner only listens. Neither needs to know about the other's internals.
- `clone` **returns the commit it checked out** (`git rev-parse HEAD`, validated as 40 or 64 hex characters). "Build the default branch" is a moving target, and a deploy platform must always be able to say exactly what it built.

### `runCommand`: wrapping an event emitter in a promise

This is the most instructive function in the codebase. `spawn` gives you an `EventEmitter`, and the rest of the code wants a `Promise`. The bridge:

| Event | Meaning | Handling |
| --- | --- | --- |
| `stdout`/`stderr` `data` | A chunk of output | Forward to `log`, and keep the last 4 KB in `tail` for error sniffing |
| `error` | The process **could not start**, e.g. `ENOENT` (binary not found) | Reject with a friendly message |
| `close` | The process ended and its stdio streams are closed | Timed out → `CommandTimeoutError`; `code === 0` → resolve; otherwise sniff `tail` and reject |
| *timer fires* | The step ran past `timeoutMs` | `stop(CommandTimeoutError)`: `SIGTERM`, then `SIGKILL` 5 s later; `close` then rejects with it |
| *signal aborts* | The caller cancelled (e.g. shutdown) | `stop(CommandAbortedError)`, the same path as a timeout |

Subtleties, in the order a reviewer should check them:

- **`spawn(command, [...args])` with no `shell: true`.** The arguments go straight to `execve` and no shell parses them, so `;`, `$()`, and backticks inside `repoUrl` are inert. This is the single most important security property of this file. Don't add `shell: true`.
- **`close` rather than `exit`.** `exit` can fire before the stdout and stderr streams have been drained, so you'd lose the last lines of output. `close` waits for the streams.
- **One `stop(reason)` for every cause.** Timeout and abort are different *reasons* for the same *action*, so they share one function: record the reason, `SIGTERM`, schedule `SIGKILL`. `close` then rejects with the recorded reason. When two features look alike, check whether they're really one mechanism with two triggers.
- **An already-aborted signal never spawns.** `runCommand` checks `signal.aborted` first and rejects straight away. Starting a process only to kill it wastes resources and muddles the logs.
- **Remove the listener.** `settle` calls `signal.removeEventListener("abort", onAbort)`. One `AbortSignal` is shared by every command in a job, and forgetting this leaks a listener per command.
- **`settle` runs once.** A promise ignores a second `resolve` or `reject`, but the timers still need clearing on *whichever* path finishes first, and it has to be obvious that only one outcome wins. A small `settle` function with a `settled` flag does both. Look for this pattern whenever several events can end one operation.
- **A timeout needs a kill, and the kill needs a fallback.** A timer that only rejects the promise leaves the process running and holding resources. `SIGTERM` asks it to exit cleanly; `SIGKILL` can't be ignored.
- **`stdio: ["ignore", "pipe", "pipe"]`.** By default `spawn` gives the child a stdin pipe that nobody writes to or closes. `docker build -f -` reads its Dockerfile from stdin, so it waited forever (verified; [R1](production-readiness.md#r1-no-timeouts-a-single-request-can-hang-a-job-forever)). With `"ignore"` the child reads EOF at once. A test proves it with a child that echoes stdin until it ends.
- **`setEncoding("utf8")`.** A `data` chunk can end in the middle of a multi-byte UTF-8 character, and `chunk.toString()` would turn each half into `�`. With an encoding set, the stream holds back partial characters until the rest arrives.
- **Keep only the tail.** Error classification only needs the end of the output, so `tail` is capped at 4 KB. It used to be a second full copy of the logs ([R3](production-readiness.md#r3-unbounded-memory-growth)).
- **An allow-listed environment (`childEnv`).** Children used to get `process.env`, meaning every secret the server had ([S5](production-readiness.md#s5-the-server-lends-its-own-git-credentials)). Now only named variables pass through: `PATH`, `HOME`, locale, proxy settings, and the `DOCKER_*` variables that tell the CLI which daemon to use. **Allow-lists fail safe.** A new secret added to the server's environment next year is withheld automatically, whereas a block-list would have to remember it.

### Hardening git

```ts
run("git", [...GIT_SAFE_CONFIG, "clone", "--depth", "1", "--", repoUrl, destDir],
    { env: childEnv(process.env, GIT_ENV), ... })
```

| Setting | Effect |
| --- | --- |
| `GIT_TERMINAL_PROMPT=0` | Never ask for a username or password; fail instead ([R6](production-readiness.md#r6-git-can-block-on-a-credential-prompt)) |
| `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` | Ignore the operator's system and user git config |
| `-c credential.helper=` | An empty value **resets** the list of credential helpers, including ones set in places the variables above don't cover |
| `-c core.askPass=` | No graphical or scripted password prompt |
| `--` before the URL | Everything after it is a positional argument, never an option. Validation already stops a leading `-`; this makes the command safe on its own. |

Verified on a machine with the macOS keychain helper configured: cloning a nonexistent GitHub repo now fails at once with `terminal prompts disabled`, instead of trying the operator's stored GitHub credentials.

### The Dockerfile check after cloning: `resolveInside`

```ts
const dockerfile = await resolveInside(workDir, dockerfilePath);
await run("docker", ["build", "-f", dockerfile, "-t", imageTag, "."], ...);
```

`resolveInside` calls `realpath` on both the clone and the Dockerfile. That follows **every** symlink, so a repo that contains `Dockerfile -> /etc/shadow` resolves to `/etc/shadow`. It then uses `path.relative` to reject anything outside the clone. A missing file gets its own clear message (`Dockerfile not found in repository: …`) instead of a Docker error.

Docker then receives the resolved **absolute** path. That's a subtle extra benefit: an absolute path starts with `/`, so it can never be read as a flag.

> **Senior lens:** There's a gap between *checking* a path and *using* it, known as TOCTOU (time-of-check to time-of-use). If something could swap the file in between, the check would be worthless. Here nothing else writes to the clone after `git clone` finishes, and Docker gets the resolved path rather than the original. When you check a path, ask what could change it before it's used.

### Dependency injection with a default parameter

```ts
export function createDefaultBuildRunner(run: RunCommand = runCommand, options: BuildRunnerOptions = {}): BuildRunner
```

This is the second seam. Production calls it with real timeouts, and a test calls `createDefaultBuildRunner(fakeRun)` to check the **exact argv, environment, and timeouts** without running anything. You get DI without a DI framework: a function parameter with a default. The timeouts also have safe defaults (2 min for cloning, 15 min for building), so a runner created without options still can't hang forever.

### Small details that show care

- `mkdir(path.dirname(destDir), { recursive: true })` creates the *parent* only, because `git clone` insists on creating the target directory itself and fails if it already exists and isn't empty.
- `docker build ... "."` with `cwd: workDir` makes the clone the build context.
- Non-zero exits report `git exited with code 128`, not the whole command line. The full command, with all the `-c` flags, is already in the log, and repeating it in `error` made that field hard to read.

---

## `src/recovery.ts`: what a restart means

Two functions, both run by `index.ts` before it starts listening:

- **`sweepWorkDir`** deletes leftover clone directories, **but only UUID-named ones**. `rm -rf` on a directory from configuration is how tools delete home directories. Matching only the names CloudForge itself creates makes a misconfigured `WORK_DIR` harmless. When code deletes things, make it only able to delete what it made.
- **`recoverJobs`** applies the restart policy from [ADR-0006](adr/0006-restart-and-shutdown.md): jobs caught mid-build are `failed` with a clear message (retrying them could crash-loop the server if they caused the crash), and jobs that never started are re-queued oldest first (breaking the `202`'s promise would be worse than a slightly longer queue).

Its doc comment explains *why* each state gets the treatment it does. For policy code, the reasoning is the part future readers need most.

---

## Why imports end in `.js`

```ts
import { runBuildJob } from "./buildWorker.js";   // the file is buildWorker.ts
```

`tsconfig.json` uses `"module": "NodeNext"` and `package.json` has `"type": "module"`, so the output is native ES modules. Node's ESM loader **does not guess file extensions**, and TypeScript **does not rewrite import paths** when it compiles. So you write the path that will exist *at runtime*, `./buildWorker.js`, and TypeScript is smart enough to find `buildWorker.ts` at compile time. It looks wrong the first time, but it's correct.

There are two TypeScript configs, and the split is deliberate:

| File | Used by | Includes tests? | Emits? |
| --- | --- | --- | --- |
| `tsconfig.json` | `pnpm typecheck`, your editor | **Yes** | No (`noEmit`) |
| `tsconfig.build.json` | `pnpm build` | No (excludes `*.test.ts` and `testSupport.ts`) | Yes, to `dist/` |

Originally one config did both, and it excluded tests, so **nothing ever type-checked the tests**; `tsx` strips types without checking them. When `BuildRunner.clone` started returning `{ commitSha }`, the new type-check flagged every fake that still returned `void`.

Other notes:

- `"strict": true` should be non-negotiable in new TypeScript code. It turns on `strictNullChecks`, which is what makes `jobs.get(id)` return `Job | undefined` and forces you to handle the miss.
- `noImplicitOverride` and `noFallthroughCasesInSwitch` are cheap extra checks that catch real bugs.
- The old `"declaration": true` (emit `.d.ts` files) was dropped. That's for libraries, and this is an app.

---

## Summary: patterns to take away

| Pattern | Where | Use it when |
| --- | --- | --- |
| App factory | `createApp` | Anything you want to test without starting a real server |
| Ports and adapters | `BuildRunner` / `createDefaultBuildRunner` | Business logic that has to call the outside world |
| DI via default parameter | `createDefaultBuildRunner(run = runCommand)` | One seam, no framework |
| `unknown` at the boundary | `parseDeployRequest(body: unknown)` | Every input you don't control |
| Result type for expected failures | `ValidationResult<T>` | Invalid input, not-found, anything the caller must handle |
| Fail fast on bad config | `loadConfig` | Every setting read at startup |
| Allow-lists over block-lists | `childEnv`, `ALLOWED_GIT_HOSTS` | Anything security-relevant |
| Check, then use the checked value | `resolveInside` → absolute `-f` path | Paths and other values that could change between check and use |
| DTO mapping | `toJobResponse` | Separating what you store from what you promise |
| 202 + status resource | `POST /deploy`, `GET /jobs/:id` | Work that takes longer than a request should |
| try / catch / finally with isolated cleanup | `runBuildJob` | Any procedure that acquires a resource |
| Promise over EventEmitter | `runCommand` | Wrapping callback- or event-based APIs |
| Spawn with an argv array, closed stdin, a timeout, and abort | `runCommand` | Every time you run a subprocess |
| State machine as a table | `TRANSITIONS` in `jobs.ts` | Any entity with a lifecycle |
| Compare-and-set | `transition(id, from, to)` | Any update that can race |
| Separate "bug" from "lost race" | throw `IllegalTransitionError` vs return `false` | Concurrency-aware APIs |
| Claim then work (idempotent worker) | `runBuildJob` | Anything behind an at-least-once queue |
| Reserve, then await | `scheduler.reserve()` in `POST /deploy` | Capacity checks that span an `await` |
| Serialise async writes, flush before terminal | `logWrites` chain in `runBuildJob` | Ordered side effects from sync callbacks |
| Contract tests | `repositoryContract(...)` | Every interface with more than one implementation |
| Versioned, append-only migrations | `MIGRATIONS` + `user_version` | Every persistent schema |
| Recover before serving; shut down in reverse | `index.ts` | Every long-running service |
| Delete only what you created | `sweepWorkDir` | Any cleanup driven by configuration |
