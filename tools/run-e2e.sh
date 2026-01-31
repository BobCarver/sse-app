#!/usr/bin/env sh
set -eu

# Convenience script to run a full local e2e run:
# - bring up Postgres with docker compose
# - apply schema & seed (one-shot db-init)
# - run the e2e tests
# - optionally tear down the compose stack

TEARDOWN=${TEARDOWN:-1} # set to 0 to keep DB running after tests

echo "[run-e2e] Bringing up DB..."
denolib() {
  deno task "$@"
}

denolib docker:postgres:compose:up

echo "[run-e2e] Running one-shot DB init..."
denolib docker:postgres:db-init

echo "[run-e2e] Running e2e tests..."
if denolib test:e2e; then
  echo "[run-e2e] E2E tests passed"
  EXIT_CODE=0
else
  echo "[run-e2e] E2E tests failed"
  EXIT_CODE=1
fi

if [ "$TEARDOWN" -eq 1 ]; then
  echo "[run-e2e] Tearing down DB stack..."
  denolib docker:postgres:compose:down
else
  echo "[run-e2e] Leaving DB stack running (TEARDOWN=0)"
fi

exit "$EXIT_CODE"
