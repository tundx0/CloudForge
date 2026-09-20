import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createDefaultBuildRunner,
  DockerUnavailableError,
  isDockerDaemonError,
  runCommand,
  type BuildRunner,
  type LogSink,
  type RunCommand,
} from "./buildRunner.js";
import { cloneDirFor, imageTagFor, runBuildJob } from "./buildWorker.js";
import { JobStore } from "./jobs.js";

function createFakeRunner(
  hooks: Partial<BuildRunner> & { calls?: string[] } = {},
): BuildRunner {
  const calls = hooks.calls ?? [];
  return {
    clone: async (repoUrl, destDir, log) => {
      calls.push(`clone ${repoUrl} ${destDir}`);
      if (hooks.clone) {
        await hooks.clone(repoUrl, destDir, log);
        return;
      }
      log("clone ok\n");
    },
    build: async (workDir, dockerfilePath, imageTag, log) => {
      calls.push(`build ${workDir} ${dockerfilePath} ${imageTag}`);
      if (hooks.build) {
        await hooks.build(workDir, dockerfilePath, imageTag, log);
        return;
      }
      log("build ok\n");
    },
    cleanup: async (dir) => {
      calls.push(`cleanup ${dir}`);
      if (hooks.cleanup) {
        await hooks.cleanup(dir);
      }
    },
  };
}

describe("build worker", () => {
  it("moves accepted → cloning → building → succeeded and tags the image", async () => {
    const jobs = new JobStore();
    const job = jobs.create({
      jobId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      repoUrl: "https://github.com/example/app",
      dockerfilePath: "Dockerfile",
    });
    const seen: string[] = [];
    const runner = createFakeRunner({
      clone: async (_repoUrl, _destDir, log) => {
        seen.push(jobs.get(job.jobId)!.status);
        log("clone ok\n");
      },
      build: async (_workDir, _dockerfilePath, _imageTag, log) => {
        seen.push(jobs.get(job.jobId)!.status);
        log("build ok\n");
      },
    });

    await runBuildJob({ job, jobs, runner, workDir: "/tmp/cloudforge-work" });

    const done = jobs.get(job.jobId)!;
    assert.deepEqual(seen, ["cloning", "building"]);
    assert.equal(done.status, "succeeded");
    assert.equal(done.error, null);
    assert.match(done.logs, /clone ok/);
    assert.match(done.logs, /build ok/);
    assert.match(done.logs, /cloudforge-aaaaaaaa/);
    assert.equal(imageTagFor(job.jobId), "cloudforge-aaaaaaaa");
  });

  it("marks the job failed and still cleans up the clone dir", async () => {
    const jobs = new JobStore();
    const job = jobs.create({
      jobId: "11111111-2222-3333-4444-555555555555",
      repoUrl: "https://github.com/example/app",
      dockerfilePath: "Dockerfile",
    });
    const calls: string[] = [];
    const runner = createFakeRunner({
      calls,
      build: async () => {
        throw new Error("boom");
      },
    });

    await runBuildJob({ job, jobs, runner, workDir: ".work" });

    const done = jobs.get(job.jobId)!;
    assert.equal(done.status, "failed");
    assert.equal(done.error, "boom");
    assert.match(done.logs, /Build failed: boom/);
    assert.equal(calls.at(-1), `cleanup ${cloneDirFor(".work", job.jobId)}`);
  });

  it("fails clearly when Docker is missing or the daemon is down", async () => {
    const jobs = new JobStore();
    const job = jobs.create({
      jobId: "99999999-aaaa-bbbb-cccc-dddddddddddd",
      repoUrl: "https://github.com/example/app",
      dockerfilePath: "Dockerfile",
    });
    const runner = createFakeRunner({
      build: async () => {
        throw new DockerUnavailableError(
          "Docker is not installed or not on PATH",
        );
      },
    });

    await runBuildJob({ job, jobs, runner, workDir: ".work" });

    const done = jobs.get(job.jobId)!;
    assert.equal(done.status, "failed");
    assert.equal(done.error, "Docker is not installed or not on PATH");
    assert.notEqual(done.status, "accepted");
  });

  it("does not throw when cleanup is repeated", async () => {
    const jobs = new JobStore();
    const job = jobs.create({
      jobId: "cleanup-id",
      repoUrl: "https://github.com/example/app",
      dockerfilePath: "Dockerfile",
    });
    let cleanups = 0;
    const runner = createFakeRunner({
      cleanup: async () => {
        cleanups += 1;
      },
    });

    await runBuildJob({ job, jobs, runner, workDir: ".work" });
    await runner.cleanup(cloneDirFor(".work", job.jobId));
    assert.equal(cleanups, 2);
  });
});

describe("default build runner", () => {
  it("runs a shallow git clone then docker build with the job tag", async () => {
    const commands: string[] = [];
    const run: RunCommand = async (command, args, { cwd, log }) => {
      commands.push([command, ...args, cwd ?? ""].join(" "));
      log(`${command} ok\n`);
    };
    const logs: string[] = [];
    const log: LogSink = (chunk) => logs.push(chunk);
    const runner = createDefaultBuildRunner(run);

    await runner.clone("https://github.com/example/app", "/tmp/work/job", log);
    await runner.build("/tmp/work/job", "Dockerfile", "cloudforge-abcd1234", log);

    assert.deepEqual(commands, [
      "git clone --depth 1 https://github.com/example/app /tmp/work/job ",
      "docker build -f Dockerfile -t cloudforge-abcd1234 . /tmp/work/job",
    ]);
    assert.deepEqual(logs, ["git ok\n", "docker ok\n"]);
  });

  it("maps a missing docker binary to DockerUnavailableError", async () => {
    const run: RunCommand = async (command) => {
      if (command === "docker") {
        throw new DockerUnavailableError(
          "Docker is not installed or not on PATH",
        );
      }
    };
    const runner = createDefaultBuildRunner(run);
    await assert.rejects(
      () => runner.build("/tmp/work/job", "Dockerfile", "cloudforge-x", () => {}),
      DockerUnavailableError,
    );
  });

  it("runCommand fails clearly when docker is not on PATH", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/var/empty-cloudforge-path";
    try {
      await assert.rejects(
        () => runCommand("docker", ["info"], { log: () => {} }),
        (err: unknown) =>
          err instanceof DockerUnavailableError &&
          err.message === "Docker is not installed or not on PATH",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("cleanup removes a temp clone and is idempotent", async () => {
    const runner = createDefaultBuildRunner();
    const dir = await mkdtemp(path.join(tmpdir(), "cloudforge-cleanup-"));
    await writeFile(path.join(dir, "keep-me.txt"), "x");
    await runner.cleanup(dir);
    await runner.cleanup(dir);
  });

  it("detects docker daemon connection errors from command output", () => {
    assert.equal(
      isDockerDaemonError(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
      true,
    );
    assert.equal(isDockerDaemonError("Step 1/2 : FROM node:22-alpine"), false);
  });
});
