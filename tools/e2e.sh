#!/usr/bin/env sh
# Browser tests (Playwright) against a database that already has the schema and
# seed loaded. Playwright starts the app itself (see node-tests/playwright.config.ts).
#
#   DATABASE_URL=postgres://... sh tools/e2e.sh          # or: deno task test:e2e
#
# Use tools/run-e2e.sh instead to have Docker provide the database.
set -eu
cd "$(dirname "$0")/.."

: "${DATABASE_URL:?set DATABASE_URL to a database with the schema and seed loaded}"

echo "[e2e] building browser bundles"
deno task build

cd node-tests
if [ ! -d node_modules ]; then
  echo "[e2e] installing test dependencies"
  npm ci
fi

# CI is a clean machine: install the browser and its system libraries.
if [ "${CI:-}" = "true" ]; then
  npx playwright install --with-deps chromium
else
  npx playwright install chromium
fi

echo "[e2e] running browser tests"
exec npx playwright test
