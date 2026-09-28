import path from "node:path";
import type { BuildRunner } from "./buildRunner.js";
import { failJob, type JobRepository, type JobStatus } from "./jobs.js";
import { silentLogger, type Logger } from "./logger.js";
import { BuildScheduler } from "./scheduler.js";

/**
 * The full job id, not a prefix: a 32-bit prefix collides with 50% odds
 * after about 77,000 jobs.
 */
export function imageTagFor(jobId: string): string {
  return `cloudforge-${jobId.replace(/-/g, "").toLowerCase()}`;
}

export function cloneDirFor(workDir: string, jobId: string): string {
  return path.join(path.resolve(workDir), jobId);
}

export type BuildJobInput = {
  jobId: string;
  jobs: JobRepository;
  runner: BuildRunner;
  workDir: string;
  signal?: AbortSignal;
  logger?: Logger;
};

/**
 * Runs one queued job to a terminal state. Safe to call more than once for
 * the same job: only the caller that moves it out of `queued` does any work.
 */
export async function runBuildJob({
  jobId,
  jobs,
  runner,
  workDir,
  signal,
  logger = silentLogger,
}: BuildJobInput): Promise<void> {
  const job = await jobs.get(jobId);
  if (!job) {
    logger.warn("job.missing", { jobId });
    return;
  }

  const destDir = cloneDirFor(workDir, jobId);
  // Child output arrives through a synchronous callback, so writes are
  // chained: they stay in order even if the store is slow, and flushLogs()
  // lets a terminal status wait until every line before it is stored.
  let logWrites = Promise.resolve();
  const log = (chunk: string) => {
    logWrites = logWrites
      .then(() => jobs.appendLog(jobId, chunk))
      .catch((err: unknown) => {
        // A lost log line must not fail the build, but operators must see it.
        logger.error("job.log_write_failed", { jobId, error: String(err) });
      });
  };
  const flushLogs = () => logWrites;

  let status: JobStatus = "queued";
  const moveTo = async (next: JobStatus, patch?: { commitSha?: string }) => {
    if (!(await jobs.transition(jobId, status, next, patch))) {
      throw new StaleJobError(jobId, status);
    }
    logger.info("job.transition", { jobId, from: status, to: next });
    status = next;
  };

  try {
    await moveTo("cloning");
  } catch (err) {
    if (err instanceof StaleJobError) {
      // Another run already claimed this job. Doing nothing is correct.
      logger.info("job.already_claimed", { jobId });
      return;
    }
    throw err;
  }

  try {
    // A previous, interrupted attempt may have left files behind.
    await runner.cleanup(destDir);

    log(`Cloning ${job.repoUrl} (shallow) into ${destDir}\n`);
    const { commitSha } = await runner.clone(job.repoUrl, destDir, log, signal);

    await moveTo("building", { commitSha });
    log(`Running docker build -f ${job.dockerfilePath} -t ${job.imageTag} .\n`);
    await runner.build(destDir, job.dockerfilePath, job.imageTag, log, signal);

    log(`Build succeeded (${job.imageTag} @ ${commitSha}). Cloud deploy is not implemented yet.\n`);
    await flushLogs();
    await moveTo("succeeded");
  } catch (err) {
    const message = errorMessage(err);
    log(`Build failed: ${message}\n`);
    await flushLogs();
    if (!(await jobs.transition(jobId, status, "failed", { error: message }))) {
      // Someone else finished the job; their outcome stands.
      logger.warn("job.fail_skipped", { jobId, status, error: message });
    } else {
      logger.info("job.transition", { jobId, from: status, to: "failed", error: message });
    }
  } finally {
    try {
      await runner.cleanup(destDir);
    } catch (err) {
      log(`Cleanup warning: ${errorMessage(err)}\n`);
    }
    await flushLogs();
  }
}

class StaleJobError extends Error {
  constructor(jobId: string, expected: JobStatus) {
    super(`Job ${jobId} is no longer ${expected}`);
    this.name = "StaleJobError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type BuildSchedulerInput = {
  jobs: JobRepository;
  runner: BuildRunner;
  workDir: string;
  concurrency: number;
  maxQueued: number;
  logger?: Logger;
};

/** Wires the generic scheduler to the build procedure. */
export function createBuildScheduler({
  jobs,
  runner,
  workDir,
  concurrency,
  maxQueued,
  logger = silentLogger,
}: BuildSchedulerInput): BuildScheduler {
  return new BuildScheduler({
    concurrency,
    maxQueued,
    execute: (jobId, signal) => runBuildJob({ jobId, jobs, runner, workDir, signal, logger }),
    onError: async (jobId, err) => {
      const message = errorMessage(err);
      logger.error("job.unhandled_error", { jobId, error: message });
      await jobs.appendLog(jobId, `Unhandled worker error: ${message}\n`).catch(() => {});
      await failJob(jobs, jobId, message);
    },
  });
}
