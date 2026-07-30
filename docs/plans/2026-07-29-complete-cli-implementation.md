# arxiv-agent-cli implementation certificate — 2026-07-29

## Outcome

Version 0.1.0 is implemented as a runnable TypeScript CLI. The shipped surface contains the six planned command families: bounded search, one-paper metadata retrieval, validated PDF download, bounded page-text extraction, library listing, and reversible library maintenance.

An **implementation certificate** is a completion record that ties a planned software product to executable evidence; its essential function is to distinguish what was built and tested from what remains an external or environmental claim.

## Before and after

| Measure | Before implementation | Completed state |
|---|---:|---:|
| Production TypeScript files | 0 | 20 |
| Automated test cases | 0 | 40 |
| CLI command families | 0 | 6 |
| Runtime dependencies | planned 2 | 2, both zero-transitive |
| Live arXiv path | design observations only | search, download, list, and page text exercised |

The implementation preserves the planned bounded-output model: default search is compact, full search caps at five results, download caps at three IDs per invocation, page extraction requires a range of at most five pages, library listing caps at 50, and `get` remains within a 20,000-character rendered ceiling.

## Implemented slices

1. **Coordinator and transport.** A schema-free SQLite write transaction supplies crash-released cross-process exclusion. The HTTPS transport disables keep-alive, waits for its assigned socket to close, and is composed inside the mutex boundary.
2. **Client resilience.** Every request has bounded acquisition, connection/header, stall, attempt, and operation time. Retry, `Retry-After`, redirect validation, bounded bodies, PDF validation, and a shared circuit breaker are explicit.
3. **Domain and cache.** Modern and legacy arXiv IDs retain base/version identity. Strict Atom parsing rejects API-error documents and unsafe XML. Query and exact-ID metadata caches have a 24-hour freshness window, stale-read policy, and bounded eviction.
4. **Durable library.** Atomic renames determine membership; an append-only index records metadata and history. Startup reconciliation repairs interrupted event appends, repair preserves corrupt evidence, and remove/restore is a reversible trash flow.
5. **CLI and rendering.** Human and JSON output share the same limits and typed exit contract. Cached search results receive a current filesystem membership overlay. Exact and base IDs follow the documented resolution rules.
6. **Agent delivery.** The package exposes the `arxiv` executable, the installer builds and links it, and a 67-line bundled skill teaches abstract-first triage, one-at-a-time download, bounded page reading, and exit-code recovery.

## Engineering-lens record

The engineering-lenses router selected the following failure-mode skills because their real-world referents occur in this program:

- **Security:** untrusted IDs, XML, redirects, response bodies, and filenames cross into parsers, sockets, and filesystem paths. The implementation uses strict ID grammar, destination containment, nested-symlink refusal, DTD rejection, redirect allowlisting, terminal-control sanitization, and PDF content validation.
- **Durability:** PDFs and their metadata must survive interruption without claiming an uncommitted state. Membership is committed by atomic rename; the index is derived and reconciled; partial files, torn tails, compaction, trash, and corrupt-index recovery have explicit policies.
- **Concurrency:** multiple processes share one scarce upstream connection. SQLite transaction ownership, a single gate scope independent of library root, socket-close containment, constant-size coordinator state, and process-death tests establish the boundary.
- **Resilience:** arXiv and the network can be slow, malformed, rate-limited, or absent. Layered deadlines, abort-driven teardown, bounded retry, shared breaker state, stale reads, and visible diagnostics keep failure bounded.
- **Distributed data:** cache metadata, filesystem membership, the JSONL index, pacing time, and breaker observations are separate stores. Filesystem membership is authoritative; cache identity is canonicalized; exact-version identity prevents stale local copies from satisfying latest-version requests.
- **Data modeling and design by contract:** base IDs, exact IDs, cache state, metadata completeness, library membership, and error kinds are represented as explicit categories. Command preconditions, result bounds, and exit codes are enforced at boundaries rather than left as caller conventions.
- **Interaction and error:** refusals include corrective commands, ambiguity prints exact alternatives, remove is reversible, stderr is kept separate from payload, and neither human nor JSON output silently truncates.
- **Unit testing and API evolution:** side effects have injectable seams, pure parsers/builders are tested directly, process and loopback integration tests cover boundary behavior, and JSON schema version 1 is additive with unknown-enum tolerance.

These lenses changed the plan and implementation materially: exact cold downloads avoid an unnecessary metadata request while recording incomplete metadata; explicit `get` upgrades that record; corrupt breaker state fails closed; cache and trash sweeps tolerate races; a transport error retains the first causal failure through teardown; and text extraction decodes only requested pages.

## Verification evidence

The final source state passed:

- `npm run typecheck`
- `npm test`: 40 passed, 0 failed
- `sh -n install.sh`; the installer is executable
- `node dist/src/cli.js --help`
- `npm pack --dry-run`
- live arXiv search, immediate cached repeat, base-ID resolution, and exact-version PDF download
- live library listing of a validated 1,472,363-byte, 17-page PDF
- live page-1 extraction as valid JSON with zero stderr bytes
- global `/opt/homebrew/bin/arxiv` launch through its npm symlink, plus all three installed skill links
- SCIP configuration validation, repository health checks, dependency/consumer inspection, cycle checks, unused-parameter checks, and similarity checks

The tests include real child-process contention and SIGKILL behavior, local HTTP/TLS fixtures, response lifecycle ordering, TLS session reuse, retry and redirect refusal, body limits, PDF rejection, ID/path safety, cache bounds, reconciliation, repair, version ambiguity, output limits, and CLI recovery.

## Deviations and verification limits

- The initial implementation is committed at `ddc28de`. History-dependent checks have only that initial baseline and therefore cannot yet infer meaningful co-change patterns.
- SCIP's pre-initial-commit `diff-gate` failed closed because an unborn branch has no `HEAD`. After the initial commit established a baseline, the gate ran successfully and the installed-entry-point fix introduced no findings.
- Six wrapper candidates were retained as deliberate domain, durability, or transport boundaries; six single-consumer types were retained as named cross-layer contracts. The detector found no passthrough candidates, redundant re-exports, cycles, reachable stubs, unused trailing parameters, or test-quality findings.
- The plan's external agent acceptance harness intentionally lives outside the repository and outside the implementing agent's write access. It was not available here. This is an independent product-acceptance gate, not unfinished repository implementation.
- Multi-host coordination, unrelated arXiv clients, other operating-system users, Windows, NFS, and SMB remain explicitly outside version 1.

## Deferred external checks

1. Run the tamper-resistant external agent prompt matrix and grade transcript, request, download, and page-read budgets.
2. Establish an external coordinator before operating concurrently from more than one host.

## Completion verdict

**IMPLEMENTED — the repository product described by the plan is built, installed, and locally verified.** Remaining items require an independent grader or a version-2 scope expansion.
