# arxiv-agent-cli

## Implementation status

Version 0.1.0 is implemented. All six command families, the shared network coordinator, resilient arXiv client, bounded cache, crash-reconciled PDF library, output renderers, installer, and bundled agent skill are present and build successfully. The completion evidence, engineering-lens decisions, known verification limits, and deferred external checks are recorded in [the implementation certificate](docs/plans/2026-07-29-complete-cli-implementation.md).

## Context

A coding agent asked to "find me papers on speculative decoding" currently has two bad options: scrape arxiv.org through a browser tool, or dump a raw API response into its context. Both are wasteful, and neither remembers anything — the same paper gets fetched again in the next session because nothing on disk says it was already here.

This builds `arxiv`, a small TypeScript CLI whose primary user is an autonomous agent, plus a bundled skill that teaches the agent to drive it well. Three outcomes:

1. **Search that doesn't nuke the context window.** Bounded by default, widened only on purpose, and never silently truncated.
2. **A local library that actually caches.** Downloaded papers are recorded, so a later search in a different session marks them `in library` and costs arXiv nothing.
3. **Rate-limit compliance that survives local concurrency.** arXiv's Terms of Use permit *one request every three seconds, one connection at a time*, counted across all machines under the operator's control. This CLI enforces that across every invocation by one OS user on one host. Multi-host coordination is outside scope; the install and README must say not to run it concurrently on multiple hosts unless an external coordinator serializes them.

Repo is empty. Everything below is greenfield.

---

## What the arXiv API actually does

Verified live against the API, not just read from the docs:

| Fact | Consequence for the design |
|---|---|
| `https://export.arxiv.org/api/query` works over HTTPS/2 | Use the canonical HTTPS URL directly. This is a server capability, not the chosen client protocol; the deliberately serialized HTTP/1.1 client gets no multiplexing benefit from HTTP/2 |
| Bare terms produced roughly 197,000 results; AND-joining the terms reduced that to hundreds while preserving the leading results. Counts change as the corpus grows (the implemented query returned 709 on 2026-07-29). | AND-join terms by default, so the printed total is an honest signal to narrow or widen |
| Errors come back as an Atom feed with `<title>Error</title>` and `<id>…/api/errors#…`, sometimes under HTTP 200 | Parse the document *then* decide status; never trust the status line |
| `/pdf/<id>` for a nonexistent paper returns **404 with `text/html`**, and under load can return HTML with **status 200** | Validate content-type + `%PDF-` magic bytes + length before the file is allowed to exist |
| `<id>` always carries a version (`…/abs/2401.12345v3`) | The latest version number is free on every search — so a stale local copy can always be detected |
| Legacy IDs contain a slash: `math.GT/0309136` | ID sanitization is a path-traversal boundary that cannot simply reject `/` |
| Docs: *"no need to call the API more than once in a day for the same query. Please cache your results."* | 24h query cache is the sanctioned behaviour, not a shortcut |

---

## Stack

Node ≥ 24.15 (26.5.0 present), TypeScript → `dist/` via `tsc`, ESM. The minimum is set by the release-candidate `node:sqlite` API used only as a crash-released cross-process mutex; no application data lives in SQLite. Version 1 supports macOS and Linux, matching the symlink-based agent installations and per-user UID coordinator; Windows is outside scope rather than partially supported.

**Two runtime dependencies, both zero-transitive:**

- `@rgrove/parse-xml` — 380 KB, strict, correct entity handling. (`fast-xml-parser` was rejected: 6 transitive deps, 1.2 MB.)
- `unpdf` — 2.1 MB, zero deps, bundles pdf.js. `extractText(pdf, {mergePages:false})` returns `string[]` per page plus `totalPages` — exactly what `--pages` and the page-count feedforward need.

Everything else is Node built-ins: `node:https`, `node:util` `parseArgs` (no commander), `node:test` (no vitest/jest), `node:crypto`, `node:sqlite`.

Dev deps: `typescript`, `@types/node`. That's it.

---

## Commands

Six verbs. Nothing speculative.

```
arxiv search <query>          [--limit --offset --titles-only --full --json
                               --category --author --title --since --until
                               --sort relevance|submitted|updated --no-cache --no-stale]
arxiv get <id>                [--json --no-stale] full abstract + metadata
arxiv download <id>...                            max 3 per invocation
arxiv text <id> --pages a-b   [--json]           mandatory page range, no whole-doc form
arxiv library list            [--limit --offset --titles-only --json]
arxiv library remove <id> | restore <id> | repair
```

**ID resolution is part of the command contract, not caller folklore.** An exact ID includes `vN`; a base ID omits it.

