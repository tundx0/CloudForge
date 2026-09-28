import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  canTransition,
  failJob,
  IllegalTransitionError,
  InMemoryJobRepository,
  isTerminal,
  JOB_STATUSES,
  planLogAppend,
  readAllLogs,
  type JobRepository,
  type NewJob,
} from "./jobs.js";
import { SqliteJobRepository } from "./sqliteJobRepository.js";

let counter = 0;
function newJob(overrides: Partial<NewJob> = {}): NewJob {
  counter += 1;
  const jobId = `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  return {
    jobId,
    repoUrl: "https://github.com/example/app",
    dockerfilePath: "Dockerfile",
    imageTag: `cloudforge-${counter}`,
    ...overrides,
  };
}

describe("job state machine", () => {
  it("allows only the forward path and failure from non-terminal states", () => {
    const allowed = JOB_STATUSES.flatMap((from) =>
      JOB_STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}→${to}`),
    );
    assert.deepEqual(allowed, [
      "queued→cloning",
      "queued→failed",
      "cloning→building",
      "cloning→failed",
      "building→succeeded",
      "building→failed",
    ]);
  });

  it("treats succeeded and failed as terminal", () => {
    assert.deepEqual(
      JOB_STATUSES.filter(isTerminal),
      ["succeeded", "failed"],
    );
  });
});

describe("planLogAppend", () => {
  it("stores text that fits", () => {
    assert.deepEqual(planLogAppend(0, false, "abc", 10), { text: "abc", bytes: 3, truncated: false });
  });

  it("keeps the head and adds one marker when the cap is crossed", () => {
    const plan = planLogAppend(8, false, "abcdef", 10);
    assert.equal(plan.truncated, true);
    assert.match(plan.text!, /^ab\n\[log truncated at 10 bytes\]\n$/);
  });

  it("stores nothing once truncated", () => {
    assert.deepEqual(planLogAppend(50, true, "more", 10), { text: null, bytes: 50, truncated: true });
  });

  it("counts bytes, not characters", () => {
    assert.equal(planLogAppend(0, false, "é", 10).bytes, 2);
  });
});

/**
 * The contract every JobRepository must honour. Running it against each
 * implementation is what lets tests use the in-memory one with confidence.
 */
