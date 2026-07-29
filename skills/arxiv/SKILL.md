---
name: arxiv
description: Triage arXiv research with bounded local search, metadata, downloads, and page text. Use when the user asks to find papers, research an academic topic, explain or compare arXiv work, retrieve a known paper, inspect a paper passage, or build a local paper library.
---

# arXiv triage

Use `arxiv` for arXiv papers, not general web research or sources outside arXiv. Triage means spending cheap metadata first and downloading only when a paper can materially improve the answer.

## Objective

Stop when you can answer the user's question and cite a passage from pages you actually read. A directory full of unread PDFs is not progress.

## Default loop

```console
$ arxiv search "speculative decoding"
$ arxiv get 2211.17192
$ arxiv download 2211.17192
$ arxiv text 2211.17192 --pages 1-3
```

Search first, compare abstracts, then download one paper. Read a targeted range of at most five pages. Repeat only when the evidence still has a named gap.

## Context costs

| Command | Typical cost | Use |
|---|---:|---|
| `search` | ~90 tokens/result | Compare bounded abstracts |
| `search --titles-only --limit 40` | ~15 tokens/result | Buy breadth cheaply |
| `get <id>` | Up to 20k characters | Inspect one full metadata record |
| `download <id>` | No document text | Make one selected paper local |
| `text <id> --pages A-B` | Up to 30k characters | Read evidence, at most 5 pages |
| `library list` | 20 records by default | Reuse prior downloads |

Never widen abstracts with `--full` before a titles-only scan. Download one at a time even though the command refuses only after three IDs; that cap is per invocation, not a research-task budget.

## Exit codes

| Code | Meaning | Branch |
|---:|---|---|
| 0 | Success, including zero results | Use the result |
| 2 | Invalid or over-budget command | Apply the printed correction |
| 3 | Paper not found | Check the ID or search |
| 4 | Upstream unavailable | Use stale output if offered; retry later |
| 5 | Shared API gate unavailable | Retry the exact command later |
| 6 | Local library problem | Stop and run the printed repair/check |

## Recoveries

- Zero results: remove question phrasing; search literal technical terms and use `--titles-only`.
- Broad results: add `--category`, `--title`, `--author`, or `--since`.
- Bad ID: use the printed suggestion or search the base ID; never guess a version.
- Rate limit or outage: follow the exit code; do not launch parallel retries.
- Ambiguous local version: use one of the exact versioned commands printed by the CLI.
- Missing passage: request the next narrow page range, not the whole document.

## Anti-patterns

- Do not scrape arxiv.org in a browser; use `search` or `get`.
- Do not download every plausible result; use abstracts to eliminate papers first.
- Do not read an entire PDF; use the abstract, page count, and targeted `text` ranges.
- Do not cite an abstract as if it proves a body-text claim; read the relevant pages.
- Do not treat `in library vN — vM available` as holding vM.
- Do not parse human output when automating; use `--json`.

JSON is a top-level object with `schemaVersion: 1`. Fields are additive. `cacheState`, `metadataState`, and other enums may gain values; treat an unrecognized value as `unknown`.
