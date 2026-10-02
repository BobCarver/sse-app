#!/usr/bin/env sh
# The whole Deno suite (unit, frontend, contract, integration) with Docker
# providing Postgres. The contract and integration tests need a database with the
# schema and EMPTY tables, which is not what the compose file's default database
# holds (the container's entrypoint seeds it for the browser tests). So this makes
# a second, schema-only database in the same container and points the tests at it.
#
#   ./tools/run-tests.sh              # tear the database down afterwards
#   TEARDOWN=0 ./tools/run-tests.sh   # leave it running for debugging
#   ./tools/run-tests.sh test:unit    # pass a deno task instead of the whole suite
set -eu
cd "$(dirname "$0")/.."

TEARDOWN=${TEARDOWN:-1}
TASK=${1:-test}
COMPOSE="docker compose -f docker/docker-compose.yml"
EMPTY_DB=test_empty

psql_in() { docker exec -i sse_test_db psql -U postgres -q -v ON_ERROR_STOP=1 "$@"; }

echo "[run-tests] starting the database"
$COMPOSE up -d --wait db
# "healthy" is also reported by the entrypoint's temporary server while it loads the
# default database, and that server then shuts down. Wait for the entrypoint to say
# it is finished, then for the real server to accept queries.
until docker logs sse_test_db 2>&1 | grep -q "init process complete"; do sleep 1; done
until docker exec sse_test_db psql -U postgres test_db -tc 'select 1' >/dev/null 2>&1; do
  sleep 1
done

echo "[run-tests] creating $EMPTY_DB (schema only)"
psql_in -d postgres -c "DROP DATABASE IF EXISTS $EMPTY_DB" -c "CREATE DATABASE $EMPTY_DB" >/dev/null
psql_in -d "$EMPTY_DB" <docker/postgres/db-init/01_schema.sql >/dev/null

export DATABASE_URL="${DATABASE_URL:-postgres://postgres:test@localhost:5432/$EMPTY_DB}"
export REQUIRE_DB=1 # a missing database is a failure here, not a skip

set +e
deno task "$TASK"
RESULT=$?
set -e

if [ "$TEARDOWN" = "1" ]; then
  echo "[run-tests] stopping the database"
  $COMPOSE down -v
else
  echo "[run-tests] leaving the database running (TEARDOWN=0)"
fi
exit $RESULT
