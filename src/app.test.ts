import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import type { BuildRunner } from "./buildRunner.js";
import { JobStore } from "./jobs.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeRunner(
  hooks: {
    clone?: BuildRunner["clone"];
    build?: BuildRunner["build"];
    cleanup?: BuildRunner["cleanup"];
  } = {},
): BuildRunner {
  return {
    clone: hooks.clone ?? (async (_repoUrl, _destDir, log) => {
      log("cloned\n");
    }),
    build: hooks.build ?? (async (_workDir, _dockerfilePath, _imageTag, log) => {
      log("built\n");
    }),
    cleanup: hooks.cleanup ?? (async () => {}),
  };
}

async function waitForJobStatus(
  app: ReturnType<typeof createApp>,
  jobId: string,
  status: string,
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastBody: unknown;
  while (Date.now() < deadline) {
    const res = await request(app).get(`/jobs/${jobId}`);
    lastBody = res.body;
    if (res.status === 200 && res.body.status === status) {
      return res;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Timed out waiting for job ${jobId} status=${status}; last=${JSON.stringify(lastBody)}`,
  );
}

describe("CloudForge API", () => {
  const runner = createFakeRunner();
  const app = createApp({ runner });

  it("GET /health returns 200 { status: ok }", async () => {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("POST /deploy accepts a repo URL and optional Dockerfile path", async () => {
    const res = await request(app).post("/deploy").send({
      repoUrl: "https://github.com/example/app",
      dockerfilePath: "Dockerfile",
    });

    assert.equal(res.status, 202);
    assert.equal(res.body.status, "accepted");
    assert.equal(typeof res.body.jobId, "string");
    assert.ok(res.body.jobId.length > 0);
    assert.equal(res.body.repoUrl, "https://github.com/example/app");
    assert.equal(res.body.dockerfilePath, "Dockerfile");
  });

  it("POST /deploy defaults dockerfilePath to Dockerfile", async () => {
    const res = await request(app).post("/deploy").send({
      repoUrl: "https://github.com/example/app",
    });

    assert.equal(res.status, 202);
    assert.equal(res.body.dockerfilePath, "Dockerfile");
  });

  it("POST /deploy rejects a missing repoUrl", async () => {
    const res = await request(app).post("/deploy").send({});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_request");
  });

  it("POST /deploy rejects a non-http repoUrl", async () => {
    const res = await request(app).post("/deploy").send({
      repoUrl: "not-a-url",
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "invalid_request");
  });

  it("POST /deploy returns 202 without waiting for the build", async () => {
    const gate = deferred();
    const hanging = createApp({
      runner: createFakeRunner({
        clone: () => gate.promise,
      }),
    });

    const started = Date.now();
    const res = await request(hanging).post("/deploy").send({
      repoUrl: "https://github.com/example/app",
    });
    const elapsed = Date.now() - started;

    assert.equal(res.status, 202);
    assert.equal(res.body.status, "accepted");
    assert.ok(elapsed < 200, `POST /deploy blocked for ${elapsed}ms`);

    gate.resolve();
    await waitForJobStatus(hanging, res.body.jobId, "succeeded");
  });

  it("GET /jobs/:jobId returns 404 for an unknown id", async () => {
    const res = await request(app).get(
      "/jobs/00000000-0000-0000-0000-000000000000",
    );
    assert.equal(res.status, 404);
    assert.equal(res.body.error, "not_found");
  });

  it("GET /jobs/:jobId returns status and logs after POST /deploy", async () => {
    const jobs = new JobStore();
    const localApp = createApp({ jobs, runner });
    const created = await request(localApp).post("/deploy").send({
      repoUrl: "https://github.com/example/app",
      dockerfilePath: "docker/Dockerfile",
    });

    assert.equal(created.status, 202);
    const jobId = created.body.jobId as string;

    const accepted = await request(localApp).get(`/jobs/${jobId}`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.jobId, jobId);
    assert.equal(accepted.body.repoUrl, "https://github.com/example/app");
    assert.equal(accepted.body.dockerfilePath, "docker/Dockerfile");
    assert.equal(typeof accepted.body.logs, "string");
    assert.ok(
      ["accepted", "cloning", "building", "succeeded"].includes(
        accepted.body.status,
      ),
    );

    const done = await waitForJobStatus(localApp, jobId, "succeeded");
    assert.match(done.body.logs, /cloned/);
    assert.match(done.body.logs, /built/);
    assert.equal(done.body.error, null);
  });

  it("GET /jobs/:jobId reports failure from the worker", async () => {
    const failing = createApp({
      runner: createFakeRunner({
        build: async () => {
          throw new Error("docker build exploded");
        },
      }),
    });

    const created = await request(failing).post("/deploy").send({
      repoUrl: "https://github.com/example/app",
    });
    const done = await waitForJobStatus(failing, created.body.jobId, "failed");
    assert.equal(done.body.status, "failed");
    assert.equal(done.body.error, "docker build exploded");
    assert.match(done.body.logs, /Build failed: docker build exploded/);
  });
});
