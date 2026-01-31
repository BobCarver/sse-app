#!/usr/bin/env sh
set -eu

# Safety: confirm before destructive actions
echo "This script will: init git (if needed), create branch 'e2e/playwright-migration', archive test/e2e -> archive/legacy-deno-e2e, and update Makefile & tools/run-e2e.sh."
printf "Proceed? [y/N]: "
read ans
[ "$ans" = "y" ] || exit 0

# Init git if not present
if [ ! -d .git ]; then
  git init
  git add .
  git commit -m "chore: initial import"
fi

git checkout -b e2e/playwright-migration

# Archive legacy Deno e2e
mkdir -p archive/legacy-deno-e2e
if [ -d test/e2e ]; then
  git mv test/e2e archive/legacy-deno-e2e || (mv test/e2e archive/legacy-deno-e2e && git add archive/legacy-deno-e2e)
fi

# Add Playwright tests and app/ rearrangement already applied in this workspace copy

# Commit changes
git add -A
git commit -m "chore(e2e): migrate to Playwright — add tests/, archive legacy e2e, move Deno app to app/" || true

echo "Done on branch: $(git branch --show-current). Next: run smoke tests (make e2e-up && make e2e-init && make e2e-run)."
