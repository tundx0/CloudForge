import path from "node:path";
import {
  DockerUnavailableError,
  type BuildRunner,
} from "./buildRunner.js";
import type { Job, JobStore } from "./jobs.js";

export function imageTagFor(jobId: string): string {
  return `cloudforge-${jobId.replace(/-/g, "").slice(0, 8)}`;
}

export function cloneDirFor(workDir: string, jobId: string): string {
  return path.join(path.resolve(workDir), jobId);
}

export async function runBuildJob(input: {
  job: Job;
  jobs: JobStore;
  runner: BuildRunner;
  workDir: string;
}): Promise<void> {
  const { job, jobs, runner, workDir } = input;
  const destDir = cloneDirFor(workDir, job.jobId);
  const imageTag = imageTagFor(job.jobId);
  const log = (chunk: string) => jobs.appendLog(job.jobId, chunk);

  try {
    jobs.setStatus(job.jobId, "cloning");
    log(`Cloning ${job.repoUrl} (shallow) into ${destDir}\n`);
    await runner.clone(job.repoUrl, destDir, log);

    jobs.setStatus(job.jobId, "building");
    log(`Running docker build -f ${job.dockerfilePath} -t ${imageTag} .\n`);
    await runner.build(destDir, job.dockerfilePath, imageTag, log);

    jobs.setStatus(job.jobId, "succeeded");
    log(`Build succeeded (${imageTag}). Cloud deploy is not implemented yet.\n`);
  } catch (err) {
    const message = errorMessage(err);
    log(`Build failed: ${message}\n`);
    jobs.fail(job.jobId, message);
  } finally {
    try {
      await runner.cleanup(destDir);
    } catch (err) {
      log(`Cleanup warning: ${errorMessage(err)}\n`);
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof DockerUnavailableError) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
