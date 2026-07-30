# arxiv-agent-cli

`arxiv` is a bounded arXiv CLI for autonomous coding agents. It turns searches into compact metadata, keeps downloaded PDFs in a durable local library, and makes whole-document context dumps impossible.

Its network gate coordinates all invocations by one operating-system user on one host. Every actual arXiv request starts at least three seconds after the prior one, and only one arXiv connection exists at a time.

## Requirements and installation

- macOS or Linux
- Node.js 24.15 or newer
- A local filesystem for both the runtime coordinator and paper library

```sh
npm install --global arxiv-agent-cli
```

To install the bundled agent skill as well:

```sh
git clone https://github.com/PlunderStruck/arxiv-agent-cli.git
cd arxiv-agent-cli
./install.sh
```

The installer performs a clean dependency install, builds the TypeScript, links the `arxiv` executable, and symlinks the bundled skill into the Claude, shared agent, and Codex skill roots. It refuses to replace a real file or directory at any skill destination.

To develop without a global link:

```sh
npm ci
npm test
node dist/src/cli.js --help
```

## Commands

```text
arxiv search <query> [bounded search and field filters]
arxiv get <id> [--json --no-stale]
arxiv download <id>...                 at most 3
arxiv text <id> --pages A-B [--json]   at most 5 pages
arxiv library list [--limit N --offset N --json]
arxiv library remove|restore <id>
arxiv library repair
```

Run `arxiv --help` for current flags. IDs may be modern (`2211.17192v2`) or legacy (`math.GT/0309136`). A versioned ID names immutable content; an unversioned ID asks the client to resolve the latest version. Local commands refuse an unversioned ID when more than one local version matches.

Search defaults to 10 compact abstracts. `--titles-only` buys breadth at low context cost, while `--full` is capped at five results. `text` requires an explicit inclusive range and cannot span more than five pages. Human and JSON modes enforce the same bounds.

## Library

The default library is `~/.arxiv`; set `ARXIV_LIBRARY` to a different writable local directory.

```text
papers/          validated live PDFs
papers/.tmp/     incomplete downloads
trash/           soft-deleted PDFs, retained for seven days
index.jsonl      append-only metadata and history
cache/queries/   validated upstream metadata, cached for 24 hours
```

Filesystem location decides whether a paper is live, trashed, or absent. The JSONL index supplies metadata and history but cannot overrule the files. Atomic renames commit downloads, removals, and restores; reconciliation completes any missing event after a crash. `library repair` backs up a corrupt index and rebuilds membership and local integrity facts without inventing missing upstream metadata.

The library must be on a host-local filesystem. NFS and SMB are unsupported because their rename and locking semantics do not establish the guarantees this version claims.

## Network behavior

The coordinator lives at:

```text
<os.tmpdir()>/arxiv-agent-cli-<uid>/
```

It uses an empty SQLite database only as an operating-system-released mutex. Shared pacing and circuit-breaker observations are fsynced files beside it. The gate is independent of `ARXIV_LIBRARY`, so two processes using different libraries still coordinate.

The shipped client:

- uses canonical HTTPS arXiv endpoints and a descriptive user agent;
- closes each socket before releasing the shared gate while retaining TLS session resumption;
- applies connect/header, body-stall, attempt, and overall deadlines by aborting the request;
- retries only transient failures and honors `Retry-After`;
- releases the gate during backoff and between manually validated redirect hops;
- bounds Atom feeds at 5 MiB and PDFs at 100 MiB;
- accepts a PDF only after content type, `%PDF-` magic, completed length, and parser validation.

This mechanism cannot coordinate unrelated clients, another OS user, or another machine. Operators remain responsible for arXiv's aggregate limit and must not run the CLI concurrently on multiple hosts unless an external coordinator serializes all of them.

## Output and exit contract

stdout contains payload; stderr contains waits and diagnostics. Set `ARXIV_DEBUG=1` for gate, breaker, redirect, and cache events.

| Exit | Meaning |
|---:|---|
| 0 | Success, including zero results |
| 2 | Invalid or refused command |
| 3 | Paper not found |
| 4 | Upstream unavailable |
| 5 | Shared gate unavailable |
| 6 | Local library failure |

JSON output is always a top-level object with `schemaVersion: 1` and `cliVersion`. Schema version 1 is additive: fields may be added, and consumers must treat unrecognized enum values as `unknown`. Any bounded field reports `outputTruncated` and `truncatedFields`; JSON is not an unbounded escape hatch.

## Agent skill

The bundled `skills/arxiv/SKILL.md` teaches agents to triage abstracts, download one selected paper, and read only a targeted page range. The objective is an answer grounded in a passage the agent actually read—not a count of downloaded PDFs.

## Verification

```sh
npm run verify   # typecheck, full suite, and a publishable tarball
```

The suite covers ID/path safety, Atom error handling, output caps, cache behavior, exact/base version resolution, atomic library membership, offline repair, cross-process mutex release, shared pacing and breaker state, aborting HTTP lifecycle, TLS session resumption, retries, redirect refusal, and PDF validation.

It is hermetic. No test contacts arXiv, so the suite is fast and deterministic and CI never adds load upstream. The cost of that choice is that it cannot detect arXiv itself changing:

```sh
npm run smoke    # a handful of real, paced requests against live arXiv
```

`smoke` runs on a daily schedule in CI and files an issue when the upstream contract breaks. Run it manually before a release. Do not wire it into a per-push job: the pacing guarantee is per-process, so overlapping runs are two uncoordinated clients.

## Releasing and rollback

CI verifies every push against the declared Node floor and the newest release, on Linux and macOS, and separately exercises `install.sh` end to end.

The first npm publication is a one-time bootstrap because npm requires the
package to exist before it can trust a GitHub workflow:

```sh
npm login
npm whoami
npm publish --access public
npm trust github arxiv-agent-cli \
  --file release.yml \
  --repository PlunderStruck/arxiv-agent-cli \
  --environment npm \
  --allow-publish
npm trust list arxiv-agent-cli
```

The npm account must have two-factor authentication enabled. Do not create an
`NPM_TOKEN`: subsequent releases use a short-lived identity bound to
`.github/workflows/release.yml` and the protected GitHub environment named
`npm`.

For each later release:

```sh
# 1. bump the version in BOTH package.json and src/cli.ts (CLI_VERSION)
npm run verify          # the suite fails loudly if the two disagree
npm run smoke           # confirm upstream is healthy before shipping
git commit -am "release: v0.2.0"
git push origin main
git tag v0.2.0
git push origin v0.2.0
```

Approve the `npm` environment deployment in GitHub. The workflow builds once
without publish authority, publishes that exact tarball to npm through OIDC
with provenance, and attaches the same bytes to the GitHub release.

An npm name/version pair cannot be overwritten. To recover from a bad release,
deprecate it and publish a corrected patch:

```sh
npm deprecate arxiv-agent-cli@0.2.0 "Defective release; upgrade to 0.2.1"
# bump both version declarations to 0.2.1, verify, commit, and tag v0.2.1
```

For a local checkout rollback, reinstall the last good Git tag with
`./install.sh`. The installer relinks in place and leaves the paper library and
index history intact.