- `get` and `download` with an exact ID address that immutable version.
- `get` and `download` with a base ID resolve the latest version from an unexpired search/ID cache, or from the API when no fresh resolution exists. Holding an older local version never silently satisfies a request for the base ID.
- Expired metadata may answer read-only `search`/`get` during upstream failure when visibly marked stale. It never resolves a mutating base-ID `download`; that command exits 4 and may suggest an exact stale version the caller can choose deliberately.
- `text` and `library remove` with a base ID succeed only when exactly one live local version matches. `library restore` succeeds only when exactly one trashed version matches.
- When multiple local versions make a base ID ambiguous, exit 2 and print the exact versioned commands. Never select "highest" or "most recent" implicitly.
- Every human and JSON result names the resolved exact version and whether its metadata was fresh, cached, or stale.
- `get` has a 20,000-character rendered-output ceiling in human and JSON modes. Oversized summaries or lists are cut with per-field total/shown counts and `truncatedFields`; "full" means unabridged within that safety ceiling, never unbounded.
- `library list` defaults to 20 records, caps `--limit` at 50 in every output mode, reports `shown of total`, and prints the next absolute offset. It never prints abstracts; `get` is the widening command. The local library is not an excuse for an unbounded context dump.

Deliberately **not** built: `prune`, interactive TUI, BibTeX export, full-text search across the library, author entities. Query-cache eviction happens automatically on write and needs no command.

---

## The output budget

The critical failure this design exists to prevent: an agent runs one search and burns 20k tokens on 50 abstracts.

**Default `search`** — 10 results, abstract truncated to 180 chars at a word boundary, ~90 tokens each:

```
$ arxiv search "speculative decoding"

2302.01318v1 · 2023-02 · cs.CL
  Accelerating Large Language Model Decoding with Speculative Sampling
  Chen, Borgeaud, Irving +5
  We present speculative sampling, an algorithm for accelerating transformer
  decoding by enabling the generation of multiple tokens... [1204 chars, 180 shown]

2211.17192v2 · 2022-11 · cs.LG · in library
  Fast Inference from Transformers via Speculative Decoding
  Leviathan, Kalman, Matias
  Inference from large autoregressive models such as Transformers is slow —
  decoding K tokens takes K serial runs... [1466 chars, 178 shown]
  ~/.arxiv/papers/2211.17192v2-fast-inference-from-transformers.pdf · 12 pages

10 of 147 · relevance · ↻ cached 3h ago
  more:       arxiv search "speculative decoding" --offset 10
  cheap scan: arxiv search "speculative decoding" --limit 40 --titles-only
  abstract:   arxiv get 2302.01318
```

Rules that make this hold:

- **Never silently truncate.** Every cut states its own size (`[1204 chars, 180 shown]`, `10 of 147`) and names the command that widens it.
- **Handles are IDs, never ordinals.** A positional `1)` means something different after every search; an agent will reuse a stale index across turns.
- **`--offset`, not `--page`.** Absolute and directly printable in the footer. Page numbers are a mode.
- **`--titles-only`** (~15 tok/result) is the real widening mechanism: buy breadth by spending depth, not budget.
- **`--full`** has its own cap of **5**, not `--limit`'s 50. Twenty full abstracts is the exact failure mode.
- **`--json` obeys identical caps.** A JSON escape hatch would make the whole design decorative.
- **Footer appears once, max 3 next-commands**, and only lists branches that are live (no `--offset` when 10 of 10 are shown).
- **Refuse over the cap; don't warn.** A warning above 200 abstracts has already spent the context it warned about.

```
$ arxiv search "attention" --limit 200
arxiv: refused — 200 results with abstracts is ~18k tokens (cap 50).
  for breadth at ~3k tokens:
    arxiv search "attention" --limit 50 --titles-only
exit 2
```

**Sensibility checks on the result, not the request.** These catch a wrong *strategy*, which no cap can:

```
0 results.
  arXiv matches literal terms, not questions. 12 of your 13 words are non-technical.
  try: arxiv search "LLM inference acceleration" --titles-only --limit 20

10 of 41,882 · relevance
  query is under-constrained (spans cs.LG, cs.CL, stat.ML, eess.IV).
  narrow: arxiv search "attention" --category cs.CL --since 2023
```

**`arxiv text` cannot dump a whole paper.** `--pages` is mandatory and may span at most **5 pages**. Human and JSON output share a **30,000-character ceiling**. Any cut states total and shown characters and prints a command for a narrower range. The 40-page cat is made unexpressible rather than confirmable.

**`download` caps at 3 IDs per invocation.** This is a per-command safety boundary: it prevents an accidental 20-ID bulk command, but it is not represented as a per-research-task quota because the CLI has no trustworthy task identity. The skill tells the agent to download one at a time, and the external agent acceptance harness measures the total across the whole task. A true task-global quota would require a session concept and is deliberately outside this version.

---

## Rate limiting — one crash-released gate, two guarantees

A **wire request** is one actual HTTP request/response exchange with arXiv, from transport setup through response settlement and transport close; following a redirect creates another wire request even when both exchanges serve one CLI command. "Single connection" is mutual exclusion: at most one arXiv transport exists among cooperating processes. "1 req / 3s" is pacing: consecutive wire-request starts are separated. The **network gate** is the per-user, per-host coordination mechanism whose defining job is to guarantee both for every initial request, retry, and redirect hop. It is independent of `ARXIV_LIBRARY`; two invocations using different libraries still share it.

Coordinator root:

```
<os.tmpdir()>/arxiv-agent-cli-<uid>/
  network.sqlite             SQLite locking only; no application records
  last-request-start         fsynced monotonic + wall-clock observation
  breaker.json               shared breaker state
  library-<sha256(realpath)>.sqlite   one short-held mutex per library
```

