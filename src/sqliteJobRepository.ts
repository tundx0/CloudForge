import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canTransition,
  DEFAULT_MAX_LOG_BYTES,
  IllegalTransitionError,
  JOB_STATUSES,
  planLogAppend,
  type Job,
  type JobRepository,
  type JobStatus,
  type LogPage,
  type NewJob,
  type TransitionPatch,
} from "./jobs.js";

/**
 * Append-only list of schema changes. `PRAGMA user_version` records how many
 * have been applied, so each runs exactly once per database. Never edit a
 * shipped migration; add a new one.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE jobs (
    job_id          TEXT PRIMARY KEY,
    status          TEXT NOT NULL CHECK (status IN (${JOB_STATUSES.map((s) => `'${s}'`).join(", ")})),
    repo_url        TEXT NOT NULL,
    dockerfile_path TEXT NOT NULL,
    image_tag       TEXT NOT NULL,
    commit_sha      TEXT,
    error           TEXT,
    log_bytes       INTEGER NOT NULL DEFAULT 0,
    log_truncated   INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX jobs_status_created ON jobs (status, created_at);
  CREATE TABLE job_logs (
    job_id TEXT NOT NULL REFERENCES jobs (job_id) ON DELETE CASCADE,
    seq    INTEGER NOT NULL,
    text   TEXT NOT NULL,
    PRIMARY KEY (job_id, seq)
  ) WITHOUT ROWID;
  `,
];

type JobRow = {
  job_id: string;
  status: JobStatus;
  repo_url: string;
  dockerfile_path: string;
  image_tag: string;
  commit_sha: string | null;
  error: string | null;
  log_bytes: number;
  log_truncated: number;
  created_at: string;
  updated_at: string;
};

function toJob(row: JobRow): Job {
  return {
    jobId: row.job_id,
    status: row.status,
    repoUrl: row.repo_url,
    dockerfilePath: row.dockerfile_path,
    imageTag: row.image_tag,
    commitSha: row.commit_sha,
    error: row.error,
    logBytes: row.log_bytes,
    logTruncated: row.log_truncated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * node:sqlite is synchronous, so each call briefly blocks the event loop.
 * Statements here are single-row and indexed, which keeps that to
 * microseconds. See docs/adr/0003-sqlite-job-store.md.
 */
export class SqliteJobRepository implements JobRepository {
  private readonly db: DatabaseSync;
  private readonly maxLogBytes: number;
  private closed = false;

  /** `filename` may be ":memory:" for tests. */
  constructor(filename: string, options: { maxLogBytes?: number } = {}) {
    if (filename !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    }
    this.db = new DatabaseSync(filename);
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  private migrate(): void {
    const { user_version: version } = this.db
      .prepare("PRAGMA user_version")
      .get() as { user_version: number };
    for (let i = version; i < MIGRATIONS.length; i += 1) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[i]);
        // PRAGMA does not accept bound parameters; `i` is a trusted integer.
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      });
    }
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  async create(input: NewJob): Promise<Job> {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs (job_id, status, repo_url, dockerfile_path, image_tag, created_at, updated_at)
         VALUES (?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(input.jobId, input.repoUrl, input.dockerfilePath, input.imageTag, now, now);
    return (await this.get(input.jobId))!;
  }

  async get(jobId: string): Promise<Job | undefined> {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as
      | JobRow
      | undefined;
    return row ? toJob(row) : undefined;
  }

  async transition(
    jobId: string,
    from: JobStatus,
    to: JobStatus,
    patch: TransitionPatch = {},
  ): Promise<boolean> {
    if (!canTransition(from, to)) {
      throw new IllegalTransitionError(from, to);
    }
    // The WHERE clause is the compare-and-set: it only matches if nobody else
    // has moved the job since the caller last looked.
    const result = this.db
      .prepare(
        `UPDATE jobs
            SET status = ?, error = COALESCE(?, error), commit_sha = COALESCE(?, commit_sha), updated_at = ?
          WHERE job_id = ? AND status = ?`,
      )
      .run(
        to,
        patch.error ?? null,
        patch.commitSha ?? null,
        new Date().toISOString(),
        jobId,
        from,
      );
    return Number(result.changes) === 1;
  }

  async appendLog(jobId: string, text: string): Promise<void> {
    if (text === "") {
      return;
    }
    this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT log_bytes, log_truncated,
                  (SELECT COALESCE(MAX(seq), 0) FROM job_logs WHERE job_id = ?) AS last_seq
             FROM jobs WHERE job_id = ?`,
        )
        .get(jobId, jobId) as
        | { log_bytes: number; log_truncated: number; last_seq: number }
        | undefined;
      if (!row) {
        return;
      }
      const plan = planLogAppend(row.log_bytes, row.log_truncated === 1, text, this.maxLogBytes);
      if (plan.text === null) {
        return;
      }
      this.db
        .prepare("INSERT INTO job_logs (job_id, seq, text) VALUES (?, ?, ?)")
        .run(jobId, row.last_seq + 1, plan.text);
      this.db
        .prepare(
          "UPDATE jobs SET log_bytes = ?, log_truncated = ?, updated_at = ? WHERE job_id = ?",
        )
        .run(plan.bytes, plan.truncated ? 1 : 0, new Date().toISOString(), jobId);
    });
  }

  async readLogs(jobId: string, afterSeq = 0, limit = 1000): Promise<LogPage> {
    const chunks = this.db
      .prepare(
        "SELECT seq, text FROM job_logs WHERE job_id = ? AND seq > ? ORDER BY seq LIMIT ?",
      )
      .all(jobId, afterSeq, limit)
      .map((row) => ({ seq: Number(row.seq), text: String(row.text) }));
    return { chunks, nextSeq: chunks.at(-1)?.seq ?? afterSeq };
  }

  async listByStatus(statuses: readonly JobStatus[]): Promise<Job[]> {
    if (statuses.length === 0) {
      return [];
    }
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN (${placeholders}) ORDER BY created_at, rowid`,
      )
      .all(...statuses) as JobRow[];
    return rows.map(toJob);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
