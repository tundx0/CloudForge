import path from "node:path";

export const DEFAULT_ALLOWED_GIT_HOSTS: readonly string[] = [
  "github.com",
  "gitlab.com",
  "bitbucket.org",
];

export type DeployInput = {
  repoUrl: string;
  dockerfilePath: string;
};

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * `allowedHosts` of `null` disables the host allow-list (any public or
 * private host is accepted). Only do that for trusted, local use.
 */
export function parseDeployRequest(
  body: unknown,
  allowedHosts: readonly string[] | null,
): ValidationResult<DeployInput> {
  const { repoUrl, dockerfilePath } = (
    typeof body === "object" && body !== null ? body : {}
  ) as { repoUrl?: unknown; dockerfilePath?: unknown };

  if (typeof repoUrl !== "string" || repoUrl.trim() === "") {
    return fail("repoUrl is required and must be a non-empty string");
  }
  const url = validateRepoUrl(repoUrl.trim(), allowedHosts);
  if (!url.ok) {
    return url;
  }

  if (dockerfilePath !== undefined && typeof dockerfilePath !== "string") {
    return fail("dockerfilePath must be a string when provided");
  }
  const file = validateDockerfilePath(dockerfilePath?.trim() || "Dockerfile");
  if (!file.ok) {
    return file;
  }

  return { ok: true, value: { repoUrl: url.value, dockerfilePath: file.value } };
}

export function validateRepoUrl(
  value: string,
  allowedHosts: readonly string[] | null,
): ValidationResult<string> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("repoUrl must be an http(s) git URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("repoUrl must be an http(s) git URL");
  }
  // Credentials would be echoed into public job logs and error messages.
  if (url.username !== "" || url.password !== "") {
    return fail("repoUrl must not contain credentials");
  }
  if (allowedHosts !== null && !allowedHosts.includes(url.hostname)) {
    return fail(`repoUrl host must be one of: ${allowedHosts.join(", ")}`);
  }
  return { ok: true, value };
}

/**
 * Accepts only a relative path that stays inside the repository. This is a
 * syntactic check; the runner re-checks after cloning because the repo itself
 * may contain symlinks that point outside it.
 */
export function validateDockerfilePath(value: string): ValidationResult<string> {
  if (value.includes("\0")) {
    return fail("dockerfilePath must not contain NUL bytes");
  }
  // `-` makes `docker build -f -` read stdin; other leading dashes are flags.
  if (value.startsWith("-")) {
    return fail("dockerfilePath must not start with '-'");
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return fail("dockerfilePath must be relative to the repository root");
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    return fail("dockerfilePath must stay inside the repository");
  }
  if (normalized === "." || normalized.endsWith("/")) {
    return fail("dockerfilePath must point to a file");
  }
  return { ok: true, value: normalized };
}

function fail(message: string): { ok: false; message: string } {
  return { ok: false, message };
}
