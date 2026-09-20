import { randomUUID } from "node:crypto";
import express, { type Express } from "express";
import {
  createDefaultBuildRunner,
  type BuildRunner,
} from "./buildRunner.js";
import { runBuildJob } from "./buildWorker.js";
import { JobStore, toJobResponse } from "./jobs.js";

export type DeployRequestBody = {
  repoUrl?: unknown;
  dockerfilePath?: unknown;
};

export type DeployAcceptedResponse = {
  jobId: string;
  status: "accepted";
  repoUrl: string;
  dockerfilePath: string;
  message: string;
};

export type ErrorResponse = {
  error: "invalid_request" | "not_found";
  message: string;
};

export type CreateAppOptions = {
  jobs?: JobStore;
  runner?: BuildRunner;
  workDir?: string;
};

export function createApp(options: CreateAppOptions = {}): Express {
  const jobs = options.jobs ?? new JobStore();
  const runner = options.runner ?? createDefaultBuildRunner();
  const workDir = options.workDir ?? process.env.WORK_DIR ?? ".work";

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/deploy", (req, res) => {
    const { repoUrl, dockerfilePath } = (req.body ?? {}) as DeployRequestBody;

    if (typeof repoUrl !== "string" || repoUrl.trim() === "") {
      const body: ErrorResponse = {
        error: "invalid_request",
        message: "repoUrl is required and must be a non-empty string",
      };
      res.status(400).json(body);
      return;
    }

    if (!isHttpUrl(repoUrl)) {
      const body: ErrorResponse = {
        error: "invalid_request",
        message: "repoUrl must be an http(s) git URL",
      };
      res.status(400).json(body);
      return;
    }

    if (dockerfilePath !== undefined && typeof dockerfilePath !== "string") {
      const body: ErrorResponse = {
        error: "invalid_request",
        message: "dockerfilePath must be a string when provided",
      };
      res.status(400).json(body);
      return;
    }

    const path = dockerfilePath?.trim() || "Dockerfile";
    const job = jobs.create({
      jobId: randomUUID(),
      repoUrl: repoUrl.trim(),
      dockerfilePath: path,
    });

    const body: DeployAcceptedResponse = {
      jobId: job.jobId,
      status: "accepted",
      repoUrl: job.repoUrl,
      dockerfilePath: job.dockerfilePath,
      message:
        "Deploy job accepted. Image build started; cloud deploy is not implemented yet.",
    };
    res.status(202).json(body);

    void runBuildJob({ job, jobs, runner, workDir }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      jobs.appendLog(job.jobId, `Unhandled worker error: ${message}\n`);
      jobs.fail(job.jobId, message);
    });
  });

  app.get("/jobs/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId as string);
    if (!job) {
      const body: ErrorResponse = {
        error: "not_found",
        message: "Unknown jobId",
      };
      res.status(404).json(body);
      return;
    }
    res.status(200).json(toJobResponse(job));
  });

  return app;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
