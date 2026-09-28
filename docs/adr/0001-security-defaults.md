# 0001. Default to secure input handling and minimal process privileges

- Status: Accepted
- Date: 2026-09-28

## Context

The [production readiness review](../production-readiness.md) verified that one unauthenticated request could read host files through `dockerfilePath` (S1), hang a build forever (R1), leak credentials into public logs (S4), and make the server fetch internal URLs (S3). The server also lent its own git credentials to any caller (S5). All of these came from trusting input, or trusting the environment, by default.

## Options considered

1. **Block-lists**: reject known-bad values (`..`, `169.254.169.254`, `AWS_*`). Easy to write, but only as good as the list, and it fails open for anything nobody thought of.
2. **Allow-lists and layered checks**: accept only known-good shapes (relative paths inside the repo, named git hosts, named environment variables), and re-check at each layer that can see more. Stricter; some legitimate uses need configuration.
3. **Isolation only**: run everything in a sandbox and stop worrying about input. Correct in the long run (S2), but a separate project, and it doesn't stop credential leaks or bad error messages.

## Decision

Option 2, with these defaults:

- `repoUrl`: `http(s)` only, no embedded credentials, host must be in `ALLOWED_GIT_HOSTS` (default GitHub, GitLab, Bitbucket; `*` to opt out).
- `dockerfilePath`: validated syntactically at the API, then re-validated against the real filesystem (symlinks resolved) before `docker build`, which receives the resolved absolute path.
- Child processes: allow-listed environment, stdin closed, per-step timeouts. git runs with prompts, system and global config, and credential helpers disabled.
- The server binds to `127.0.0.1` unless `HOST` says otherwise.
- Errors never include stack traces, and bodies are capped at 16 KB.

## Consequences

- A new environment variable a future build *needs* has to be added to the allow-list on purpose. That friction is the point.
- Self-hosted git servers need `ALLOWED_GIT_HOSTS` configured. Setting `*` brings back the SSRF risk, and the docs say so.
- Private repos can't be built until there is a proper credential mechanism (Auth + projects milestone).
- None of this contains a malicious `RUN` step. That is S2, and it's tracked separately.

## Revisit when

- Untrusted users get access. Isolation (S2) and auth (S6) are then prerequisites, not follow-ups.
- Arbitrary git hosts must be supported. That needs IP-range checks with DNS pinning, not just a host list.
