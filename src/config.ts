import { DEFAULT_ALLOWED_GIT_HOSTS } from "./validation.js";

export type Config = {
  port: number;
  host: string;
  workDir: string;
  /** SQLite file, or ":memory:" to keep jobs only for the life of the process. */
  databasePath: string;
  /** `null` means any host is allowed. */
  allowedGitHosts: readonly string[] | null;
  cloneTimeoutMs: number;
  buildTimeoutMs: number;
  maxConcurrentBuilds: number;
  maxQueuedBuilds: number;
  maxLogBytes: number;
  shutdownGraceMs: number;
};

export const DEFAULT_CLONE_TIMEOUT_MS = 2 * 60 * 1000;
export const DEFAULT_BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Throws on invalid values so misconfiguration fails at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: readInt(env, "PORT", 3000, { min: 0, max: 65535 }),
    host: env.HOST?.trim() || "127.0.0.1",
    workDir: env.WORK_DIR?.trim() || ".work",
    databasePath: env.DATABASE_PATH?.trim() || ".data/cloudforge.db",
    allowedGitHosts: readHostList(env.ALLOWED_GIT_HOSTS),
    cloneTimeoutMs: readInt(env, "CLONE_TIMEOUT_MS", DEFAULT_CLONE_TIMEOUT_MS, {
      min: 1,
    }),
    buildTimeoutMs: readInt(env, "BUILD_TIMEOUT_MS", DEFAULT_BUILD_TIMEOUT_MS, {
      min: 1,
    }),
    maxConcurrentBuilds: readInt(env, "MAX_CONCURRENT_BUILDS", 2, { min: 1, max: 64 }),
    maxQueuedBuilds: readInt(env, "MAX_QUEUED_BUILDS", 50, { min: 0 }),
    maxLogBytes: readInt(env, "MAX_LOG_BYTES", 5 * 1024 * 1024, { min: 1024 }),
    // Below Kubernetes' default 30s termination grace period, so we finish
    // before we are SIGKILLed.
    shutdownGraceMs: readInt(env, "SHUTDOWN_GRACE_MS", 25_000, { min: 0 }),
  };
}

function readInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  { min, max = Number.MAX_SAFE_INTEGER }: { min: number; max?: number },
): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got "${raw}"`);
  }
  return value;
}

function readHostList(raw: string | undefined): readonly string[] | null {
  const value = raw?.trim();
  if (!value) {
    return DEFAULT_ALLOWED_GIT_HOSTS;
  }
  if (value === "*") {
    return null;
  }
  return value
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host !== "");
}
