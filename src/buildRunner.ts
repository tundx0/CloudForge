import { spawn } from "node:child_process";
import { mkdir, realpath, rm } from "node:fs/promises";
import { devNull } from "node:os";
import path from "node:path";
import { DEFAULT_BUILD_TIMEOUT_MS, DEFAULT_CLONE_TIMEOUT_MS } from "./config.js";

export type LogSink = (chunk: string) => void;

/**
 * The side effects a build needs. `signal` lets the caller stop a step early,
 * e.g. on shutdown; implementations must stop promptly and reject.
 */
export type BuildRunner = {
  /** Clones and reports the exact commit that was checked out. */
  clone(
    repoUrl: string,
    destDir: string,
    log: LogSink,
    signal?: AbortSignal,
  ): Promise<{ commitSha: string }>;
  build(
    workDir: string,
    dockerfilePath: string,
    imageTag: string,
    log: LogSink,
    signal?: AbortSignal,
  ): Promise<void>;
  cleanup(dir: string): Promise<void>;
};

export class DockerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

export class CommandTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} timed out after ${timeoutMs}ms`);
    this.name = "CommandTimeoutError";
  }
}

export class CommandAbortedError extends Error {
  constructor(command: string, reason: string) {
    super(`${command} stopped: ${reason}`);
    this.name = "CommandAbortedError";
  }
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    log: LogSink;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
) => Promise<void>;

/** How long a child gets to exit after SIGTERM before it is SIGKILLed. */
const KILL_GRACE_MS = 5_000;

/** Only the tail of output is kept for error classification. */
const OUTPUT_TAIL_BYTES = 4_096;

/**
 * Variables children may inherit. Everything else (API keys, cloud
 * credentials, GIT_ASKPASS, ...) is withheld from git and docker.
 */
const PASSTHROUGH_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SYSTEMROOT",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_BUILDKIT",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

export function childEnv(
  source: NodeJS.ProcessEnv = process.env,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSTHROUGH_ENV) {
    if (source[name] !== undefined) {
      env[name] = source[name];
    }
  }
  return { ...env, ...extra };
}

/**
 * Keeps git from prompting for credentials and from using the server
 * operator's global/system config (including credential helpers).
 */
export const GIT_ENV: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: devNull,
};

/** An empty `credential.helper` resets any helper configured elsewhere. */
export const GIT_SAFE_CONFIG: readonly string[] = [
  "-c",
  "credential.helper=",
  "-c",
  "core.askPass=",
];

export function isDockerDaemonError(output: string): boolean {
  const lower = output.toLowerCase();
  return (
    lower.includes("cannot connect to the docker daemon") ||
    lower.includes("is the docker daemon running") ||
    lower.includes("cannot connect to the docker api") ||
    lower.includes("error during connect") ||
    lower.includes("failed to connect to the docker")
  );
}

export const runCommand: RunCommand = (
  command,
  args,
  { cwd, log, env = childEnv(), timeoutMs, signal },
) => {
  if (signal?.aborted) {
    return Promise.reject(new CommandAbortedError(command, abortReason(signal)));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      // stdin closed: a child that reads it (e.g. `docker build -f -`) gets EOF
      // instead of waiting forever.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let settled = false;
    let stopReason: Error | undefined;
    let tail = "";
    let killTimer: NodeJS.Timeout | undefined;

    // One way to stop a child, whatever the cause: ask, then insist.
    const stop = (reason: Error) => {
      if (stopReason || settled) {
        return;
      }
      stopReason = reason;
      log(`\n${reason.message}; stopping ${command}\n`);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };

    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => stop(new CommandTimeoutError(command, timeoutMs)), timeoutMs);
    const onAbort = () =>
      stop(new CommandAbortedError(command, abortReason(signal!)));
    signal?.addEventListener("abort", onAbort, { once: true });

    const settle = (err?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const onData = (text: string) => {
      tail = (tail + text).slice(-OUTPUT_TAIL_BYTES);
      log(text);
    };

    // setEncoding buffers multi-byte characters split across chunks.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (command === "docker" && err.code === "ENOENT") {
        settle(new DockerUnavailableError("Docker is not installed or not on PATH"));
        return;
      }
      if (command === "git" && err.code === "ENOENT") {
        settle(new Error("Git is not installed or not on PATH"));
        return;
      }
      settle(err);
    });

    child.on("close", (code) => {
      if (stopReason) {
        settle(stopReason);
        return;
      }
      if (code === 0) {
        settle();
        return;
      }
      if (command === "docker" && isDockerDaemonError(tail)) {
        settle(
          new DockerUnavailableError(
            "Docker daemon is unreachable. Is the Docker daemon running?",
          ),
        );
        return;
      }
      settle(new Error(`${command} exited with code ${code}`));
    });
  });
};

function abortReason(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.message : String(reason ?? "aborted");
}

/**
 * Resolves `relPath` inside `rootDir`, following symlinks, and rejects if the
 * real file lies outside it. Returns the absolute real path.
 */
export async function resolveInside(rootDir: string, relPath: string): Promise<string> {
  const root = await realpath(rootDir);
  let target: string;
  try {
    target = await realpath(path.join(root, relPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Dockerfile not found in repository: ${relPath}`);
    }
    throw err;
  }
  const rel = path.relative(root, target);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`dockerfilePath resolves outside the repository: ${relPath}`);
  }
  return target;
}

export type BuildRunnerOptions = {
  cloneTimeoutMs?: number;
  buildTimeoutMs?: number;
};

const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function createDefaultBuildRunner(
  run: RunCommand = runCommand,
  {
    cloneTimeoutMs = DEFAULT_CLONE_TIMEOUT_MS,
    buildTimeoutMs = DEFAULT_BUILD_TIMEOUT_MS,
  }: BuildRunnerOptions = {},
): BuildRunner {
  const gitEnv = () => childEnv(process.env, GIT_ENV);

  return {
    async clone(repoUrl, destDir, log, signal) {
      await mkdir(path.dirname(destDir), { recursive: true });
      await run(
        "git",
        [...GIT_SAFE_CONFIG, "clone", "--depth", "1", "--", repoUrl, destDir],
        { log, env: gitEnv(), timeoutMs: cloneTimeoutMs, signal },
      );

      // Record exactly what was built: the default branch moves over time.
      let output = "";
      await run("git", [...GIT_SAFE_CONFIG, "-C", destDir, "rev-parse", "HEAD"], {
        log: (chunk) => {
          output += chunk;
        },
        env: gitEnv(),
        timeoutMs: 10_000,
        signal,
      });
      const commitSha = output.trim();
      if (!COMMIT_SHA.test(commitSha)) {
        throw new Error(`Could not read the cloned commit (got "${commitSha.slice(0, 80)}")`);
      }
      log(`Checked out commit ${commitSha}\n`);
      return { commitSha };
    },

    async build(workDir, dockerfilePath, imageTag, log, signal) {
      // The repo may contain a symlinked Dockerfile pointing outside it.
      // An absolute path also cannot be mistaken for a flag.
      const dockerfile = await resolveInside(workDir, dockerfilePath);
      await run(
        "docker",
        ["build", "-f", dockerfile, "-t", imageTag, "."],
        { cwd: workDir, log, timeoutMs: buildTimeoutMs, signal },
      );
    },

    async cleanup(dir) {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
