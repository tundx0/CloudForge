import { randomUUID } from "node:crypto";
import express, { type Express } from "express";

export type DeployRequestBody = {
  repoUrl?: unknown;
  dockerfilePath?: unknown;
};

export type DeployAcceptedResponse = {
  jobId: string;
  status: "accepted";
  repoUrl: string;
  dockerfilePath: string;
  message: string;
};

export type ErrorResponse = {
  error: "invalid_request";
  message: string;
};

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.post("/deploy", (req, res) => {
    const { repoUrl, dockerfilePath } = (req.body ?? {}) as DeployRequestBody;

    if (typeof repoUrl !== "string" || repoUrl.trim() === "") {
      const body: ErrorResponse = {
        error: "invalid_request",
        message: "repoUrl is required and must be a non-empty string",
      };
      res.status(400).json(body);
      return;
    }

    if (!isHttpUrl(repoUrl)) {
      const body: ErrorResponse = {
        error: "invalid_request",
        message: "repoUrl must be an http(s) git URL",
      };
      res.status(400).json(body);
      return;
    }

    if (dockerfilePath !== undefined && typeof dockerfilePath !== "string") {
      const body: ErrorResponse = {
        error: "invalid_request",
        message: "dockerfilePath must be a string when provided",
      };
      res.status(400).json(body);
      return;
    }

    const path = dockerfilePath?.trim() || "Dockerfile";
    const body: DeployAcceptedResponse = {
      jobId: randomUUID(),
      status: "accepted",
      repoUrl: repoUrl.trim(),
      dockerfilePath: path,
      message:
        "Deploy job accepted. Image build and cloud deploy are not implemented in this scaffold.",
    };
    res.status(202).json(body);
  });

  return app;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
