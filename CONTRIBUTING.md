# Contributing

## Setup

See [docs/setup.md](docs/setup.md). In short: Node ≥ 22.13 (`.nvmrc` says 22), `corepack enable`, `pnpm install`.

## The one command

```bash
pnpm check
```

It runs the same gates as CI, in the same order: type-check (source **and** tests), test, build. Run it before you push. If it passes locally and fails in CI, that's a bug in the project, so open an issue.

## How changes are expected to look

**Small and single-purpose.** A PR that fixes a bug *and* refactors a module *and* adds a feature can't be reviewed properly. Split it.

**Tests first for bugs.** Write the test that fails because of the bug, then fix it. The PR description links the two.

**Keep the seams.** The architecture depends on a few boundaries staying clean:

| Module | Must not import |
| --- | --- |
| `jobs.ts`, `scheduler.ts`, `validation.ts` | `express`, `node:child_process`, any storage driver |
| `buildWorker.ts` | `express`, `node:child_process` |
| `app.ts` | `node:child_process`, `node:sqlite` |

If a change seems to need one of these imports, the design question comes first. Raise it in the PR.

**Every repository implementation passes the contract suite.** A new `JobRepository` gets added to `repositoryContract(...)` in [`src/jobs.test.ts`](src/jobs.test.ts). No exceptions.

**No new floating promises.** A promise that isn't awaited must be deliberate, marked with `void`, and have its rejection handled.

**Every subprocess** is spawned with an argv array (never `shell: true`), through `runCommand`, with a timeout.

## Documentation is part of the change

- A behaviour change updates the relevant page under `docs/` **in the same PR**. Reviewers should reject code-only PRs that make the docs wrong.
- A decision that is hard to reverse, surprising, or has a real alternative gets an [ADR](docs/adr/README.md).
- User-visible changes go under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md). Breaking changes go under **Breaking**, with what the user must do.
- Findings in [production-readiness.md](docs/production-readiness.md) keep their original analysis. Update the **Status** column and add a status note rather than rewriting history.

## Commit messages

Imperative mood, under about 72 characters for the subject (e.g. `Enforce job state transitions with compare-and-set`). The body explains **why**; the diff already shows what.

## Review checklist

Reviewers (and authors, before asking for review):

- [ ] What happens when this fails? Under load? On restart? If the dependency is slow?
- [ ] Is every external call bounded by a timeout?
- [ ] Is every input from outside the process validated at the boundary?
- [ ] Can two requests or workers race here? If so, what stops them?
- [ ] Is there a test that would fail if this change were reverted?
- [ ] Are the docs, changelog, and (if needed) an ADR updated?