The directory is created mode `0700`. A reboot may remove it, which is safe because no request from the prior boot remains alive. Network filesystems are unsupported for coordinator state.

`src/throttle.ts`:

- **Acquire with `BEGIN IMMEDIATE` on `network.sqlite`.** SQLite's operating-system file lock is the ownership primitive. The transaction remains open across one complete wire request; process death releases it without leases, heartbeats, stale judgment, stealing, or PID-reuse logic.
- **Bounded, visible acquisition.** Open `DatabaseSync` with `{timeout:250}` and retry `BEGIN IMMEDIATE` with small jitter until the 30 s acquisition deadline. Announce the wait on stderr after the first busy result. Failure by the deadline exits 5 and prints the exact retry command; no synchronous call hides a 30 s stall.
- **Pace while holding the transaction.** Read `last-request-start`, whose primary value is `process.hrtime.bigint()` and whose wall time exists only for diagnostics. The monotonic clock is host-wide on supported platforms, comparable across CLI processes, and unaffected by wall-clock correction. Sleep the remaining interval; then overwrite and `fsync` both observations immediately before opening the transport. Missing state means no prior request. Malformed state or a saved monotonic value greater than the current value (reboot or corruption) fails closed by waiting the full 3 s.
- **Transport lifetime matches gate ownership.** The production `node:https` adapter uses one process-lifetime `https.Agent` with `keepAlive:false`, `maxSockets:1`, and `maxTotalSockets:1`, and sends `Connection: close`. Fully consume the bounded response, or abort and destroy it, then await the assigned socket's `close` event before committing the SQLite transaction. A timeout does not release ownership by itself. The adapter deliberately keeps no idle arXiv socket after release: a process-local pool cannot prove the one-connection invariant once another process acquires the gate. A persistent cross-process connection owner would require a daemon and is outside version 1.
- **Breaker decisions happen inside the gate.** A cheap pre-check may fail fast before waiting, but every process re-reads breaker state after `BEGIN IMMEDIATE`; failure/success accounting and breaker transitions are written atomically before release. Queued processes therefore observe a breaker opened by the request ahead of them.
- **Release between wire requests.** Redirect selection and retry backoff never hold the network gate. Every redirect hop and retry later reacquires it, re-checks the breaker, and passes through pacing again.
- **Only wire requests take the gate.** Cache hits, `library list`, and `text` never do.
- **`download a b c` is sequential.** No `Promise.all`, no agent with `maxSockets > 1`, anywhere.

SQLite is a lock carrier here: a database file whose only purpose is to let the operating system release ownership when a process dies. The coordinator databases contain no application tables or indexes, and their entire SQL surface is `BEGIN IMMEDIATE` plus `COMMIT` or `ROLLBACK`; the busy timeout is a connection option, not a query. Do not add an ownership row, poll a lock table, or persist request history in SQLite; those designs turn constant work into a growing query path without improving the crash-release guarantee.

The guarantee is intentionally scoped: all invocations of this CLI by one OS user on one host. It cannot coordinate unrelated arXiv clients or another machine. The README states that operators remain responsible for arXiv's aggregate multi-machine limit.

---

## HTTP resilience

