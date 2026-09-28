import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "./config.js";
import {
  DEFAULT_ALLOWED_GIT_HOSTS,
  parseDeployRequest,
  validateDockerfilePath,
  validateRepoUrl,
} from "./validation.js";

describe("validateDockerfilePath", () => {
  const accepted: [string, string][] = [
    ["Dockerfile", "Dockerfile"],
    ["./Dockerfile", "Dockerfile"],
    ["docker/Dockerfile", "docker/Dockerfile"],
    ["app/../Dockerfile.prod", "Dockerfile.prod"],
    ["docker\\Dockerfile", "docker/Dockerfile"],
  ];
  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      assert.deepEqual(validateDockerfilePath(input), { ok: true, value: expected });
    });
  }

  const rejected = [
    "-",
    "--help",
    "-f",
    "..",
    "../outside.txt",
    "a/../../x",
    "../../../etc/passwd",
    "/etc/passwd",
    "C:\\Windows\\win.ini",
    ".",
    "docker/",
    "Dockerfile\0",
  ];
  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(validateDockerfilePath(input).ok, false);
    });
  }
});

describe("validateRepoUrl", () => {
  const hosts = DEFAULT_ALLOWED_GIT_HOSTS;

  it("accepts an allow-listed https URL", () => {
    assert.equal(validateRepoUrl("https://github.com/example/app", hosts).ok, true);
  });

  it("matches hosts case-insensitively", () => {
    assert.equal(validateRepoUrl("https://GitHub.com/example/app", hosts).ok, true);
  });

  for (const input of [
    "https://user:token@github.com/example/app",
    "https://token@github.com/example/app",
  ]) {
    it(`rejects credentials in ${input}`, () => {
      const result = validateRepoUrl(input, hosts);
      assert.deepEqual(result, { ok: false, message: "repoUrl must not contain credentials" });
    });
  }

  for (const input of [
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:6379/",
    "http://10.0.0.5/admin",
    "https://github.com.evil.example/x",
  ]) {
    it(`rejects non-allow-listed host ${input}`, () => {
      assert.equal(validateRepoUrl(input, hosts).ok, false);
    });
  }

  for (const input of ["not-a-url", "--upload-pack=touch /tmp/x", "file:///etc", "ssh://git@github.com/x"]) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      assert.equal(validateRepoUrl(input, hosts).ok, false);
    });
  }

  it("allows any host when the allow-list is disabled", () => {
    assert.equal(validateRepoUrl("http://git.internal/repo", null).ok, true);
  });
});

describe("parseDeployRequest", () => {
  it("defaults and normalises dockerfilePath", () => {
    assert.deepEqual(
      parseDeployRequest({ repoUrl: " https://github.com/x/y ", dockerfilePath: "  " }, null),
      { ok: true, value: { repoUrl: "https://github.com/x/y", dockerfilePath: "Dockerfile" } },
    );
  });

  it("rejects a non-object body", () => {
    assert.equal(parseDeployRequest("nope", null).ok, false);
    assert.equal(parseDeployRequest(null, null).ok, false);
  });

  it("rejects a non-string dockerfilePath", () => {
    assert.deepEqual(parseDeployRequest({ repoUrl: "https://github.com/x/y", dockerfilePath: 1 }, null), {
      ok: false,
      message: "dockerfilePath must be a string when provided",
    });
  });
});

describe("loadConfig", () => {
  it("uses safe defaults", () => {
    const config = loadConfig({});
    assert.equal(config.port, 3000);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.workDir, ".work");
    assert.deepEqual(config.allowedGitHosts, DEFAULT_ALLOWED_GIT_HOSTS);
    assert.equal(config.databasePath, ".data/cloudforge.db");
    assert.equal(config.maxConcurrentBuilds, 2);
    assert.equal(config.maxQueuedBuilds, 50);
    assert.equal(config.maxLogBytes, 5 * 1024 * 1024);
    assert.equal(config.shutdownGraceMs, 25_000);
  });

  it("parses overrides", () => {
    const config = loadConfig({
      PORT: "0",
      HOST: "0.0.0.0",
      ALLOWED_GIT_HOSTS: " GitHub.com , git.internal ",
      CLONE_TIMEOUT_MS: "500",
    });
    assert.equal(config.port, 0);
    assert.equal(config.host, "0.0.0.0");
    assert.deepEqual(config.allowedGitHosts, ["github.com", "git.internal"]);
    assert.equal(config.cloneTimeoutMs, 500);
  });

  it("disables the host allow-list with *", () => {
    assert.equal(loadConfig({ ALLOWED_GIT_HOSTS: "*" }).allowedGitHosts, null);
  });

  it("fails loudly on invalid numbers", () => {
    assert.throws(() => loadConfig({ PORT: "abc" }), /PORT must be an integer/);
    assert.throws(() => loadConfig({ BUILD_TIMEOUT_MS: "0" }), /BUILD_TIMEOUT_MS/);
    assert.throws(() => loadConfig({ MAX_CONCURRENT_BUILDS: "0" }), /MAX_CONCURRENT_BUILDS/);
    assert.throws(() => loadConfig({ MAX_LOG_BYTES: "10" }), /MAX_LOG_BYTES/);
    assert.throws(() => loadConfig({ SHUTDOWN_GRACE_MS: "1.5" }), /SHUTDOWN_GRACE_MS/);
  });
});
