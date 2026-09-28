import { createApp } from "./app.js";
import { createDefaultBuildRunner, runCommand } from "./buildRunner.js";
import { createBuildScheduler } from "./buildWorker.js";
import { loadConfig } from "./config.js";
import { createJsonLogger } from "./logger.js";
import { recoverJobs, sweepWorkDir } from "./recovery.js";
import { SqliteJobRepository } from "./sqliteJobRepository.js";

// The composition root: the only place that builds real dependencies. Order
// matters and each step says why.

const logger = createJsonLogger();

// 1. Config first, so a typo stops the process before it touches anything.
const config = loadConfig();

// 2. Storage, then clear what a previous process left on disk.
const jobs = new SqliteJobRepository(config.databasePath, {
  maxLogBytes: config.maxLogBytes,
});
const swept = await sweepWorkDir(config.workDir);
if (swept.length > 0) {
  logger.info("startup.swept_work_dir", { count: swept.length });
}

const runner = createDefaultBuildRunner(runCommand, {
  cloneTimeoutMs: config.cloneTimeoutMs,
  buildTimeoutMs: config.buildTimeoutMs,
});
const scheduler = createBuildScheduler({
  jobs,
  runner,
  workDir: config.workDir,
  concurrency: config.maxConcurrentBuilds,
  maxQueued: config.maxQueuedBuilds,
  logger,
});

// 3. Recover before listening, so old queued jobs keep their place ahead of
//    new ones.
await recoverJobs(jobs, scheduler, logger);

const app = createApp({
  jobs,
  scheduler,
  allowedGitHosts: config.allowedGitHosts,
  logger,
  readinessChecks: {
    docker: () =>
      runCommand("docker", ["version", "--format", "{{.Server.Version}}"], {
        log: () => {},
        timeoutMs: 2500,
      }),
  },
});

const server = app.listen(config.port, config.host, () => {
  logger.info("startup.listening", {
    url: `http://${config.host}:${config.port}`,
    maxConcurrentBuilds: config.maxConcurrentBuilds,
    maxQueuedBuilds: config.maxQueuedBuilds,
    databasePath: config.databasePath,
  });
});

// 4. Graceful shutdown, in reverse order of startup: stop taking requests,
//    let running builds finish (or abort them after the grace period), then
//    close storage. Queued jobs stay queued and resume on the next start.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("shutdown.started", { signal, graceMs: config.shutdownGraceMs });

  server.close();
  server.closeIdleConnections();
  const { aborted } = await scheduler.shutdown(config.shutdownGraceMs);
  server.closeAllConnections();
  await jobs.close();

  logger.info("shutdown.done", { abortedBuilds: aborted.length });
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
