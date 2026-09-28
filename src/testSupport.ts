// Helpers shared by the *.test.ts files. Excluded from the build.
import type { BuildRunner } from "./buildRunner.js";

export const FAKE_SHA = "0123456789abcdef0123456789abcdef01234567";

export function deferred<T = void>(): {
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

/**
 * A working in-memory runner. Override any step; `calls` records the order of
 * operations for tests where the order is the behaviour under test.
 */
export function createFakeRunner(
  hooks: Partial<BuildRunner> & { calls?: string[] } = {},
): BuildRunner {
  const calls = hooks.calls ?? [];
  return {
    clone: async (repoUrl, destDir, log, signal) => {
      calls.push(`clone ${repoUrl} ${destDir}`);
      if (hooks.clone) {
        return hooks.clone(repoUrl, destDir, log, signal);
      }
      log("clone ok\n");
      return { commitSha: FAKE_SHA };
    },
    build: async (workDir, dockerfilePath, imageTag, log, signal) => {
      calls.push(`build ${workDir} ${dockerfilePath} ${imageTag}`);
      if (hooks.build) {
        return hooks.build(workDir, dockerfilePath, imageTag, log, signal);
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

/** Polls `check` until it returns something other than undefined. */
export async function waitFor<T>(
  check: () => Promise<T | undefined>,
  describe: string,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${describe}`);
}

/** Resolves when `signal` aborts; for fakes that should behave like a stoppable command. */
export function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
