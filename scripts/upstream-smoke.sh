#!/bin/sh
# Verifies that real arXiv still behaves the way this CLI assumes.
#
# The unit suite is hermetic by design: it is fast, deterministic, and safe to
# run on every push. That same property means it cannot notice arXiv changing
# its Atom feed, its redirects, or its PDF delivery. Only a live request can.
#
# This script is the counterpart. It issues a handful of real requests through
# the CLI's own network gate, so it inherits the three-second pacing and the
# single-connection guarantee rather than working around them.
#
# Run it before a release, and on a schedule. Do not run it per-push.
#
#   ./scripts/upstream-smoke.sh
#
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
CLI="$PROJECT_ROOT/dist/src/cli.js"

if [ ! -f "$CLI" ]; then
  echo "build first: npm run build" >&2
  exit 1
fi

# A versioned ID names immutable content, so this paper's metadata and page
# count are stable references rather than a moving target.
PAPER="2211.17192v2"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
ARXIV_LIBRARY="$WORKDIR/library"
export ARXIV_LIBRARY

arxiv() {
  node "$CLI" "$@"
}

fail() {
  echo "upstream smoke FAILED: $1" >&2
  exit 1
}

check_envelope() {
  # $1 = json payload, $2 = description
  printf '%s' "$1" | node -e '
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      const label = process.argv[1];
      let payload;
      try {
        payload = JSON.parse(chunks.join(""));
      } catch (error) {
        console.error(`${label}: stdout was not valid JSON: ${error.message}`);
        process.exit(1);
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        console.error(`${label}: JSON payload must be a top-level object.`);
        process.exit(1);
      }
      if (payload.schemaVersion !== 1) {
        console.error(`${label}: schemaVersion was ${payload.schemaVersion}, expected 1.`);
        process.exit(1);
      }
      if (typeof payload.cliVersion !== "string" || payload.cliVersion.length === 0) {
        console.error(`${label}: cliVersion missing from the envelope.`);
        process.exit(1);
      }
      const checks = JSON.parse(process.argv[2] ?? "[]");
      for (const path of checks) {
        const value = path.split(".").reduce((node, key) => (node ?? {})[key], payload);
        if (value === undefined || value === null) {
          console.error(`${label}: expected field \"${path}\" was absent.`);
          process.exit(1);
        }
        if (Array.isArray(value) && value.length === 0) {
          console.error(`${label}: expected field \"${path}\" was empty.`);
          process.exit(1);
        }
      }
    });
  ' "$2" "${3:-[]}" || fail "$2"
}

echo "1/5 search returns live results"
SEARCH=$(arxiv search "speculative decoding" --limit 3 --json) || fail "search exited non-zero"
check_envelope "$SEARCH" "search" '["results","shown"]'

echo "2/5 metadata resolves for an immutable versioned ID"
GET=$(arxiv get "$PAPER" --json) || fail "get exited non-zero"
check_envelope "$GET" "get" '[]'

echo "3/5 PDF downloads and passes validation"
arxiv download "$PAPER" > /dev/null || fail "download exited non-zero"

echo "4/5 a bounded page range extracts text"
TEXT=$(arxiv text "$PAPER" --pages 1-2 --json) || fail "text exited non-zero"
check_envelope "$TEXT" "text" '["pages.start","pages.end"]'

echo "5/5 an unknown paper reports not-found rather than crashing"
set +e
arxiv get "0000.00000v1" --json > /dev/null 2>&1
NOT_FOUND=$?
set -e
if [ "$NOT_FOUND" -ne 3 ] && [ "$NOT_FOUND" -ne 4 ]; then
  fail "unknown ID exited $NOT_FOUND, expected 3 (not found) or 4 (upstream unavailable)"
fi

echo "upstream smoke PASSED against live arXiv"
