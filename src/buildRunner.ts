import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

export type LogSink = (chunk: string) => void;

export type BuildRunner = {
  clone(repoUrl: string, destDir: string, log: LogSink): Promise<void>;
  build(
    workDir: string,
    dockerfilePath: string,
    imageTag: string,
    log: LogSink,
  ): Promise<void>;
  cleanup(dir: string): Promise<void>;
};

export class DockerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

export type RunCommand = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; log: LogSink },
) => Promise<void>;

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

export const runCommand: RunCommand = (command, args, { cwd, log }) => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
    });

    let combined = "";
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      combined += text;
      log(text);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (command === "docker" && err.code === "ENOENT") {
        reject(
          new DockerUnavailableError("Docker is not installed or not on PATH"),
        );
        return;
      }
      if (command === "git" && err.code === "ENOENT") {
        reject(new Error("Git is not installed or not on PATH"));
        return;
      }
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (command === "docker" && isDockerDaemonError(combined)) {
        reject(
          new DockerUnavailableError(
            "Docker daemon is unreachable. Is the Docker daemon running?",
          ),
        );
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
};

export function createDefaultBuildRunner(
  run: RunCommand = runCommand,
): BuildRunner {
  return {
    async clone(repoUrl, destDir, log) {
      await mkdir(path.dirname(destDir), { recursive: true });
      await run("git", ["clone", "--depth", "1", repoUrl, destDir], { log });
    },

    async build(workDir, dockerfilePath, imageTag, log) {
      await run(
        "docker",
        ["build", "-f", dockerfilePath, "-t", imageTag, "."],
        { cwd: workDir, log },
      );
    },

    async cleanup(dir) {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
