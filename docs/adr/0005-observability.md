# 0005. Emit JSON event logs, and separate liveness from readiness

- Status: Accepted
- Date: 2026-09-28

## Context

The service logged one line at startup (O1). An operator couldn't answer "what is it doing?", "why did job X fail?", or "is it healthy?". `/health` only proved the process was up, so an orchestrator couldn't tell *alive but unable to build* (e.g. Docker down) from healthy.

## Options considered

1. **A logging library (pino)**: fast, levels, redaction, transports. One more dependency, and more API than we use today.
2. **A small JSON-lines logger of our own**: about 30 lines, no dependency, and an interface (`info/warn/error(event, fields)`) that pino can implement later without changing callers.
3. **Metrics (Prometheus) now**: better for rates and latency than logs. Needs an endpoint, naming conventions, and somewhere to scrape them.

## Decision

Option 2 for logs. Metrics are deferred.

- One JSON object per line: `{time, level, event, ...fields}`. Events are **stable dotted names** (`job.transition`, `http.request`, `shutdown.done`), so dashboards and alerts can match on them without parsing sentences.
- Every job event carries `jobId`, so one `grep` reconstructs a job's history.
- Request logs record `method`, `path` (not the full URL), `status`, and `durationMs`. **Bodies are never logged.** Query strings and bodies are where secrets end up.
- `/health` is **liveness**: returns 200 whenever the process can serve HTTP, and checks nothing else. Failing liveness gets a process *restarted*, and restarting doesn't fix Docker being down.
- `/ready` is **readiness**: checks the store, that the scheduler is accepting work, and that the Docker daemon answers (each check with a 3 s timeout). It returns `503` with per-check detail when unhealthy, and includes queue stats. Failing readiness takes an instance *out of rotation* without killing it.
- Tests inject `silentLogger`. Production injects `createJsonLogger()`.

## Consequences

- Rates and latency percentiles have to be derived from logs until metrics exist.
- `/ready` spawns `docker version` on every probe. That's fine at typical probe intervals (5–10 s); add caching if probes get more frequent.

## Revisit when

- Anyone needs an alert on a rate (failure %, queue depth over time): add Prometheus metrics.
- Log volume or redaction needs outgrow the tiny logger: swap in pino behind the same interface.
