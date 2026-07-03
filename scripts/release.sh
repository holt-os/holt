#!/usr/bin/env bash
#
# Cut a Holt release with one command.
#
#   scripts/release.sh                 # bump the patch version (default)
#   scripts/release.sh patch|minor|major
#   scripts/release.sh 1.2.3           # set an exact version
#
# It bumps the version in package.json and src/version.ts, runs the same checks
# CI runs, commits, tags, and pushes main plus the tag. The Release workflow
# (.github/workflows/release.yml) then publishes to npm and bumps the Homebrew
# formula. Nothing here needs your npm passkey.
set -euo pipefail

cd "$(dirname "$0")/.."

bump="${1:-patch}"
current=$(node -p "require('./package.json').version")

# Work out the next version.
if printf '%s' "$bump" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  next="$bump"
else
  IFS=. read -r MA MI PA <<EOF
$current
EOF
  case "$bump" in
    major) next="$((MA + 1)).0.0" ;;
    minor) next="${MA}.$((MI + 1)).0" ;;
    patch) next="${MA}.${MI}.$((PA + 1))" ;;
    *) echo "usage: scripts/release.sh [patch|minor|major|X.Y.Z]" >&2; exit 1 ;;
  esac
fi

echo "Releasing ${current} -> ${next}"

# Preconditions: on main, clean tree, tag not already used.
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || { echo "Not on main (on ${branch}). Switch first." >&2; exit 1; }
git diff --quiet && git diff --cached --quiet || { echo "Working tree is not clean. Commit or stash first." >&2; exit 1; }
if git rev-parse "v${next}" >/dev/null 2>&1; then
  echo "Tag v${next} already exists." >&2; exit 1
fi

# Restore the version files if anything below fails before we commit.
restore() { git checkout -- package.json src/version.ts 2>/dev/null || true; }
trap restore ERR

# Bump the two version sites.
node -e "const f='package.json',j=require('./'+f);j.version='${next}';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
tmp=$(mktemp)
sed -E "s/export const VERSION = '.*';/export const VERSION = '${next}';/" src/version.ts > "$tmp" && mv "$tmp" src/version.ts

# Same checks CI runs, so a bad release never leaves the machine.
npm run typecheck
npm run build
node dist/cli.js version | grep -q "holt ${next}" || { echo "CLI did not report holt ${next}" >&2; exit 1; }
if grep -rlF "$(printf '\342\200\224')" src README.md ARCHITECTURE.md CONTRIBUTING.md CONFIGURATION.md 2>/dev/null; then
  echo "em-dash found; remove it before releasing" >&2; exit 1
fi

trap - ERR

git add package.json src/version.ts
git commit -m "Release v${next}"
git tag "v${next}"
git push origin main
git push origin "v${next}"

echo ""
echo "Pushed v${next}. The Release workflow will publish to npm and bump Homebrew."
echo "Watch it:  gh run watch"
