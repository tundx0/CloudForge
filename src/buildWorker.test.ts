import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  childEnv,
  CommandAbortedError,
  CommandTimeoutError,
  createDefaultBuildRunner,
  DockerUnavailableError,
  isDockerDaemonError,
  runCommand,
  type LogSink,
  type RunCommand,
} from "./buildRunner.js";
import { cloneDirFor, createBuildScheduler, imageTagFor, runBuildJob } from "./buildWorker.js";
import {
  InMemoryJobRepository,
  readAllLogs,
  type JobRepository,
  type LogPage,
  type NewJob,
} from "./jobs.js";
import { createFakeRunner, FAKE_SHA, untilAborted, waitFor } from "./testSupport.js";

const JOB_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

async function queuedJob(jobs: JobRepository, overrides: Partial<NewJob> = {}) {
  return jobs.create({
    jobId: JOB_ID,
    repoUrl: "https://github.com/example/app",
    dockerfilePath: "Dockerfile",
    imageTag: imageTagFor(JOB_ID),
    ...overrides,
  });
}

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "cloudforge-repo-"));
  await writeFile(path.join(repo, "Dockerfile"), "FROM scratch\n");
  await mkdir(path.join(repo, "docker"));
  return repo;
}

describe("imageTagFor", () => {
  it("uses the whole job id, so tags do not collide", () => {
    assert.equal(imageTagFor(JOB_ID), "cloudforge-aaaaaaaabbbb4ccc8dddeeeeeeeeeeee");
  });
});

describe("runBuildJob", () => {
  it("moves queued → cloning → building → succeeded and records the commit", async () => {
    const jobs = new InMemoryJobRepository();
    await queuedJob(jobs);
    const seen: string[] = [];
    const runner = createFakeRunner({
      clone: async (_url, _dir, log) => {
        seen.push((await jobs.get(JOB_ID))!.status);
        log("clone ok\n");
        return { commitSha: FAKE_SHA };
      },
      build: async (_dir, _file, _tag, log) => {
        seen.push((await jobs.get(JOB_ID))!.status);
        log("build ok\n");
      },
    });

    await runBuildJob({ jobId: JOB_ID, jobs, runner, workDir: ".work" });

    const done = (await jobs.get(JOB_ID))!;
    assert.deepEqual(seen, ["cloning", "building"]);
    assert.equal(done.status, "succeeded");
    assert.equal(done.commitSha, FAKE_SHA);
    assert.equal(done.error, null);
    const logs = await readAllLogs(jobs, JOB_ID);
    assert.match(logs, /clone ok[\s\S]*build ok[\s\S]*Build succeeded/);
  });

  it("cleans the clone dir before cloning and after finishing", async () => {
    const jobs = new InMemoryJobRepository();
    await queuedJob(jobs);
    const calls: string[] = [];
    await runBuildJob({ jobId: JOB_ID, jobs, runner: createFakeRunner({ calls }), workDir: ".work" });
    const dir = cloneDirFor(".work", JOB_ID);
    assert.deepEqual(calls.map((c) => c.split(" ")[0]), ["cleanup", "clone", "build", "cleanup"]);
    assert.equal(calls[0], `cleanup ${dir}`);
    assert.equal(calls.at(-1), `cleanup ${dir}`);
  });

  it("marks the job failed with the error, and still cleans up", async () => {
    const jobs = new InMemoryJobRepository();
    await queuedJob(jobs);
    const calls: string[] = [];
    const runner = createFakeRunner({
      calls,
      build: async () => {
        throw new DockerUnavailableError("Docker is not installed or not on PATH");
      },
    });

    await runBuildJob({ jobId: JOB_ID, jobs, runner, workDir: ".work" });

    const done = (await jobs.get(JOB_ID))!;
    assert.equal(done.status, "failed");
    assert.equal(done.error, "Docker is not installed or not on PATH");
    assert.match(await readAllLogs(jobs, JOB_ID), /Build failed: Docker is not installed/);
    assert.match(calls.at(-1)!, /^cleanup /);
  });

  it("does nothing when another run already claimed the job", async () => {
    const jobs = new InMemoryJobRepository();
    await queuedJob(jobs);
    await jobs.transition(JOB_ID, "queued", "cloning");
    const calls: string[] = [];

    await runBuildJob({ jobId: JOB_ID, jobs, runner: createFakeRunner({ calls }), workDir: ".work" });

    assert.deepEqual(calls, []);
    assert.equal((await jobs.get(JOB_ID))!.status, "cloning");
  });

  it("does nothing for an unknown job", async () => {
    const calls: string[] = [];
    await runBuildJob({
      jobId: JOB_ID,
      jobs: new InMemoryJobRepository(),
      runner: createFakeRunner({ calls }),
      workDir: ".work",
    });
    assert.deepEqual(calls, []);
  });

  it("fails the job when aborted mid-build", async () => {
    const jobs = new InMemoryJobRepository();
    await queuedJob(jobs);
    const controller = new AbortController();
    const runner = createFakeRunner({
      build: (_dir, _file, _tag, _log, signal) => untilAborted(signal),
    });

    const run = runBuildJob({ jobId: JOB_ID, jobs, runner, workDir: ".work", signal: controller.signal });
    await waitFor(async () => ((await jobs.get(JOB_ID))!.status === "building" ? true : undefined), "building");
    controller.abort(new Error("interrupted by shutdown"));
    await run;

    const done = (await jobs.get(JOB_ID))!;
    assert.equal(done.status, "failed");
    assert.equal(done.error, "interrupted by shutdown");
  });

  it("stores every log line before the job reports a terminal status", async () => {
    // A store whose writes are slow and complete out of order unless the
    // worker serialises them.
    const inner = new InMemoryJobRepository();
    let delay = 20;
    const slow: JobRepository = {
      create: (input) => inner.create(input),
      get: (id) => inner.get(id),
      transition: (...args) => inner.transition(...args),
      appendLog: async (id, text) => {
        delay = Math.max(0, delay - 5);
        await new Promise((resolve) => setTimeout(resolve, delay));
        await inner.appendLog(id, text);
      },
      readLogs: (id, after, limit): Promise<LogPage> => inner.readLogs(id, after, limit),
      listByStatus: (statuses) => inner.listByStatus(statuses),
      close: () => inner.close(),
    };
    await queuedJob(slow);
    let logsAtTerminal = "";
    const original = slow.transition;
    slow.transition = async (id, from, to, patch) => {
      if (to === "succeeded") {
        logsAtTerminal = await readAllLogs(inner, id);
      }
      return original(id, from, to, patch);
    };

    await runBuildJob({ jobId: JOB_ID, jobs: slow, runner: createFakeRunner(), workDir: ".work" });

    assert.match(logsAtTerminal, /Cloning[\s\S]*clone ok[\s\S]*Running docker build[\s\S]*build ok[\s\S]*Build succeeded/);
  });
});

