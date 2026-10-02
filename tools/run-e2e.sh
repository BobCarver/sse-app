#!/usr/bin/env sh
# Full local browser-test run with Docker providing Postgres:
#   up -> load schema + seed -> tools/e2e.sh -> tear down
#
#   ./tools/run-e2e.sh              # tear the database down afterwards
#   TEARDOWN=0 ./tools/run-e2e.sh   # leave it running for debugging
set -eu
cd "$(dirname "$0")/.."

TEARDOWN=${TEARDOWN:-1}
COMPOSE="docker compose -f docker/docker-compose.yml"

echo "[run-e2e] starting the database"
$COMPOSE up -d --wait db
echo "[run-e2e] loading schema and seed"
$COMPOSE run --rm db-init

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:test@localhost:5432/test_db}"

set +e
sh tools/e2e.sh
RESULT=$?
set -e

if [ "$TEARDOWN" = "1" ]; then
  echo "[run-e2e] stopping the database"
  $COMPOSE down -v
else
  echo "[run-e2e] leaving the database running (TEARDOWN=0)"
fi
exit $RESULT