function repositoryContract(name: string, make: (maxLogBytes?: number) => JobRepository) {
  describe(`${name} (JobRepository contract)`, () => {
    it("creates a queued job and reads it back", async () => {
      const repo = make();
      const input = newJob();
      const created = await repo.create(input);
      assert.equal(created.status, "queued");
      assert.equal(created.commitSha, null);
      assert.equal(created.error, null);
      assert.equal(created.imageTag, input.imageTag);
      assert.deepEqual(await repo.get(input.jobId), created);
      assert.equal(await repo.get("missing"), undefined);
    });

    it("rejects a duplicate job id", async () => {
      const repo = make();
      const input = newJob();
      await repo.create(input);
      await assert.rejects(() => repo.create(input));
    });

    it("returns copies, so callers cannot change stored state by accident", async () => {
      const repo = make();
      const input = newJob();
      const job = (await repo.create(input));
      job.status = "succeeded";
      assert.equal((await repo.get(input.jobId))!.status, "queued");
    });

    it("transitions only from the expected state (compare-and-set)", async () => {
      const repo = make();
      const { jobId } = await repo.create(newJob());
      assert.equal(await repo.transition(jobId, "queued", "cloning"), true);
      // A second worker holding a stale view loses the race.
      assert.equal(await repo.transition(jobId, "queued", "cloning"), false);
      assert.equal((await repo.get(jobId))!.status, "cloning");
    });

    it("throws on a transition the state machine forbids", async () => {
      const repo = make();
      const { jobId } = await repo.create(newJob());
      await assert.rejects(() => repo.transition(jobId, "queued", "succeeded"), IllegalTransitionError);
      await assert.rejects(() => repo.transition(jobId, "failed", "building"), IllegalTransitionError);
    });

    it("records commitSha and error through transitions", async () => {
      const repo = make();
      const { jobId } = await repo.create(newJob());
      await repo.transition(jobId, "queued", "cloning");
      await repo.transition(jobId, "cloning", "building", { commitSha: "abc" });
      await repo.transition(jobId, "building", "failed", { error: "boom" });
      const job = (await repo.get(jobId))!;
      assert.equal(job.commitSha, "abc");
      assert.equal(job.error, "boom");
      assert.equal(job.status, "failed");
    });

    it("returns false when transitioning an unknown job", async () => {
      assert.equal(await make().transition("missing", "queued", "cloning"), false);
    });

    it("appends logs in order and pages through them", async () => {
      const repo = make();
      const { jobId } = await repo.create(newJob());
      for (const text of ["a", "b", "c"]) {
        await repo.appendLog(jobId, text);
      }
      assert.deepEqual(await repo.readLogs(jobId, 0, 2), {
        chunks: [{ seq: 1, text: "a" }, { seq: 2, text: "b" }],
        nextSeq: 2,
      });
      assert.deepEqual(await repo.readLogs(jobId, 2), { chunks: [{ seq: 3, text: "c" }], nextSeq: 3 });
      assert.deepEqual(await repo.readLogs(jobId, 3), { chunks: [], nextSeq: 3 });
      assert.equal(await readAllLogs(repo, jobId), "abc");
    });

    it("ignores empty log text and unknown jobs", async () => {
      const repo = make();
      const { jobId } = await repo.create(newJob());
      await repo.appendLog(jobId, "");
      await repo.appendLog("missing", "x");
      assert.deepEqual(await repo.readLogs(jobId), { chunks: [], nextSeq: 0 });
    });

    it("caps log size and marks the job truncated", async () => {
      const repo = make(1024);
      const { jobId } = await repo.create(newJob());
      await repo.appendLog(jobId, "x".repeat(1000));
      await repo.appendLog(jobId, "y".repeat(1000));
      await repo.appendLog(jobId, "never stored");
      const job = (await repo.get(jobId))!;
      const logs = await readAllLogs(repo, jobId);
      assert.equal(job.logTruncated, true);
      assert.match(logs, /\[log truncated at 1024 bytes\]\n$/);
      assert.doesNotMatch(logs, /never stored/);
      assert.ok(Buffer.byteLength(logs) < 1100);
    });

    it("lists jobs by status, oldest first", async () => {
      const repo = make();
      const first = await repo.create(newJob());
      const second = await repo.create(newJob());
      const third = await repo.create(newJob());
      await repo.transition(second.jobId, "queued", "cloning");
      assert.deepEqual(
        (await repo.listByStatus(["queued"])).map((job) => job.jobId),
        [first.jobId, third.jobId],
      );
      assert.deepEqual(await repo.listByStatus([]), []);
    });

    it("failJob fails a job from any non-terminal state, and never a finished one", async () => {
      const repo = make();
      const { jobId } = await repo.create(newJob());
      await repo.transition(jobId, "queued", "cloning");
      assert.equal(await failJob(repo, jobId, "boom"), true);
      assert.equal((await repo.get(jobId))!.status, "failed");
      assert.equal(await failJob(repo, jobId, "again"), false);
      assert.equal((await repo.get(jobId))!.error, "boom");
    });
  });
}

repositoryContract("InMemoryJobRepository", (maxLogBytes) => new InMemoryJobRepository({ maxLogBytes }));
repositoryContract("SqliteJobRepository", (maxLogBytes) => new SqliteJobRepository(":memory:", { maxLogBytes }));

describe("SqliteJobRepository persistence", () => {
  it("keeps jobs and logs across close and reopen, and migrates only once", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cloudforge-db-"));
    const file = path.join(dir, "nested", "jobs.db");
    try {
      const first = new SqliteJobRepository(file);
      const { jobId } = await first.create(newJob());
      await first.transition(jobId, "queued", "cloning");
      await first.appendLog(jobId, "hello");
      await first.close();

      const second = new SqliteJobRepository(file);
      assert.equal((await second.get(jobId))!.status, "cloning");
      assert.equal(await readAllLogs(second, jobId), "hello");
      await second.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
