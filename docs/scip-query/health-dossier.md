# scip-query Health Dossier

Project: .
Setup verdict: partial
Health score: 100 (risk 100, hygiene 100)

## Items That Need Attention

- Stale abstractions: 2 single-consumer (not in types file) — review public, runtime-registration, and ownership evidence before removing, moving, or inlining (2; impact medium, effort low, evidence heuristic; confirmation unconfirmed; safe to start no). Run scip-audit to confirm this signal; use scip-improve when the user wants confirmed issues fixed autonomously.

## Blocked Or Unavailable Checks

- UNAVAILABLE `scip-query status --json`: Rust was not detected.

## Setup Smoke Tests

- PASS `scip-query reindex`: typescript indexed from cache.
- PASS `scip-query status`: Index freshness is fresh: Index metadata fingerprint matches current source files.
- PASS `scip-query config-validate`: Config OK.
- PASS `scip-query capabilities`: 1 language capability row(s) available.
- PASS `scip-query capability-matrix --json`: 1 language row(s), 0 with unavailable capability cells.
- PASS `scip-query health`: Health score 100.
- PASS `scip-query diff-impact --json`: Git is available and index freshness is fresh: Index metadata fingerprint matches current source files. Last refresh: reused by setup at 2026-07-29T17:24:09.918Z.
- PASS `scip-query diff-gate --json`: Git is available and index freshness is fresh: Index metadata fingerprint matches current source files. Last refresh: reused by setup at 2026-07-29T17:24:09.918Z.
- PASS `scip-query cleanup-plan --verify`: 1 available, 0 partial, 0 unavailable cleanup-verification row(s).
- PASS `scip-query setup-hooks`: 0 installed, 0 updated, 2 already configured.
- PASS `scip-query status --json`: reused pid 57060; clean-idle exit scheduled for 2026-07-29T17:33:44.755Z.
- UNAVAILABLE `scip-query status --json`: Rust was not detected.
- PASS `scip-query setup-agent`: 0 written, 2 already wired, 0 skipped.

## Setup Steps

- OK Automatic indexing config: Demand-started automatic incremental indexing is already enabled.
- OK scip CLI: scip CLI is available.
- OK Agent skills: 0 installed, 27 already linked, 0 pruned, 0 skipped.
- OK Project config: Config OK.
- OK Indexer readiness: Detected languages: typescript
- SKIPPED AST parser packages: Skipped because installing missing parser packages requires explicit consent.
- SKIPPED Indexer remediation: Skipped because installing missing indexers requires explicit consent.
- OK Index refresh: Reused typescript in 0.1s.
- OK Automatic indexing service: reused pid 57060; clean-idle exit scheduled for 2026-07-29T17:33:44.755Z.
- OK Capability matrix: 1/1 language(s) have available indexing.
- OK Health audit: Health score 100. 1 prioritized action(s).
- SKIPPED Rust semantic session: Skipped because Rust was not detected.
- OK Project agent hooks: 0 installed, 0 updated, 2 already configured, 0 hook config(s) cleaned up, 0 skipped.
- OK Project agent guidance: 0 written, 2 already wired, 0 skipped.
- WARN Setup smoke tests: 12 passed, 1 unavailable, 0 failed.

## Indexer Remediation

All detected indexers were already runnable.

## JSON

Machine-readable report: `docs/scip-query/health-dossier.json`
