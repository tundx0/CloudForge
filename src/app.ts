import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type Express,
  type RequestHandler,
} from "express";
import {
  createDefaultBuildRunner,
  type BuildRunner,
} from "./buildRunner.js";
import { createBuildScheduler, imageTagFor } from "./buildWorker.js";
import {
  InMemoryJobRepository,
  isTerminal,
  readAllLogs,
  toJobResponse,
  type JobRepository,
  type JobStatus,
  type LogChunk,
} from "./jobs.js";
import { silentLogger, type Logger } from "./logger.js";
import type { BuildScheduler } from "./scheduler.js";
import { DEFAULT_ALLOWED_GIT_HOSTS, parseDeployRequest } from "./validation.js";

export type DeployAcceptedResponse = {
  jobId: string;
  status: "queued";
  repoUrl: string;
  dockerfilePath: string;
  imageTag: string;
  message: string;
};

export type LogsResponse = {
  jobId: string;
  status: JobStatus;
  chunks: LogChunk[];
  nextSeq: number;
  /** True once the job is finished and every log chunk has been returned. */
  done: boolean;
};

export type ErrorResponse = {
  error: "invalid_request" | "not_found" | "unavailable" | "internal";
  message: string;
};

/** A readiness check resolves when healthy and rejects with a reason when not. */
export type ReadinessCheck = () => Promise<void>;

export type CreateAppOptions = {
  jobs?: JobRepository;
  /** Defaults to a scheduler over `jobs` and `runner` with concurrency 2. */
  scheduler?: BuildScheduler;
  runner?: BuildRunner;
  workDir?: string;
  /** `null` allows any host. Defaults to DEFAULT_ALLOWED_GIT_HOSTS. */
  allowedGitHosts?: readonly string[] | null;
  logger?: Logger;
  /** Extra checks for GET /ready, e.g. Docker reachability. */
  readinessChecks?: Record<string, ReadinessCheck>;
};

const RETRY_AFTER_SECONDS = 30;
const MAX_LOG_PAGE = 1000;
const READINESS_TIMEOUT_MS = 3000;
const PROBE_JOB_ID = "00000000-0000-0000-0000-000000000000";

