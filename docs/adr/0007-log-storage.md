# 0007. Store job logs as sequenced chunks with a head-keeping cap

- Status: Accepted
- Date: 2026-09-28

## Context

Logs were one ever-growing string on the job (R3). Every poll resent the whole thing, so a build cost O(n²) bytes to follow, and one noisy build could use unbounded memory. With a database, the string would also be rewritten on every chunk.

## Options considered

Storage:
1. **One text column, appended**: simple, but rewrites a growing value on every write.
2. **Rows of `(job_id, seq, text)`**: append-only inserts, and `seq` doubles as a pagination cursor.
3. **Object storage (S3)**: the right answer at scale. Overkill for one node.

Cap:
1. **Keep the tail** (drop old chunks): the end of a failed build is usually where the error is, but it breaks cursors that point at dropped chunks.
2. **Keep the head** and add a truncation marker: cursors stay valid, the start shows what ran, and the job's `error` field already records how it ended.

## Decision

Option 2 for storage, option 2 for the cap. `MAX_LOG_BYTES` defaults to 5 MiB, and the rule is shared by every repository through `planLogAppend` so the implementations can't disagree.

- `GET /jobs/:id/logs?after=<seq>&limit=<n>` returns new chunks, `nextSeq`, and `done`. `GET /jobs/:id` still returns the full (capped) `logs` string for compatibility and for `curl`.
- **The worker serialises log writes and flushes them before any terminal transition.** So "status is terminal" implies "every log line is stored".
- **The logs endpoint reads the job status before the logs.** Combined with the flush, `done = terminal && fewer chunks than the page size` can't report done while lines are still arriving. Reading in the other order could.

## Consequences

- A build that produces more than 5 MiB loses its end in `logs`. Its `error` and the marker still say what happened. Raise `MAX_LOG_BYTES` if that's common.
- Chunk boundaries are whatever the child process happened to write. Clients should join `text` values, not treat chunks as lines.

## Revisit when

- Logs need to outlive jobs, or be searched: move chunks to object storage and keep `seq` as the cursor.
- Clients want push instead of polling: Server-Sent Events can use `seq` as the event id, so reconnecting with `Last-Event-ID` works for free.
