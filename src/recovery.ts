import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { JobRepository } from "./jobs.js";
import { silentLogger, type Logger } from "./logger.js";
import type { BuildScheduler } from "./scheduler.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INTERRUPTED_ERROR = "Interrupted: the server stopped during this build";

/**
 * Removes clone directories left by a previous process. Only deletes
 * UUID-named directories, so pointing WORK_DIR at the wrong place (a home
 * directory, "/") cannot delete anything that CloudForge did not create.
 */
export async function sweepWorkDir(workDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(workDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && UUID.test(entry.name)) {
      await rm(path.join(workDir, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
  }
  return removed;
}

export type RecoveryResult = { failed: string[]; requeued: string[] };

/**
 * Must run before the scheduler starts new work.
 *
 * - `cloning` / `building`: the process died mid-build. Its state is unknown
 *   and its clone is gone, so the job fails with a clear message. Retrying
 *   automatically would be a product decision, not a recovery one.
 * - `queued`: accepted but never started. Nothing happened yet, so it is safe
 *   to run, and dropping it would break the promise made by the 202.
 */
export async function recoverJobs(
  jobs: JobRepository,
  scheduler: BuildScheduler,
  logger: Logger = silentLogger,
): Promise<RecoveryResult> {
  const result: RecoveryResult = { failed: [], requeued: [] };

  for (const job of await jobs.listByStatus(["cloning", "building"])) {
    await jobs.appendLog(job.jobId, `\n${INTERRUPTED_ERROR}\n`);
    if (await jobs.transition(job.jobId, job.status, "failed", { error: INTERRUPTED_ERROR })) {
      result.failed.push(job.jobId);
    }
  }

  for (const job of await jobs.listByStatus(["queued"])) {
    scheduler.enqueueRecovered(job.jobId);
    result.requeued.push(job.jobId);
  }

  logger.info("recovery.done", {
    failed: result.failed.length,
    requeued: result.requeued.length,
  });
  return result;
}
