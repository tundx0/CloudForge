import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "./app.js";
import { createBuildScheduler } from "./buildWorker.js";
import { InMemoryJobRepository } from "./jobs.js";
import { createFakeRunner, deferred, FAKE_SHA, waitFor } from "./testSupport.js";

type App = ReturnType<typeof createApp>;

async function waitForJobStatus(app: App, jobId: string, status: string) {
  return waitFor(async () => {
    const res = await request(app).get(`/jobs/${jobId}`);
    return res.status === 200 && res.body.status === status ? res : undefined;
  }, `job ${jobId} to be ${status}`);
}

const REPO = "https://github.com/example/app";

describe("CloudForge API", () => {
  const app = createApp({ runner: createFakeRunner() });

  describe("GET /health and /ready", () => {
    it("GET /health returns 200 { status: ok }", async () => {
      const res = await request(app).get("/health");
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { status: "ok" });
    });

    it("GET /ready reports each check and the queue", async () => {
      const res = await request(app).get("/ready");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ready");
      assert.deepEqual(res.body.checks, { store: { ok: true }, scheduler: { ok: true } });
      assert.equal(res.body.queue.concurrency, 2);
    });

    it("GET /ready returns 503 when any check fails", async () => {
      const unready = createApp({
        runner: createFakeRunner(),
        readinessChecks: {
          docker: async () => {
            throw new Error("daemon unreachable");
          },
        },
      });
      const res = await request(unready).get("/ready");
      assert.equal(res.status, 503);
      assert.equal(res.body.status, "not_ready");
      assert.deepEqual(res.body.checks.docker, { ok: false, error: "daemon unreachable" });
    });
  });

  describe("POST /deploy", () => {
    it("queues a job and points at it with Location", async () => {
      const res = await request(app).post("/deploy").send({ repoUrl: REPO, dockerfilePath: "Dockerfile" });

      assert.equal(res.status, 202);
      assert.equal(res.body.status, "queued");
      assert.match(res.body.jobId, /^[0-9a-f-]{36}$/);
      assert.equal(res.headers.location, `/jobs/${res.body.jobId}`);
      assert.equal(res.body.imageTag, `cloudforge-${res.body.jobId.replace(/-/g, "")}`);
      assert.equal(res.body.repoUrl, REPO);
      assert.equal(res.body.dockerfilePath, "Dockerfile");
    });

    it("defaults dockerfilePath to Dockerfile", async () => {
      const res = await request(app).post("/deploy").send({ repoUrl: REPO });
      assert.equal(res.status, 202);
      assert.equal(res.body.dockerfilePath, "Dockerfile");
    });

    const invalid: [string, unknown, RegExp][] = [
      ["a missing repoUrl", {}, /repoUrl is required/],
      ["a non-http repoUrl", { repoUrl: "not-a-url" }, /http\(s\)/],
      ["credentials in repoUrl", { repoUrl: "https://user:ghp_SECRET@github.com/x/y" }, /credentials/],
      ["a host outside the allow-list", { repoUrl: "http://169.254.169.254/latest" }, /host must be one of/],
      ["dockerfilePath '-'", { repoUrl: REPO, dockerfilePath: "-" }, /must not start with/],
      ["dockerfilePath '../outside.txt'", { repoUrl: REPO, dockerfilePath: "../outside.txt" }, /inside the repository/],
      ["dockerfilePath '/etc/passwd'", { repoUrl: REPO, dockerfilePath: "/etc/passwd" }, /relative/],
    ];
    for (const [name, body, message] of invalid) {
      it(`rejects ${name} with 400`, async () => {
        const res = await request(app).post("/deploy").send(body as object);
        assert.equal(res.status, 400);
        assert.equal(res.body.error, "invalid_request");
        assert.match(res.body.message, message);
      });
    }

    it("accepts any host when the allow-list is disabled", async () => {
      const open = createApp({ runner: createFakeRunner(), allowedGitHosts: null });
      const res = await request(open).post("/deploy").send({ repoUrl: "http://git.internal/app" });
      assert.equal(res.status, 202);
    });

    it("returns 202 without waiting for the build", async () => {
      const gate = deferred<{ commitSha: string }>();
      const hanging = createApp({ runner: createFakeRunner({ clone: () => gate.promise }) });

      const res = await request(hanging).post("/deploy").send({ repoUrl: REPO });
      assert.equal(res.status, 202);
      // The request completed while clone was still blocked: that is the proof.
      assert.equal((await request(hanging).get(`/jobs/${res.body.jobId}`)).body.status, "cloning");

      gate.resolve({ commitSha: FAKE_SHA });
      await waitForJobStatus(hanging, res.body.jobId, "succeeded");
    });

    it("returns 503 with Retry-After when the queue is full, and recovers when it drains", async () => {
      const gate = deferred<{ commitSha: string }>();
      const jobs = new InMemoryJobRepository();
      const runner = createFakeRunner({ clone: () => gate.promise });
      const scheduler = createBuildScheduler({ jobs, runner, workDir: ".work", concurrency: 1, maxQueued: 1 });
      const small = createApp({ jobs, scheduler });

      const running = await request(small).post("/deploy").send({ repoUrl: REPO });
      const queued = await request(small).post("/deploy").send({ repoUrl: REPO });
      const rejected = await request(small).post("/deploy").send({ repoUrl: REPO });

      assert.equal(running.status, 202);
      assert.equal(queued.status, 202);
      assert.equal(rejected.status, 503);
      assert.equal(rejected.headers["retry-after"], "30");
      assert.equal(rejected.body.error, "unavailable");

      gate.resolve({ commitSha: FAKE_SHA });
      await waitForJobStatus(small, queued.body.jobId, "succeeded");
      assert.equal((await request(small).post("/deploy").send({ repoUrl: REPO })).status, 202);
    });

    it("returns a JSON error for malformed JSON", async () => {
      const res = await request(app).post("/deploy").set("Content-Type", "application/json").send("{oops");
      assert.equal(res.status, 400);
      assert.match(res.type, /json/);
      assert.deepEqual(res.body, { error: "invalid_request", message: "Request body must be valid JSON" });
    });

    it("returns a JSON 413 for an oversized body", async () => {
      const res = await request(app).post("/deploy").send({ repoUrl: REPO, padding: "x".repeat(20_000) });
      assert.equal(res.status, 413);
      assert.equal(res.body.error, "invalid_request");
    });
  });

  describe("GET /jobs/:jobId", () => {
    it("returns 404 for an unknown id", async () => {
      const res = await request(app).get("/jobs/00000000-0000-0000-0000-000000000000");
      assert.equal(res.status, 404);
      assert.equal(res.body.error, "not_found");
    });

    it("returns status, commit, and logs once the build finishes", async () => {
      const created = await request(app).post("/deploy").send({ repoUrl: REPO, dockerfilePath: "docker/Dockerfile" });
      const done = await waitForJobStatus(app, created.body.jobId, "succeeded");

      assert.equal(done.body.dockerfilePath, "docker/Dockerfile");
      assert.equal(done.body.commitSha, FAKE_SHA);
      assert.equal(done.body.error, null);
      assert.equal(done.body.logTruncated, false);
      assert.match(done.body.logs, /clone ok[\s\S]*build ok/);
      assert.ok(Date.parse(done.body.createdAt) <= Date.parse(done.body.updatedAt));
    });

    it("reports failure from the worker", async () => {
      const failing = createApp({
        runner: createFakeRunner({
          build: async () => {
            throw new Error("docker build exploded");
          },
        }),
      });
      const created = await request(failing).post("/deploy").send({ repoUrl: REPO });
      const done = await waitForJobStatus(failing, created.body.jobId, "failed");
      assert.equal(done.body.error, "docker build exploded");
      assert.match(done.body.logs, /Build failed: docker build exploded/);
    });
  });

  describe("GET /jobs/:jobId/logs", () => {
    it("pages through logs and reports done only at the end", async () => {
      const gate = deferred();
      const paused = createApp({
        runner: createFakeRunner({
          build: async (_dir, _file, _tag, log) => {
            log("step 1\n");
            await gate.promise;
            log("step 2\n");
          },
        }),
      });
      const { body } = await request(paused).post("/deploy").send({ repoUrl: REPO });
      const url = `/jobs/${body.jobId}/logs`;

      const first = await waitFor(async () => {
        const res = await request(paused).get(url);
        return res.body.chunks.some((c: { text: string }) => c.text === "step 1\n") ? res : undefined;
      }, "step 1");
      assert.equal(first.body.done, false);
      assert.equal(first.body.status, "building");

      gate.resolve();
      await waitForJobStatus(paused, body.jobId, "succeeded");

      const rest = await request(paused).get(`${url}?after=${first.body.nextSeq}`);
      const texts = rest.body.chunks.map((c: { text: string }) => c.text).join("");
      assert.doesNotMatch(texts, /step 1/);
      assert.match(texts, /step 2[\s\S]*Build succeeded/);
      assert.equal(rest.body.done, true);

      const paged = await request(paused).get(`${url}?after=0&limit=1`);
      assert.equal(paged.body.chunks.length, 1);
      assert.equal(paged.body.done, false);
    });

    for (const query of ["after=-1", "after=abc", "limit=0", "limit=5000"]) {
      it(`rejects ?${query} with 400`, async () => {
        const { body } = await request(app).post("/deploy").send({ repoUrl: REPO });
        const res = await request(app).get(`/jobs/${body.jobId}/logs?${query}`);
        assert.equal(res.status, 400);
        assert.equal(res.body.error, "invalid_request");
      });
    }

    it("returns 404 for an unknown id", async () => {
      const res = await request(app).get("/jobs/00000000-0000-0000-0000-000000000000/logs");
      assert.equal(res.status, 404);
    });
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/nope");
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, { error: "not_found", message: "No such route" });
  });
});
