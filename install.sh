#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
SKILL_SOURCE="$PROJECT_ROOT/skills/arxiv"

cd "$PROJECT_ROOT"
npm ci
npm run build
npm link

for SKILL_ROOT in "$HOME/.claude/skills" "$HOME/.agents/skills" "$HOME/.codex/skills"; do
  mkdir -p "$SKILL_ROOT"
  TARGET="$SKILL_ROOT/arxiv"
  if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    echo "refusing to replace non-symlink: $TARGET" >&2
    exit 1
  fi
  ln -sfn "$SKILL_SOURCE" "$TARGET"
done

echo "installed arxiv CLI and skill"
echo "verify with: arxiv --version"
