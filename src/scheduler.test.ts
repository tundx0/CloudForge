import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BuildScheduler, type Execute } from "./scheduler.js";
import { deferred, untilAborted, waitFor } from "./testSupport.js";

/** Tasks that run until the test finishes them, recording what started. */
function controllableTasks() {
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof deferred<void>>>();
  const execute: Execute = (id) => {
    started.push(id);
    const gate = deferred();
    gates.set(id, gate);
    return gate.promise;
  };
  const finish = async (id: string) => {
    gates.get(id)!.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { started, execute, finish };
}

function scheduler(execute: Execute, overrides: Partial<ConstructorParameters<typeof BuildScheduler>[0]> = {}) {
  return new BuildScheduler({
    concurrency: 2,
    maxQueued: 10,
    execute,
    onError: () => {},
    ...overrides,
  });
}

describe("BuildScheduler", () => {
  it("runs at most `concurrency` tasks, then starts the next in FIFO order", async () => {
    const tasks = controllableTasks();
    const s = scheduler(tasks.execute);
    for (const id of ["a", "b", "c", "d"]) {
      s.reserve()!.enqueue(id);
    }
    assert.deepEqual(tasks.started, ["a", "b"]);
    assert.deepEqual(s.stats(), { running: 2, queued: 2, concurrency: 2, maxQueued: 10, accepting: true });

    await tasks.finish("b");
    assert.deepEqual(tasks.started, ["a", "b", "c"]);
    await tasks.finish("a");
    assert.deepEqual(tasks.started, ["a", "b", "c", "d"]);
  });

  it("refuses reservations beyond maxQueued, counting unfinished reservations", () => {
    const tasks = controllableTasks();
    const s = scheduler(tasks.execute, { concurrency: 1, maxQueued: 2 });
    s.reserve()!.enqueue("running"); // starts immediately, not queued
    const r1 = s.reserve();
    const r2 = s.reserve();
    assert.ok(r1 && r2);
    // Both slots are held even though nothing is enqueued yet: this is what
    // stops concurrent requests from overfilling the queue across an await.
    assert.equal(s.reserve(), undefined);

    r1.release();
    assert.ok(s.reserve());
  });

  it("uses a reservation at most once", () => {
    const tasks = controllableTasks();
    const s = scheduler(tasks.execute, { concurrency: 1, maxQueued: 1 });
    s.reserve()!.enqueue("running");
    const r = s.reserve()!;
    r.enqueue("x");
    r.enqueue("y");
    r.release();
    assert.deepEqual(s.stats().queued, 1);
  });

  it("ignores an id that is already queued or running", () => {
    const tasks = controllableTasks();
    const s = scheduler(tasks.execute, { concurrency: 1 });
    s.enqueueRecovered("a");
    s.enqueueRecovered("a");
    s.enqueueRecovered("b");
    s.enqueueRecovered("b");
    assert.deepEqual(s.stats(), { running: 1, queued: 1, concurrency: 1, maxQueued: 10, accepting: true });
  });

  it("enqueueRecovered bypasses the queue limit", () => {
    const tasks = controllableTasks();
    const s = scheduler(tasks.execute, { concurrency: 1, maxQueued: 0 });
    assert.equal(s.reserve(), undefined);
    s.enqueueRecovered("a");
    s.enqueueRecovered("b");
    assert.equal(s.stats().queued, 1);
  });

  it("reports a failed task to onError and keeps going", async () => {
    const errors: string[] = [];
    const s = scheduler(
      async (id) => {
        if (id === "bad") {
          throw new Error("boom");
        }
      },
      {
        concurrency: 1,
        onError: (id, err) => {
          errors.push(`${id}: ${(err as Error).message}`);
        },
      },
    );
    s.enqueueRecovered("bad");
    s.enqueueRecovered("good");
    await waitFor(async () => (s.stats().running === 0 && s.stats().queued === 0 ? true : undefined), "idle");
    assert.deepEqual(errors, ["bad: boom"]);
  });

  it("survives an onError that throws", async () => {
    const s = scheduler(
      async () => {
        throw new Error("boom");
      },
      {
        concurrency: 1,
        onError: () => {
          throw new Error("onError broke");
        },
      },
    );
    s.enqueueRecovered("a");
    s.enqueueRecovered("b");
    await waitFor(async () => (s.stats().running === 0 && s.stats().queued === 0 ? true : undefined), "idle");
  });

  it("shutdown stops new work and waits for running tasks within the grace period", async () => {
    const tasks = controllableTasks();
    const s = scheduler(tasks.execute, { concurrency: 1 });
    s.enqueueRecovered("a");
    s.enqueueRecovered("b");

    const done = s.shutdown(5000);
    assert.equal(s.reserve(), undefined);
    await tasks.finish("a");
    assert.deepEqual(await done, { aborted: [] });
    // "b" never started; with a durable store it stays queued for next time.
    assert.deepEqual(tasks.started, ["a"]);
  });

  it("shutdown aborts tasks that outlive the grace period", async () => {
    let seenReason: unknown;
    const s = scheduler(
      async (_id, signal) => {
        try {
          await untilAborted(signal);
        } catch (err) {
          seenReason = err;
          throw err;
        }
      },
      { concurrency: 1 },
    );
    s.enqueueRecovered("slow");
    assert.deepEqual(await s.shutdown(20), { aborted: ["slow"] });
    assert.match(String(seenReason), /interrupted by shutdown/);
  });

  it("rejects invalid limits", () => {
    const run: Execute = async () => {};
    assert.throws(() => scheduler(run, { concurrency: 0 }));
    assert.throws(() => scheduler(run, { maxQueued: -1 }));
  });
});