- **Count wire requests before bytes.** A cache-miss `search` or exact-ID `get` normally needs one wire request; an exact-ID `download` normally needs one PDF request; a cold base-ID `download` needs one metadata-resolution request followed by one PDF request. Fresh caches remove the resolution request. Canonical URL construction makes redirects exceptional rather than part of the normal path. The service's cross-process one-connection rule deliberately outweighs the usual keep-alive optimization; eliminating a request removes a mandatory pacing interval as well as its DNS, TCP, TLS, and response round trips.
- **Resume TLS without retaining sockets.** TLS session resumption is a reconnect mechanism that reuses previously negotiated cryptographic state to shorten a new encrypted handshake without keeping the old connection open. Retain the process-lifetime agent's default session cache while disabling socket keep-alive. This recovers part of connection reuse's latency benefit without letting an idle transport escape the network gate.
- **Three timeout layers, one operation deadline.** A logical attempt is one try to complete the requested arXiv operation and may contain separately gated redirect wire requests. Each wire request has a 10 s connect+headers timeout and a 20 s per-chunk stall timeout, reset on every chunk; each logical attempt caps at 30 s for queries and 10 min for PDFs. The overall command deadline is 90 s for queries and 20 min for a PDF, including every wire request, redirect, lock wait, backoff and attempt; every nested wait consumes the remaining deadline rather than starting a fresh budget.
- **Timeout means abort, not merely reject a promise.** Every timer drives the wire request's `AbortController`; response readers are drained or destroyed, timers are cleared in `finally`, and the network gate is held until the assigned socket has closed. A bare `Promise.race` is forbidden because it leaves the losing request alive.
- **Retries route through the same network gate**, so they cannot violate the 3 s rule by construction. Max 3 logical attempts, backoff `max(3s, 2ⁿ·1s) + jitter`, honour `Retry-After` (both forms), and take `max(Retry-After, throttle remainder)` without exceeding the overall deadline. Backoff happens outside the gate.
- **Retry only** connect errors, timeouts, 408, 429, 5xx. Never other 4xx — a malformed-query 400 is deterministic and retrying it burns the user's shared budget.
- **Persist the circuit breaker in the coordinator root** (`breaker.json`: consecutive retryable attempt failures + `openUntil`). Three consecutive failures open it for 60 s; a `Retry-After` later than that becomes the open deadline. Afterward, the first process through the network gate is the sole half-open trial. Success resets the count and closes; failure reopens for 60 s. In-memory is worthless in a short-lived process. State is read and changed under the gate; writes use tmp→fsync→rename. Business 4xx responses never count. Every transition is explicit and logged.
- **Bound Atom before parsing.** Refuse a query response over 5 MiB while streaming, prohibit DTDs and external entities, require the document to end `</feed>`, then parse and decide whether it is data or an Atom error. A truncated or hostile feed is never cached.
- **An Atom error must not collapse into "0 results."** An agent reading "no results" concludes the paper doesn't exist and stops; it must see an error and retry. Different exit codes, and errors are never cached.
- **Redirects are manual, exceptional, and gated before every hop.** Follow at most 5 within the logical attempt and overall deadline. Each destination must use HTTPS, have no credentials, use the default port, and have a hostname equal to `arxiv.org` or ending in `.arxiv.org`. Release and reacquire the network gate before the next hop so its start is also three seconds after the preceding request start. Checking only the final host is too late because the intervening request already happened.
- **The production origin is not configurable.** `cli.ts` receives a client dependency, and the shipped adapter hardcodes the arXiv origin and redirect policy. A test-only fixture entrypoint injects the loopback recording server. There is no `ARXIV_BASE_URL` escape hatch that turns a test seam into server-side request forgery.
- **PDF validation is all-or-nothing:** refuse over 100 MiB while streaming; require `Content-Type` whose normalized media type is `application/pdf`; require leading `%PDF-`; and, when `Content-Length` exists, require the completed byte count to match it. Missing `Content-Length` is allowed. No rename, index event, or `in library` marker exists unless the stream completed and validated.
- **Descriptive `User-Agent`** (`arxiv-agent-cli/<version> (+repo-url)`). arXiv 403s generic agents, and a 403 misread as "not found" is another silent-wrong-answer path.
- **Serve stale only for read-only answers.** Breaker open + an expired cache entry for `search`/`get` → return it, `stale: true` on stdout, note on stderr, exit 0. `--no-stale` opts out. Stale metadata never silently resolves a base-ID `download`, because that would turn an uncertain answer into a local mutation.
- **Fail fast on local state.** Resolve `ARXIV_LIBRARY`, `mkdir -p`, check writability *before* the network call. Discovering the directory is read-only after a 12 MB download is the operability anti-pattern verbatim.

---

## Storage

Library root `~/.arxiv/` (`ARXIV_LIBRARY` overrides):

```
papers/          2211.17192v2-fast-inference-from-transformers.pdf
papers/.tmp/     <id>.<pid>.<rand>.part      — same filesystem, or rename hits EXDEV
index.jsonl      append-only event log
cache/queries/   <sha256-of-normalized-url>.json   — 24h TTL + LRU sweep on write
trash/           soft-deleted PDFs, 7d
```

Version 1 requires the library root to be on one host's local filesystem. The correctness arguments depend on local atomic rename and do not claim NFS/SMB semantics; README documents network-mounted libraries as unsupported.

Coordination files are deliberately outside the library root, in the fixed per-user runtime directory described above. `ARXIV_LIBRARY` therefore cannot create a second network gate. A library mutex is keyed by the SHA-256 of the library root's canonical `realpath`, so path aliases converge on the same mutex.

**Identity: the unversioned base ID is the primary key.** A paper is really three things — the work (`2211.17192`), a version (`v2`, whose content is frozen forever), and a file on disk (deletable). A flat record with a `version` field collapses them, and then `in library` starts lying the day v2 lands: the search row shows v3, the marker says cached, the agent believes it holds v3.

