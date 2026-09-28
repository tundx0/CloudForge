import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { InMemoryJobRepository, readAllLogs } from "./jobs.js";
import { INTERRUPTED_ERROR, recoverJobs, sweepWorkDir } from "./recovery.js";
import { BuildScheduler } from "./scheduler.js";

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
];

describe("sweepWorkDir", () => {
  it("removes only UUID-named directories", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cloudforge-sweep-"));
    try {
      await mkdir(path.join(dir, ids[0]));
      await writeFile(path.join(dir, ids[0], "file"), "x");
      await mkdir(path.join(dir, "not-a-job"));
      await writeFile(path.join(dir, ids[1]), "a file, not a directory");

      assert.deepEqual(await sweepWorkDir(dir), [ids[0]]);
      assert.deepEqual((await readdir(dir)).sort(), [ids[1], "not-a-job"].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing work dir as empty", async () => {
    assert.deepEqual(await sweepWorkDir(path.join(tmpdir(), "cloudforge-does-not-exist")), []);
  });
});

describe("recoverJobs", () => {
  it("fails interrupted builds and requeues never-started jobs in order", async () => {
    const jobs = new InMemoryJobRepository();
    for (const jobId of ids) {
      await jobs.create({ jobId, repoUrl: "https://github.com/x/y", dockerfilePath: "Dockerfile", imageTag: "t" });
    }
    await jobs.transition(ids[1], "queued", "cloning");
    await jobs.transition(ids[2], "queued", "cloning");
    await jobs.transition(ids[2], "cloning", "building");

    const started: string[] = [];
    const scheduler = new BuildScheduler({
      concurrency: 1,
      maxQueued: 0,
      execute: async (id) => {
        started.push(id);
        await new Promise(() => {}); // stay running so the rest stay queued
      },
      onError: () => {},
    });

    const result = await recoverJobs(jobs, scheduler);

    assert.deepEqual(result, { failed: [ids[1], ids[2]], requeued: [ids[0], ids[3]] });
    for (const jobId of [ids[1], ids[2]]) {
      const job = (await jobs.get(jobId))!;
      assert.equal(job.status, "failed");
      assert.equal(job.error, INTERRUPTED_ERROR);
      assert.match(await readAllLogs(jobs, jobId), /Interrupted/);
    }
    // Requeued even though maxQueued is 0: accepted work is never dropped.
    assert.deepEqual(started, [ids[0]]);
    assert.equal(scheduler.stats().queued, 1);
  });
});
