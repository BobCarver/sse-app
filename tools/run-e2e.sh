#!/usr/bin/env sh
set -eu
TEARDOWN=${TEARDOWN:-1}
echo "[run-e2e] Bringing up DB..."
docker compose up -d db

echo "[run-e2e] Running one-shot DB init..."
docker compose run --rm db-init

echo "[run-e2e] Running e2e tests..."
cd tests && npm ci && npx playwright install --with-deps && npx playwright test
RESULT=$?

if [ "$TEARDOWN" -eq 1 ]; then
  echo "[run-e2e] Tearing down DB stack..."
  docker compose down
else
  echo "[run-e2e] Leaving DB stack running (TEARDOWN=0)"
fi

exit $RESULT
