export const JOB_STATUSES = [
  "queued",
  "cloning",
  "building",
  "succeeded",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The only legal moves. Terminal states have no exits, so a late or duplicate
 * writer can never resurrect a finished job.
 */
const TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["cloning", "failed"],
  cloning: ["building", "failed"],
  building: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: JobStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export class IllegalTransitionError extends Error {
  constructor(from: JobStatus, to: JobStatus) {
    super(`Illegal job transition ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export type Job = {
  jobId: string;
  status: JobStatus;
  repoUrl: string;
  dockerfilePath: string;
  imageTag: string;
  commitSha: string | null;
  error: string | null;
  logBytes: number;
  logTruncated: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NewJob = {
  jobId: string;
  repoUrl: string;
  dockerfilePath: string;
  imageTag: string;
};

export type TransitionPatch = {
  error?: string;
  commitSha?: string;
};

export type LogChunk = { seq: number; text: string };

export type LogPage = {
  chunks: LogChunk[];
  /** Pass back as `afterSeq` to continue. Equals the input when nothing is new. */
  nextSeq: number;
};

/**
 * Storage for jobs and their logs. Async even for the in-memory version so a
 * networked database can implement it without changing callers.
 */
export interface JobRepository {
  create(input: NewJob): Promise<Job>;
  get(jobId: string): Promise<Job | undefined>;
  /**
   * Compare-and-set. Applies only if the job is currently in `from`, and
   * returns whether it did. Throws IllegalTransitionError for a move the state
   * machine forbids, because that is a bug rather than a race.
   */
  transition(
    jobId: string,
    from: JobStatus,
    to: JobStatus,
    patch?: TransitionPatch,
  ): Promise<boolean>;
  /** Appends up to the log cap; past it, writes one truncation marker. */
  appendLog(jobId: string, text: string): Promise<void>;
  readLogs(jobId: string, afterSeq?: number, limit?: number): Promise<LogPage>;
  /** Oldest first. */
  listByStatus(statuses: readonly JobStatus[]): Promise<Job[]>;
  close(): Promise<void>;
}

export const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024;

export type LogAppendPlan = {
  /** Text to store, or null to store nothing. */
  text: string | null;
  bytes: number;
  truncated: boolean;
};

/**
 * Shared by every repository so the cap behaves identically everywhere. Keeps
 * the head of the log: the start shows what ran, and `error` records how it
 * ended.
 */
export function planLogAppend(
  currentBytes: number,
  alreadyTruncated: boolean,
  text: string,
  maxBytes: number,
): LogAppendPlan {
  if (alreadyTruncated) {
    return { text: null, bytes: currentBytes, truncated: true };
  }
  const size = Buffer.byteLength(text);
  if (currentBytes + size <= maxBytes) {
    return { text, bytes: currentBytes + size, truncated: false };
  }
  const room = Math.max(0, maxBytes - currentBytes);
  const head = Buffer.from(text).subarray(0, room).toString();
  const stored = `${head}\n[log truncated at ${maxBytes} bytes]\n`;
  return { text: stored, bytes: currentBytes + Buffer.byteLength(stored), truncated: true };
}

/**
 * Moves a job to `failed` from whatever non-terminal state it is in. Used by
 * safety nets and recovery, where the current state is not known.
 */
export async function failJob(
  jobs: JobRepository,
  jobId: string,
  error: string,
): Promise<boolean> {
  // Retry once: the status can change between the read and the write.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const job = await jobs.get(jobId);
    if (!job || isTerminal(job.status)) {
      return false;
    }
    if (await jobs.transition(jobId, job.status, "failed", { error })) {
      return true;
    }
  }
  return false;
}

export type JobResponse = {
  jobId: string;
  status: JobStatus;
  repoUrl: string;
  dockerfilePath: string;
  imageTag: string;
  commitSha: string | null;
  logs: string;
  logTruncated: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export function toJobResponse(job: Job, logs: string): JobResponse {
  return {
    jobId: job.jobId,
    status: job.status,
    repoUrl: job.repoUrl,
    dockerfilePath: job.dockerfilePath,
    imageTag: job.imageTag,
    commitSha: job.commitSha,
    logs,
    logTruncated: job.logTruncated,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export async function readAllLogs(jobs: JobRepository, jobId: string): Promise<string> {
  const page = await jobs.readLogs(jobId, 0, Number.MAX_SAFE_INTEGER);
  return page.chunks.map((chunk) => chunk.text).join("");
}

type StoredJob = { job: Job; chunks: LogChunk[] };

/** For tests and throwaway local runs. Returns copies, like a real database. */
export class InMemoryJobRepository implements JobRepository {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly maxLogBytes: number;

  constructor(options: { maxLogBytes?: number } = {}) {
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  }

  async create(input: NewJob): Promise<Job> {
    if (this.jobs.has(input.jobId)) {
      throw new Error(`Job ${input.jobId} already exists`);
    }
    const now = new Date().toISOString();
    const job: Job = {
      ...input,
      status: "queued",
      commitSha: null,
      error: null,
      logBytes: 0,
      logTruncated: false,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.jobId, { job, chunks: [] });
    return { ...job };
  }

  async get(jobId: string): Promise<Job | undefined> {
    const stored = this.jobs.get(jobId);
    return stored ? { ...stored.job } : undefined;
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
    const stored = this.jobs.get(jobId);
    if (!stored || stored.job.status !== from) {
      return false;
    }
    stored.job.status = to;
    stored.job.error = patch.error ?? stored.job.error;
    stored.job.commitSha = patch.commitSha ?? stored.job.commitSha;
    stored.job.updatedAt = new Date().toISOString();
    return true;
  }

  async appendLog(jobId: string, text: string): Promise<void> {
    const stored = this.jobs.get(jobId);
    if (!stored || text === "") {
      return;
    }
    const plan = planLogAppend(
      stored.job.logBytes,
      stored.job.logTruncated,
      text,
      this.maxLogBytes,
    );
    if (plan.text === null) {
      return;
    }
    stored.chunks.push({ seq: stored.chunks.length + 1, text: plan.text });
    stored.job.logBytes = plan.bytes;
    stored.job.logTruncated = plan.truncated;
    stored.job.updatedAt = new Date().toISOString();
  }

  async readLogs(jobId: string, afterSeq = 0, limit = 1000): Promise<LogPage> {
    const chunks = (this.jobs.get(jobId)?.chunks ?? [])
      .filter((chunk) => chunk.seq > afterSeq)
      .slice(0, limit)
      .map((chunk) => ({ ...chunk }));
    return { chunks, nextSeq: chunks.at(-1)?.seq ?? afterSeq };
  }

  async listByStatus(statuses: readonly JobStatus[]): Promise<Job[]> {
    return [...this.jobs.values()]
      .map((stored) => stored.job)
      .filter((job) => statuses.includes(job.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((job) => ({ ...job }));
  }

  async close(): Promise<void> {}
}