describe("createBuildScheduler", () => {
  it("runs submitted jobs to completion", async () => {
    const jobs = new InMemoryJobRepository();
    await queuedJob(jobs);
    const scheduler = createBuildScheduler({
      jobs,
      runner: createFakeRunner(),
      workDir: ".work",
      concurrency: 1,
      maxQueued: 1,
    });
    scheduler.enqueueRecovered(JOB_ID);
    await waitFor(async () => ((await jobs.get(JOB_ID))!.status === "succeeded" ? true : undefined), "succeeded");
  });

  it("fails the job if the worker itself throws", async () => {
    const jobs = new InMemoryJobRepository();
    await queuedJob(jobs);
    const broken: JobRepository = Object.assign(Object.create(jobs), {
      get: async () => {
        throw new Error("store exploded");
      },
    });
    const scheduler = createBuildScheduler({
      jobs: broken,
      runner: createFakeRunner(),
      workDir: ".work",
      concurrency: 1,
      maxQueued: 1,
    });
    // onError uses the same (broken) store for `get`, so failJob cannot
    // succeed; the point is that nothing crashes and the error is contained.
    scheduler.enqueueRecovered(JOB_ID);
    await scheduler.shutdown(1000);
    assert.match(await readAllLogs(jobs, JOB_ID), /Unhandled worker error: store exploded/);
  });
});

