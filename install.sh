#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)

cd "$PROJECT_ROOT"
npm ci
npm run build
npm link

# Only the arxiv skill is installed from here. The epistemics pack that also lives
# under skills/ is published from the agent-skills repo, which is where the
# canonical, generalized copy is maintained and where the global symlinks point.
# Linking it from here too would silently repoint those at this repo's copy.
SKILL_SOURCE="$PROJECT_ROOT/skills/arxiv"

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