export function createApp(options: CreateAppOptions = {}): Express {
  const jobs = options.jobs ?? new InMemoryJobRepository();
  const logger = options.logger ?? silentLogger;
  const scheduler =
    options.scheduler ??
    createBuildScheduler({
      jobs,
      runner: options.runner ?? createDefaultBuildRunner(),
      workDir: options.workDir ?? process.env.WORK_DIR ?? ".work",
      concurrency: 2,
      maxQueued: 50,
      logger,
    });
  const allowedGitHosts =
    options.allowedGitHosts === undefined
      ? DEFAULT_ALLOWED_GIT_HOSTS
      : options.allowedGitHosts;
  const readinessChecks: Record<string, ReadinessCheck> = {
    store: async () => {
      await jobs.get(PROBE_JOB_ID);
    },
    scheduler: async () => {
      if (!scheduler.stats().accepting) {
        throw new Error("shutting down");
      }
    },
    ...options.readinessChecks,
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(requestLogger(logger));
  app.use(express.json({ limit: "16kb" }));

  // Liveness: the process is up and serving HTTP. Deliberately checks nothing
  // else, so a broken dependency never gets a healthy process restarted.
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Readiness: this instance can do useful work right now.
  app.get("/ready", async (_req, res) => {
    const results = await Promise.all(
      Object.entries(readinessChecks).map(async ([name, check]) => {
        try {
          await withTimeout(check(), READINESS_TIMEOUT_MS);
          return [name, { ok: true }] as const;
        } catch (err) {
          return [name, { ok: false, error: err instanceof Error ? err.message : String(err) }] as const;
        }
      }),
    );
    const ready = results.every(([, result]) => result.ok);
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      checks: Object.fromEntries(results),
      queue: scheduler.stats(),
    });
  });

  app.post("/deploy", async (req, res) => {
    const parsed = parseDeployRequest(req.body, allowedGitHosts);
    if (!parsed.ok) {
      sendError(res, 400, "invalid_request", parsed.message);
      return;
    }

    // Reserve before any await: otherwise many concurrent requests could all
    // see "room in the queue" and overfill it.
    const reservation = scheduler.reserve();
    if (!reservation) {
      res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
      sendError(res, 503, "unavailable", "Build queue is full or the server is shutting down; retry later");
      return;
    }

    const jobId = randomUUID();
    let job;
    try {
      job = await jobs.create({
        jobId,
        repoUrl: parsed.value.repoUrl,
        dockerfilePath: parsed.value.dockerfilePath,
        imageTag: imageTagFor(jobId),
      });
    } catch (err) {
      reservation.release();
      throw err;
    }
    reservation.enqueue(job.jobId);
    logger.info("job.created", { jobId, repoUrl: job.repoUrl });

    const body: DeployAcceptedResponse = {
      jobId: job.jobId,
      status: "queued",
      repoUrl: job.repoUrl,
      dockerfilePath: job.dockerfilePath,
      imageTag: job.imageTag,
      message:
        "Deploy job accepted. Image build queued; cloud deploy is not implemented yet.",
    };
    res.status(202).location(`/jobs/${job.jobId}`).json(body);
  });

  app.get("/jobs/:jobId", async (req, res) => {
    const job = await jobs.get(req.params.jobId);
    if (!job) {
      sendError(res, 404, "not_found", "Unknown jobId");
      return;
    }
    res.status(200).json(toJobResponse(job, await readAllLogs(jobs, job.jobId)));
  });

  app.get("/jobs/:jobId/logs", async (req, res) => {
    const afterSeq = readQueryInt(req.query.after, 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = readQueryInt(req.query.limit, MAX_LOG_PAGE, 1, MAX_LOG_PAGE);
    if (afterSeq === undefined || limit === undefined) {
      sendError(res, 400, "invalid_request", `after must be a non-negative integer and limit an integer from 1 to ${MAX_LOG_PAGE}`);
      return;
    }
    // Read the status BEFORE the logs. The worker stores every log line before
    // it sets a terminal status, so "terminal, then no more chunks" really
    // means done. Reading in the other order could report done too early.
    const job = await jobs.get(req.params.jobId);
    if (!job) {
      sendError(res, 404, "not_found", "Unknown jobId");
      return;
    }
    const page = await jobs.readLogs(job.jobId, afterSeq, limit);
    const body: LogsResponse = {
      jobId: job.jobId,
      status: job.status,
      chunks: page.chunks,
      nextSeq: page.nextSeq,
      done: isTerminal(job.status) && page.chunks.length < limit,
    };
    res.status(200).json(body);
  });

  app.use((_req, res) => {
    sendError(res, 404, "not_found", "No such route");
  });

  app.use(errorHandler(logger));

  return app;
}

function sendError(
  res: express.Response,
  status: number,
  error: ErrorResponse["error"],
  message: string,
): void {
  const body: ErrorResponse = { error, message };
  res.status(status).json(body);
}

function readQueryInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return parsed >= min && parsed <= max ? parsed : undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Logs one line per request. Uses `req.path`, not the full URL, and never
 * logs bodies: both can carry data that does not belong in logs.
 */
function requestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      logger.info("http.request", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
    next();
  };
}

// Express recognises error middleware by its four parameters, so `_next`
// must stay even though it is unused. Responses never include stack traces.
function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err?.type === "entity.parse.failed") {
      sendError(res, 400, "invalid_request", "Request body must be valid JSON");
      return;
    }
    if (typeof err?.status === "number" && err.status >= 400 && err.status < 500) {
      sendError(
        res,
        err.status,
        "invalid_request",
        err.expose === true ? String(err.message) : "Invalid request",
      );
      return;
    }
    logger.error("http.unhandled_error", {
      method: req.method,
      path: req.path,
      error: err instanceof Error ? err.stack : String(err),
    });
    sendError(res, 500, "internal", "Internal server error");
  };
}
