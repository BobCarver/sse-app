#!/usr/bin/env sh
set -eu
TEARDOWN=${TEARDOWN:-1}
echo "[run-e2e] Bringing up DB..."
docker compose up -d db

echo "[run-e2e] Running one-shot DB init..."
docker compose run --rm db-init

echo "[run-e2e] Starting server with test DB env..."
# ensure any existing server on PORT is stopped
if lsof -i :8000 -t >/dev/null 2>&1; then
  echo "Killing existing process on :8000"
  lsof -i :8000 -t | xargs -r kill || true
  sleep 1
fi

DATABASE_URL="postgres://postgres:test@localhost:5432/test_db" \
JWT_SECRET="test-secret" \
JUDGE_SCORE_TIMEOUT_MS="5000" \
PORT=8000 nohup deno run --allow-net --allow-env --allow-read app/src/main.ts > /tmp/deno-8000.log 2>&1 &

# Wait for /_health to report OK (timeout 60s)
HEALTH_URL="http://localhost:8000/_health"
echo "Waiting for $HEALTH_URL to return OK..."
END=$((SECONDS+60))
while [ $SECONDS -lt $END ]; do
  status=$(curl -s -o /dev/null -w "%{http_code}" $HEALTH_URL || true)
  if [ "$status" = "200" ]; then
    echo "Server reported healthy"
    break
  fi
  sleep 1
done

if [ "$status" != "200" ]; then
  echo "Server did not become healthy in time (status=$status). See /tmp/deno-8000.log for details"
  tail -n +1 /tmp/deno-8000.log || true
  exit 1
fi


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