- `id` verbatim, case preserved (`math.GT` is arXiv's own casing).
- `slug` = `id.replace('/', '_')` — **provably collision-free**, since arXiv IDs draw only from `[a-z-]`, digits, `.` and `/`, so `_` never appears in a real ID.
- Filename = `${slug}v${version}-${titleSlug}.pdf`, **stored in the record, not recomputed** — macOS is case-insensitive, so a scheme change would otherwise orphan every file. The title slug makes the path self-describing to an agent that lost its search output.
- Path safety: whitelist-validate against both ID grammars, encode, then `path.resolve` and assert the result is still inside `papers/`. `arxiv download ../../../.ssh/authorized_keys` fails at validation.

**`index.jsonl`, append-only.** One self-describing line per event, at most 256 KiB, written with a single `writeSync` to an `'a'` handle while holding the per-library SQLite mutex. The same mutex covers compaction and filesystem membership changes. `O_APPEND` is useful, but it is not treated as the concurrency proof. This eliminates interleaved events, append-during-compaction loss, whole-file lost updates, and silent loss of fields unknown to an older reader.

```jsonc
{"v":1,"op":"add","id":"2211.17192","version":2,
 "file":"papers/2211.17192v2-fast-inference-from-transformers.pdf",
 "bytes":1234567,"sha256":"…","pages":12,
 "title":"…","authors":[{"name":"…","affiliation":null}],
 "primaryCategory":"cs.LG","categories":["cs.LG","cs.CL"],
 "publishedAt":"…","updatedAt":"…","summary":"…",
 "doi":null,"journalRef":null,"comment":null,
 "metadataFetchedAt":"…","metadataState":"complete","addedAt":"…"}
{"v":1,"op":"rm","id":"2211.17192","version":2,"ts":"…"}
{"v":1,"op":"restore","id":"2211.17192","version":2,
 "file":"papers/2211.17192v2-fast-inference-from-transformers.pdf","ts":"…"}
```

Reader parses line by line and folds by `(id, version)` last-wins; `rm` tombstones and `restore` reactivates the most recent prior metadata. One malformed **unterminated final line** is a recoverable torn tail and is ignored with a debug event. A malformed complete/non-final line or oversized event is local-state error 6 and blocks writes until `library repair` succeeds. A newer-than-known `v` also exits 6, but repair must refuse to rewrite it and instruct the user to upgrade—the older CLI cannot prove which facts it would destroy. Compaction at >5k lines takes the same library mutex as appenders and uses tmp→fsync→rename→fsync(dir).

Names are kept apart because four different clocks are in play: `publishedAt` (arXiv v1), `updatedAt` (arXiv, this version), `addedAt` (ours), `metadataFetchedAt` (staleness marker). Never a bare `updated`.

**`in library` means "I hold at least one version," never "I hold the one shown."** The latest version is free on every search response, so the discrepancy is computed and surfaced rather than hidden:

```
2211.17192v3 · 2022-11 · cs.LG · in library v2 — v3 available
```
```json
{"id":"2211.17192","latestVersion":3,"cachedVersions":[2],"cacheState":"stale"}
```

**Query cache and library state never become one stored object.** A query-cache entry contains only the validated upstream metadata, paging totals, canonical request and fetch time. On every cache hit, rendering reconciles current filesystem membership and overlays `cachedVersions`, `cacheState`, paths and page counts. Download, remove and restore therefore change the next cached search immediately without another arXiv request. A corrupt cache entry is deleted and treated as a miss; it never becomes a result.

**Filesystem membership is the source of truth; the index is metadata and history.** A source of truth is the representation whose state wins when copies disagree. A version is live exactly when a validated file exists in `papers/`, trashed exactly when it exists in `trash/`, and absent otherwise. The index supplies metadata but cannot override those facts.

Every library open streams directory names and index lines to reconcile `papers/`, `trash/`, and the folded index before reporting membership. Normal opens stat recorded files but do not re-read or re-hash every PDF; expensive integrity work is limited to orphan recovery, a size mismatch, lazy checksum verification, or explicit repair.

- A paper file whose folded index state is absent or inactive is recovered as live from its encoded ID and version. Reuse valid prior metadata when it exists; otherwise recompute local facts (`file`, `bytes`, `sha256`, `pages`), mark unavailable arXiv fields with `metadataState:"incomplete"`, and refresh them through the ordinary throttled client when needed. Reconciliation appends the missing `add` or `restore`.
- An active index record whose paper is missing is tombstoned in memory. If the matching file is in `trash/`, reconciliation appends the missing `rm`; otherwise it reports the lost derived entry and a later download may recreate it.
- A trashed file without a matching tombstone is treated as trashed and receives a repair tombstone.
- A file present in both places, a filename that does not validate, or two files claiming the same `(id, version)` is an ambiguity: exit 6 and require `library repair`; never guess.

Reconciliation itself never performs network I/O. `library list` displays recoverable local fields plus `metadata incomplete`; a later explicit `get` or `download` may refresh missing upstream fields through the normal network gate.

`library repair` runs the same reconciliation without trusting the existing fold, preserves the corrupt index as a timestamped backup, and writes a compacted replacement. It can always restore membership and local integrity fields from files. It does **not** pretend to reconstruct missing authors, abstract, DOI, or upstream timestamps offline; those remain explicitly incomplete until refreshed.

Membership-changing operations are ordered around the filesystem commit point:

| Operation | Before commit | Commit point | Derived event | Crash recovery |
|---|---|---|---|---|
| download | stream and validate `.part` | rename `.part` → `papers/` | append `add` | orphan paper is discovered as live |
| remove | resolve one exact live version | rename `papers/` → `trash/` | append `rm` | trash location wins; missing tombstone is appended |
| restore | resolve one exact trashed version | rename `trash/` → `papers/` | append `restore` | paper location wins; missing restore is appended |

All three hold the per-library mutex from immediately before the commit rename through the event append. A crash may leave the event missing, but it cannot make membership ambiguous, and reconciliation completes the derived side.

**Crash safety, ranked by what it actually buys** (this is a re-downloadable cache, not user data):

- `rename` — **mandatory everywhere.** Without it a SIGKILL leaves a truncated file at the real name and the index calls it `in library` forever. The only failure that is both permanent and silent.
- `fsync(tmp)` before rename — **mandatory for the index**, skipped for PDFs. A 20 MB fsync costs real seconds on the agent's critical path to buy what a checksum buys more cheaply.
- `fsync(dir)` after rename — index only.
- **Checksum on read subsumes the rest.** Verify `bytes` by `stat` before printing `in library`; verify `sha256` lazily. A torn or zero-filled file is detected and re-fetched rather than trusted — which also covers corruption `fsync` never protects against. (Node cannot call `F_FULLFSYNC`, so true power-loss durability is unreachable on macOS anyway. Design for it rather than pretending.)
- Sweep orphaned `.part` files older than a few hours on every `download`, or killed downloads accumulate multi-MB garbage with no removal path.
- Sweep trash older than 7 days on every mutating library command. Cache writes enforce both a 2,000-entry and 256 MiB ceiling, evicting least-recently-used entries until both hold.

---

## Errors and exit codes

stdout carries payload only; stderr carries diagnostics, waits and progress — so an agent never parses a warning as a result. Every error is one line naming what failed plus one line with the corrective command. Never a stack trace, never a usage dump.

| Code | Meaning | Agent's correct next move |
|---|---|---|
| 0 | Success, **including 0 results** | 0 results is a valid observation — rephrase |
| 2 | Usage / validation / refused over cap | Fix the command as printed |
| 3 | Not found upstream, or ID not in library | Check the ID |
| 4 | Upstream unavailable after retries | Back off and retry later |
| 5 | Rate-limited, or lock wait exceeded | Retry the exact printed command |
| 6 | Local state — unwritable, disk full, corrupt or ambiguous library | Stop; run the printed repair/check or involve a human |

Under `--json`, errors are JSON on stdout in the same envelope, plus the nonzero exit. A stack trace on stderr gives an autonomous agent nothing to branch on.

**Slips are catchable and worth catching** — fuzzy-match a bad ID against the cached search results, which converts a dead end into a resumption:

```
arxiv: no such paper 2302.0131 (malformed — arXiv IDs are YYMM.NNNNN)
  did you mean: arxiv get 2302.01318  ("Accelerating LLM Decoding…", in your last search)
exit 3
```

**Waits are announced on stderr before they happen**, one line, never a spinner. Silent compensation is camouflage — a silent 20 s hang looks broken, so the agent kills and re-runs it, adding load and lock contention to a system already contended.

```
arxiv: rate limited by export.arxiv.org, waiting 3s (attempt 1 of 3)
arxiv: waiting on shared API gate (1.4s)
```

`ARXIV_DEBUG=1` emits one line per event on stderr — lock waits, throttle sleeps, breaker transitions, cache hit/miss, redirect chains. Every containment pattern above is otherwise invisible, and near-miss data is lost.

**`library remove`: soft delete, no prompt, no `--force`.** A prompt hard-blocks the primary user, and even for a human it fires on a routine path and decays into a reflex. `--force` as the standard incantation is worse — boilerplate pasted unread, so the guard is gone while looking present. The data is re-downloadable, so undo is both cheaper to build and stronger: it works against slips *and* mistakes, without anyone noticing anything at commit time.

```
removed: 2211.17192v2 "Fast Inference from Transformers via Speculative Decoding"
  trashed (7d): ~/.arxiv/trash/2211.17192v2-fast-inference….pdf
  undo: arxiv library restore 2211.17192v2
```

Feedback names the **title**, not just the ID — otherwise the agent can't tell whether it removed what it meant to.

---

## `--json` is a public API

The skill doc gets copied into other projects and drifts, so `--json` is a contract with clients you cannot force to upgrade.

- **Top level is always an object**, never a bare array — `{"schemaVersion":1,"results":[…],"total":147,"shown":10}`. A bare top-level array is unextendable, and it's the most common irreversible mistake in CLI JSON.
- **Additive only.** Never rename (a rename an agent greps for fails *silently*), never repurpose, never change a type or nullability.
- **`schemaVersion`: one integer, bumped only on a break.** Twenty bytes buys the difference between failing loudly and failing weirdly. Not the package version — that churns for unrelated reasons. `cliVersion` ships separately as informational.
- **Every enum ships with a stated fallback** in the skill doc: *"`cacheState` may gain values; treat unrecognized as unknown."* Without that clause, adding a value is a breaking change.
- Any bounded JSON payload that cuts a field sets `outputTruncated:true` and includes `truncatedFields:[{"field":"…","totalChars":N,"shownChars":M}]`; there is no invisible JSON-only truncation.
- `metadataState` is `"complete" | "incomplete"` in schema v1; clients treat future values as `"unknown"`.
- On-disk: `"v":1` per line. A newer-than-known version → **refuse to write** and say so, rather than helpfully rewriting.

---

## The bundled skill

`skills/arxiv/` in this repo, symlinked to all three agent roots. Model-invoked (the agent must fire it autonomously on "find me papers about X"), so it carries a trigger-rich `description` and pays context load every turn — which means the body earns hard pruning. Target ~60 lines, matching the house style in `~/.claude/skills/` (two-field frontmatter, tables over prose).

Leading word: **triage**. The agent triages search results before spending anything on a download.

Sections, each justified:

1. **What it is / when not to reach for it** (2 lines) — cheapest section in the doc, prevents misapplication.
2. **The default loop as a literal transcript** — search → `get` one abstract → download one → `text --pages 1-3`. Agents imitate transcripts far more reliably than they follow prose rules.
3. **Token cost per command** — the load-bearing section. Hands the agent numbers for its own expected-value calculation instead of "be mindful of context," which is not actionable.
4. **The objective as a state of the world** — *"you can answer the question citing a passage you actually read."* Explicitly **not** "N papers downloaded."
5. **Exit code table** — 6 lines, enables branching instead of blind retry.
6. **Three worked recoveries** — 0 results, rate limit, bad ID. Two lines each.
7. **Anti-patterns, each paired with the cheaper command that replaces it.**

**Cut from the doc:** the full flag reference (that's `--help`, fetched on demand, and duplicating it guarantees drift), install/config instructions (the agent isn't installing it), design rationale, output schemas the agent sees on its first call, and anything the CLI already prints in its footer — a duplicate percept paid every session for information that arrives free exactly when it becomes actionable.

**The 20-PDF trap, named explicitly.** "Search, then download the relevant ones" leaves *relevant* unmeasured while downloading is cheap, visible, and feels like progress — so the agent maximizes the thing it can observe itself doing, and 20 unread PDFs satisfies that perfectly. Not misbehaviour; that is what maximizing the stated measure means. The doc states the outcome, recommends one-at-a-time triage, and the binary prevents one bulk command over 3; the external acceptance harness measures whether the agent bypasses that friction with repeated commands. Do not call a per-invocation cap a task-global control. Read `~/.agents/skills/writing-great-skills/SKILL.md` before authoring — it's the spec for this house style.

`skills/arxiv/agents/openai.yaml` gives Codex the display surface, matching `~/.agents/skills/aydan-voice/agents/openai.yaml`.

---

## Files

```
package.json  tsconfig.json  .gitignore  .scipquery.json  README.md  install.sh
src/
  cli.ts                    parseArgs dispatch, exit-code mapping, top-level error shape
  errors.ts                 typed errors carrying exit code + corrective command
  coordinator.ts            runtime paths + crash-released SQLite mutexes
  throttle.ts               shared network gate + persisted 3s pacing
  arxiv/client.ts           aborting timeouts, deadline, retry, breaker, bounded streams
  arxiv/query.ts            AND-join builder, field prefixes, date ranges, encoding
  arxiv/atom.ts             Atom → typed entries; Atom-error detection
  library/paths.ts          ID validation, slug, filename, traversal assertion
  library/index.ts          guarded append/fold/compact + strict corruption handling
  library/store.ts          atomic membership, reconciliation, repair, trash, sweeps
  cache.ts                  upstream-only query cache: 24h TTL, bounded LRU, stale-serve
  render.ts                 compact/full/titles-only/json + caps + footers + sensibility
  commands/{search,get,download,text,library}.ts
test/*.test.ts
test/fixture-cli.ts           injectable loopback client; never shipped
skills/arxiv/SKILL.md
skills/arxiv/agents/openai.yaml
```

`install.sh`: `npm ci && npm run build && npm link`, then symlink `skills/arxiv` into `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/` (absolute symlinks — the pattern already used for `scip-query` and the `agent-skills` repo). No config edits needed for either client; both discover skills by directory presence. Do **not** touch `~/.agents/.skill-lock.json` — it belongs to the find-skills installer.

---

## scip-query

Ordering matters: `scip-typescript` needs a `tsconfig.json` and real sources, and `scip-query`'s git-history machinery needs a repo.

1. `git init` → `package.json`, `tsconfig.json`, first sources committed.
2. `scip-query setup --json` — installs skills, hooks, parsers, enables demand-started indexing, builds shards, reports health.
3. `.scipquery.json` at root, minimal:
   ```json
   { "$schema": "./node_modules/scip-query/docs/schemas/project-config.schema.json",
     "schemaVersion": 2, "languages": ["typescript"],
     "watch": { "enabled": true, "autoRefresh": true } }
   ```
4. Verify: `scip-query status --capabilities`, `scip-query reindex`, `scip-query doctor`.

Index lives in `~/.cache/scip-query/projects/<hash>/`, outside the repo, so **nothing needs gitignoring for it**. Do not set `projectMode: "workspace"` — that's for real monorepos. Do not run `setup-ci`.

---

## Verification

Ordinary tests prove very little here. These are the ones that do:

**The network-gate proof**

- Spawn 10 concurrent CLI invocations against a local recording server, deliberately alternating two different `ARXIV_LIBRARY` roots. Assert maximum live connections is 1 and every request start is ≥3 s after the previous one.
- In one invocation, make two sequential same-origin requests while a second process waits. Assert both requests carry `Connection: close`; record transport open/close events and prove the first socket closes before gate release and the second socket opens, so no process-local idle pool escapes the cross-process connection limit. Against a TLS fixture, assert the second same-origin handshake reports session reuse even though it uses a new socket.
- Send a two-hop redirect chain under an injected monotonic clock and sleeper. Assert every hop releases and reacquires the network gate, every start is ≥3 s after the preceding start, and the normal canonical query and PDF paths require zero redirects.
- SIGKILL the current holder after its timestamp is fsynced. Assert the next process acquires through SQLite's released OS lock, still waits the remainder of the 3 s interval, and never overlaps the killed attempt.
- Inject forward and backward wall-clock jumps while the monotonic clock advances normally; spacing remains ≥3 s. A persisted monotonic value ahead of the current boot waits a full interval and is replaced.
- Let a server accept and never respond. Assert the timeout aborts and closes that socket before the SQLite transaction releases and before the next request begins.
- Start 10 processes against a failing server. Once the breaker threshold opens, assert queued processes re-check it inside the gate and no additional requests reach the server.
- Run the same tests with a 30 s lock waiter and assert bounded exit 5. No test-only lease, heartbeat or stale-steal path exists.
- Record both coordinator mutexes' constructor options and SQL. Assert `{timeout:250}` plus `BEGIN IMMEDIATE` and `COMMIT` or `ROLLBACK` are the entire acquisition surface; neither database gains an application table, index, ownership row, or history whose cost could grow with use.

**Crash tests**

- SIGKILL mid-download → no `.pdf` appears; the `.part` is swept on the next run.
- Inject a crash immediately before and after each commit rename and event append for download, remove and restore. Reopen the library and assert filesystem membership wins, reconciliation appends the missing derived event, and no version is reported in two states.
- Crash during compaction while another writer waits. Assert the writer proceeds afterward and its event exists in the replacement index.
- Truncate the final event without a newline → reader ignores only that tail and reconciliation restores membership.
- Corrupt a complete middle event → every write refuses with exit 6; `library repair` preserves the old index and recovers a valid replacement.
- Append a newer record version → reads/writes that require folding refuse with exit 6 and say to upgrade; repair and compaction leave the index untouched.
- Delete the index entirely with PDFs present → repair restores membership and local integrity fields, marks upstream metadata incomplete, and does not invent it.

**Fake-server tests** — accepts and never responds · delays headers · dribbles bytes below the stall timeout until the operation deadline · 200 + Atom error · DTD/external-entity XML · >5 MiB Atom · HTML at the PDF URL · >100 MiB PDF · missing and incorrect `Content-Length` · closes mid-body · 429 with both forms of `Retry-After` · truncated feed missing `</feed>` · redirect to a non-arXiv host at every hop position. Each maps to the documented exit code, leaves no live transport after return, and never produces a paper or cache entry from an invalid body.

**Contract and output-budget tests**

- Default search stays under its token ceiling; `--limit 200` refuses; `--full` caps at 5; JSON obeys identical caps.
- `text --pages 1-5` succeeds; `1-6`, reversed, zero and out-of-range intervals refuse. A five-page extraction over 30,000 characters reports the cut in both human and JSON output.
- `download` with 4 IDs refuses. Tests describe this as a command cap, never a task quota.
- `library list` defaults to 20, caps at 50, paginates with absolute offsets, and applies the same bounds to JSON.
- `get` stays under 20,000 rendered characters for an oversized summary/author fixture and reports every truncated field in human and JSON output.
- Exact IDs always select that version. A base ID with two local or trashed versions refuses and prints exact alternatives. A base `get` with only an old local version resolves latest instead of silently returning the old one.
- Search once, download from that result, then repeat the search from the 24h query cache: zero network requests and the row now says `in library`. Repeat after remove and restore; the same cached metadata reflects each current filesystem state.
- Cache writes stop below both 2,000 entries and 256 MiB; expired trash and `.part` files are actually swept.

**Live end-to-end**, run by hand once, in order (~1 request per step, 3 s apart):
```
arxiv search "speculative decoding"          # 10 results, honest total, footer
arxiv search "speculative decoding"          # ↻ cached, zero requests
arxiv get 2211.17192                          # resolves and prints exact latest version
arxiv download 2211.17192                     # path + exact version + page count
arxiv search "speculative decoding"           # cached upstream; now marked · in library
arxiv text 2211.17192 --pages 1-2             # bounded extraction
arxiv text 2211.17192                         # refuses: --pages required
arxiv library list                            # one entry
arxiv library remove 2211.17192               # soft delete + undo line
arxiv search "speculative decoding"           # cached upstream; no longer in library
arxiv library restore 2211.17192              # back
arxiv search "speculative decoding"           # cached upstream; in library again
arxiv download math.GT/0309136                # legacy slash ID survives
arxiv get 2302.0131                           # slip → did-you-mean, exit 3
```

**Skill install check** — `readlink` all three roots; confirm the skill is listed by Claude Code, and confirm Codex discovers `~/.agents/skills/arxiv/SKILL.md`.

**External agent acceptance harness** — this is the proof of the agent-facing product. The harness is a suite of prompts plus transcript and filesystem checks stored outside the repository and outside the implementing agent's write access; its defining property is that success cannot be obtained by editing the grader.

- Run a matrix of fresh sessions: broad search, exact-paper explanation, recent-paper comparison, zero results, malformed ID, upstream outage, and a prompt that tempts bulk downloading.
- Give each scenario an explicit whole-task download budget. Count every CLI invocation, so seven commands of three downloads cannot masquerade as compliance with a three-paper task budget.
- Record command arguments, stdout/stderr character counts, request timing, files created, PDFs downloaded and page ranges read.
- Score the state that matters: the answer cites a passage from pages actually read; total output stays within the scenario budget; no whole-document extraction occurs; download count stays within the scenario budget; and recovery follows exit codes rather than blind retry.
- The canonical scenario — *"find me recent papers on speculative decoding and tell me how the Leviathan method works"* — must search, triage on abstracts, download one paper, read a bounded range, and ground the answer in that passage.
