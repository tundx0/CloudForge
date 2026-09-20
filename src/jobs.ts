export type JobStatus =
  | "accepted"
  | "cloning"
  | "building"
  | "succeeded"
  | "failed";

export type Job = {
  jobId: string;
  status: JobStatus;
  repoUrl: string;
  dockerfilePath: string;
  logs: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobResponse = {
  jobId: string;
  status: JobStatus;
  repoUrl: string;
  dockerfilePath: string;
  logs: string;
  error: string | null;
};

export function toJobResponse(job: Job): JobResponse {
  return {
    jobId: job.jobId,
    status: job.status,
    repoUrl: job.repoUrl,
    dockerfilePath: job.dockerfilePath,
    logs: job.logs,
    error: job.error,
  };
}

export class JobStore {
  private readonly jobs = new Map<string, Job>();

  create(input: { jobId: string; repoUrl: string; dockerfilePath: string }): Job {
    const now = new Date().toISOString();
    const job: Job = {
      jobId: input.jobId,
      status: "accepted",
      repoUrl: input.repoUrl,
      dockerfilePath: input.dockerfilePath,
      logs: "",
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  setStatus(jobId: string, status: JobStatus): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = status;
    job.updatedAt = new Date().toISOString();
  }

  appendLog(jobId: string, chunk: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    job.logs += chunk;
    job.updatedAt = new Date().toISOString();
  }

  fail(jobId: string, error: string): void {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }
    job.status = "failed";
    job.error = error;
    job.updatedAt = new Date().toISOString();
  }
}
