import assert from "node:assert/strict";
import { describe, it } from "node:test";
import request from "supertest";
import { createApp } from "./app.js";

describe("CloudForge API", () => {
  const app = createApp();

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
});
