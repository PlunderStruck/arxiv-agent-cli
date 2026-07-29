# Coordinator and HTTP foundation certificate — 2026-07-29

## Goal

Implement and prove the two mechanisms that carry the greatest correctness risk before building the CLI around them:

1. a SQLite mutex that serializes cooperating processes and releases ownership when a process dies; and
2. an HTTPS transport that does not return until its response is settled and its assigned socket is closed.

This slice is complete when both mechanisms have direct test seams, their composition keeps the mutex held through socket close, and concurrency and process-death tests pass.

## Definitions and invariants

A **SQLite mutex** is a cross-process exclusion mechanism whose ownership is the write transaction created by `BEGIN IMMEDIATE`; because the operating system owns the database file lock, closing or killing the owning process releases it without application cleanup.
Source: [PLAN.md](../../PLAN.md#rate-limiting--one-crash-released-gate-two-guarantees)

A **wire request** is one HTTP exchange from transport setup through response settlement and socket close; redirects and retries are later exchanges rather than hidden continuations of the same one.
Source: [PLAN.md](../../PLAN.md#rate-limiting--one-crash-released-gate-two-guarantees)

A **transport boundary** is the program edge that owns a network socket; it differs from higher-level request logic because it can observe and await the socket's actual `close` event.
Source: [PLAN.md](../../PLAN.md#http-resilience)

- **I1 — mutual exclusion:** at most one cooperating process may own a given SQLite mutex.
- **I2 — crash release:** if the owner exits for any reason, a waiter must eventually acquire without lease expiry, PID inspection, or lock stealing.
- **I3 — containment:** a mutex-wrapped wire request must always retain ownership until the assigned socket emits `close`.
- **I4 — bounded acquisition:** a waiter must either acquire before its deadline or return a typed timeout error.
- **I5 — constant coordinator state:** mutex use must never create an application table, index, ownership row, or history whose work grows with use.

## Premises

- **P1.** The repository initially contains `PLAN.md` and no implementation or consumers.
  Source: `rg --files -g '!node_modules' -g '!.git'`
- **P2.** The available runtime is Node 26.5.0 and exposes `node:sqlite.DatabaseSync`.
  Source: `node -p "process.version"` and `node -p "typeof require('node:sqlite').DatabaseSync"`
- **P3.** The product plan assigns cross-process ownership to an empty SQLite database held with `BEGIN IMMEDIATE`, with a 250 ms busy timeout and a bounded outer retry loop.
  Source: [PLAN.md](../../PLAN.md#rate-limiting--one-crash-released-gate-two-guarantees)
- **P4.** The product plan requires `node:https`, disabled socket keep-alive, `Connection: close`, and waiting for the assigned socket's `close` event before releasing the mutex.
  Source: [PLAN.md](../../PLAN.md#rate-limiting--one-crash-released-gate-two-guarantees)
- **P5.** The product plan requires concurrent-process, SIGKILL, timeout, and transport-lifecycle verification.
  Source: [PLAN.md](../../PLAN.md#verification)
- **P6.** SCIP graph evidence is unavailable until source files, TypeScript configuration, and Git worktree identity exist.
  Source: `scip-query status --capabilities`

### State-authority premise

- **P7.** In this slice, SQLite itself is the only writer and reader of mutex ownership. Application code may begin, commit, or roll back the transaction, but it may not represent ownership in a row or another file. Because no implementation exists yet, this consumer set is complete for the slice and must be re-established with SCIP after sources are indexed.
  Source: P1, P3, and [PLAN.md](../../PLAN.md#rate-limiting--one-crash-released-gate-two-guarantees)

### Explicit assumptions to prove

- **A1.** `BEGIN IMMEDIATE` on a schema-free file contends across separate Node processes.
- **A2.** Killing the transaction owner releases the SQLite file lock.
- **A3.** A non-keep-alive `node:https` request exposes a socket `close` event that can be awaited after success and abort.

## Current state

There is no executable flow or affected consumer set beyond the intended boundaries in PLAN.md (P1). The first implementation therefore creates the testable side-effect boundaries before any CLI command can depend on them.

## Reuse audit

- `src/coordinator.ts` uses `DatabaseSync` directly rather than inventing a PID file, lease, heartbeat, or ownership table. No existing helper can be extended because the repository has no code (P1, P3).
- `src/http/transport.ts` uses `node:https.ClientRequest` directly because the higher-level `fetch` interface does not expose the assigned socket lifecycle required by I3 (P4).
- `withSqliteMutex()` composes existing mutex acquisition and release; it is not a second locking implementation.
- Tests inject time, random jitter, and the request function at the side-effect boundary. Production defaults remain the Node clock, random source, and `node:https.request`.

## Testability design

- **Mutex seam:** `SqliteMutex.acquire()` returns a single-use handle with `commit()` and `rollback()`.
- **Composition seam:** `withSqliteMutex()` proves release ordering for asynchronous work.
- **Transport seam:** `NodeHttpTransport.request()` accepts a response consumer and returns only after the socket closes.
- **Injected dependencies:** monotonic time, sleep, jitter, request function, and Agent.
- **Pure core:** deadline arithmetic and retry-delay selection.
- **Side-effect shells:** `DatabaseSync`, process lifecycle, files, sockets, and timers.

## Design phases

### 1. Package scaffold

- **Deployable:** No — foundation group.
- **What:** No TypeScript package exists (P1).
- **Change:** Add package metadata, strict TypeScript configuration, source folders, and Node test runner wiring.
- **Validation:** `npm run build`.

### 2. SQLite mutex

- **Deployable:** No — foundation group.
- **What:** Mutex behavior exists only as a plan contract (P3).
- **Change:** Add a schema-free `DatabaseSync` wrapper with `{timeout:250}`, bounded retry of `BEGIN IMMEDIATE`, typed timeout errors, idempotent release, and `withSqliteMutex()`.
- **Contract:** Acquisition returns ownership or a typed deadline error; release commits on success and rolls back on failure.
- **Validation:** same-process contention, cross-process contention, deadline, and SIGKILL tests.

### 3. Close-observable HTTP transport

- **Deployable:** No — foundation group.
- **What:** Transport behavior exists only as a plan contract (P4).
- **Change:** Add a one-wire-request transport using a process-lifetime non-keep-alive Agent, forced `Connection: close`, AbortSignal support, bounded streaming through a caller consumer, and socket-close awaiting.
- **Contract:** Success returns the consumer value only after socket close; failures destroy the request and also await close when a socket was assigned.
- **Validation:** loopback success and abort tests record response completion, socket close, and promise settlement order.

### 4. Composition proof

- **Deployable:** Independently verifiable but not a complete CLI.
- **What:** I3 crosses the mutex and transport boundaries.
- **Change:** Run the transport inside `withSqliteMutex()` while another process waits.
- **Validation:** prove the waiter cannot acquire before the first request's socket closes.

## Attack record

- **AT1 — concurrency / I1.** Two processes call `BEGIN IMMEDIATE` on the same schema-free database.
  **Outcome:** HOLE — repaired by phase 2 cross-process contention test proving only one owner.
- **AT2 — crash / I2.** The owner is killed without rollback while a second process waits.
  **Outcome:** HOLE — repaired by phase 2 SIGKILL test proving operating-system release.
- **AT3 — deadline / I4.** The owner survives beyond the waiter's deadline.
  **Outcome:** HOLE — repaired by phase 2 bounded-wait test and typed timeout.
- **AT4 — success ordering / I3.** The response consumer finishes while the TCP socket remains open.
  **Outcome:** HOLE — repaired by phase 3 awaiting the socket's `close` event before resolving.
- **AT5 — abort ordering / I3.** Abort rejects application work but leaves the request socket alive.
  **Outcome:** HOLE — repaired by phase 3 destroying the request and awaiting socket close.
- **AT6 — pooling / I3.** A process retains an idle socket after releasing the mutex while another process connects.
  **Outcome:** HOLE — repaired by phase 3 disabling keep-alive, forcing `Connection: close`, and testing distinct socket lifetimes.
- **AT7 — growing SQL / I5.** An ownership row or event history is introduced and acquisition cost grows over time.
  **Outcome:** HELD by phase 2 and P7: the SQL surface is transaction control only, verified by an empty-schema assertion.
- **AT8 — composition / I3.** Mutex code and transport code pass independently but their caller releases between response completion and socket close.
  **Outcome:** HOLE — repaired by phase 4 composition test.

### Coverage matrix

| Surface or lens | Attack |
|---|---|
| SQLite ownership writer/reader | AT1, AT2, AT3, AT7 |
| HTTP socket owner | AT4, AT5, AT6 |
| Boundary composition | AT8 |
| Reversibility | AT2 |
| Observability | AT3, AT4, AT5 |
| Testability | AT1–AT8 |
| Human experience | AT3 typed timeout; broader CLI messages remain outside this slice |
| Efficiency | AT6; TLS session reuse remains in the process-lifetime Agent |

## Execution and ship order

Execute phases 1–4 in order. The foundation is not shipped as a user-facing CLI, but every phase must compile and phase 4 must pass before search, download, redirects, retry, pacing, or caching is built on it. There is no persistent-data migration and no one-way rollout in this slice.

## Verdict

A plan is **PLANNED-COMPLETE** when every attack has a cited defense or recorded accepted hole, the coverage matrix has no blank row, and no premise failed reverification.

**Result: PLANNED-COMPLETE — 8 attacks, 7 holes repaired by planned tests, 0 accepted holes, 1 invariant held structurally.**

## Files

- Create: `package.json`, `tsconfig.json`, `src/coordinator.ts`, `src/http/transport.ts`, `test/*.test.ts`, `test/fixtures/*.ts`
- Verify: `PLAN.md`, this certificate, build output, test output, SCIP status after sources exist
- Delete: none