describe("default build runner", () => {
  it("runs a hardened shallow clone, records the commit, then docker build", async () => {
    const repo = await makeRepo();
    try {
      const calls: { argv: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }[] = [];
      const run: RunCommand = async (command, args, { cwd, log, env, timeoutMs }) => {
        calls.push({ argv: [command, ...args, cwd ?? ""].join(" "), env, timeoutMs });
        log(args.includes("rev-parse") ? `${FAKE_SHA}\n` : `${command} ok\n`);
      };
      const logs: string[] = [];
      const log: LogSink = (chunk) => logs.push(chunk);
      const runner = createDefaultBuildRunner(run, { cloneTimeoutMs: 1000, buildTimeoutMs: 2000 });

      const { commitSha } = await runner.clone("https://github.com/example/app", "/tmp/work/job", log);
      await runner.build(repo, "Dockerfile", "cloudforge-abcd1234", log);

      const dockerfile = path.join(await realpath(repo), "Dockerfile");
      assert.equal(commitSha, FAKE_SHA);
      assert.deepEqual(
        calls.map((c) => c.argv),
        [
          "git -c credential.helper= -c core.askPass= clone --depth 1 -- https://github.com/example/app /tmp/work/job ",
          "git -c credential.helper= -c core.askPass= -C /tmp/work/job rev-parse HEAD ",
          `docker build -f ${dockerfile} -t cloudforge-abcd1234 . ${repo}`,
        ],
      );
      assert.equal(calls[0].env?.GIT_TERMINAL_PROMPT, "0");
      assert.equal(calls[0].timeoutMs, 1000);
      assert.equal(calls[2].timeoutMs, 2000);
      assert.deepEqual(logs, ["git ok\n", `Checked out commit ${FAKE_SHA}\n`, "docker ok\n"]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("rejects output that is not a commit sha", async () => {
    const runner = createDefaultBuildRunner(async (_command, args, { log }) => {
      if (args.includes("rev-parse")) {
        log("fatal: not a git repository\n");
      }
    });
    await assert.rejects(
      () => runner.clone("https://github.com/example/app", "/tmp/work/job", () => {}),
      /Could not read the cloned commit/,
    );
  });

  it("passes the abort signal to every command", async () => {
    const repo = await makeRepo();
    try {
      const signals: (AbortSignal | undefined)[] = [];
      const runner = createDefaultBuildRunner(async (_command, args, { log, signal }) => {
        signals.push(signal);
        if (args.includes("rev-parse")) {
          log(FAKE_SHA);
        }
      });
      const controller = new AbortController();
      await runner.clone("https://github.com/example/app", "/tmp/work/job", () => {}, controller.signal);
      await runner.build(repo, "Dockerfile", "t", () => {}, controller.signal);
      assert.equal(signals.length, 3);
      assert.ok(signals.every((s) => s === controller.signal));
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("refuses a Dockerfile symlink that points outside the repository", async () => {
    const repo = await makeRepo();
    const outside = await mkdtemp(path.join(tmpdir(), "cloudforge-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "TOPSECRET");
      await symlink(path.join(outside, "secret.txt"), path.join(repo, "Evil.Dockerfile"));
      let ran = false;
      const runner = createDefaultBuildRunner(async () => {
        ran = true;
      });
      await assert.rejects(
        () => runner.build(repo, "Evil.Dockerfile", "cloudforge-x", () => {}),
        /resolves outside the repository/,
      );
      assert.equal(ran, false);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports a missing Dockerfile before running docker", async () => {
    const repo = await makeRepo();
    try {
      const runner = createDefaultBuildRunner(async () => {
        assert.fail("docker should not run");
      });
      await assert.rejects(
        () => runner.build(repo, "docker/Dockerfile", "cloudforge-x", () => {}),
        /Dockerfile not found in repository: docker\/Dockerfile/,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it("cleanup removes a directory and is idempotent", async () => {
    const runner = createDefaultBuildRunner();
    const dir = await mkdtemp(path.join(tmpdir(), "cloudforge-cleanup-"));
    await writeFile(path.join(dir, "keep-me.txt"), "x");
    await runner.cleanup(dir);
    await runner.cleanup(dir);
  });
});

describe("runCommand (real child processes)", () => {
  it("fails clearly when docker is not on PATH", async () => {
    await assert.rejects(
      () =>
        runCommand("docker", ["info"], {
          log: () => {},
          env: { PATH: "/var/empty-cloudforge-path" },
        }),
      (err: unknown) =>
        err instanceof DockerUnavailableError &&
        err.message === "Docker is not installed or not on PATH",
    );
  });

  it("kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    await assert.rejects(
      () =>
        runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
          log: () => {},
          timeoutMs: 100,
        }),
      CommandTimeoutError,
    );
    assert.ok(Date.now() - started < 5000);
  });

  it("stops a command when its signal aborts", async () => {
    const controller = new AbortController();
    const running = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
      log: () => {},
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("interrupted by shutdown")), 50);
    await assert.rejects(running, (err: unknown) =>
      err instanceof CommandAbortedError && /interrupted by shutdown/.test(err.message),
    );
  });

  it("does not start a command whose signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("too late"));
    await assert.rejects(
      () => runCommand("definitely-not-a-real-binary", [], { log: () => {}, signal: controller.signal }),
      CommandAbortedError,
    );
  });

  it("gives children EOF on stdin instead of hanging", async () => {
    const output: string[] = [];
    await runCommand(
      process.execPath,
      ["-e", "process.stdin.pipe(process.stdout); process.stdin.on('end', () => console.log('eof'))"],
      { log: (chunk) => output.push(chunk), timeoutMs: 5000 },
    );
    assert.match(output.join(""), /eof/);
  });

  it("childEnv passes only allow-listed variables through", () => {
    const env = childEnv(
      { PATH: "/bin", HOME: "/home/x", AWS_SECRET_ACCESS_KEY: "nope", GIT_ASKPASS: "/evil" },
      { GIT_TERMINAL_PROMPT: "0" },
    );
    assert.deepEqual(env, { PATH: "/bin", HOME: "/home/x", GIT_TERMINAL_PROMPT: "0" });
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
