#!/usr/bin/env sh
set -eu

echo "[init-test-db] Starting"

if ! command -v psql >/dev/null 2>&1; then
  echo "[init-test-db] ERROR: psql not found on PATH. Install Postgres client tools." >&2
  exit 1
fi

if [ -z "${DATABASE_URL-}" ]; then
  echo "[init-test-db] ERROR: DATABASE_URL is not set. Export it and retry." >&2
  exit 2
fi

DATABASE_URL_ESCAPED="$DATABASE_URL"

# Extract db name from DATABASE_URL
DB_NAME=$(printf "%s" "$DATABASE_URL_ESCAPED" | sed -E 's#.*/([^/?]+).*#\1#')
if [ -z "$DB_NAME" ]; then
  echo "[init-test-db] ERROR: Could not parse DB name from DATABASE_URL: $DATABASE_URL" >&2
  exit 3
fi

# Make an admin URL by replacing the path with /postgres (preserve query)
ADMIN_URL=$(printf "%s" "$DATABASE_URL_ESCAPED" | sed -E 's#(postgresql?://[^/]+)/[^?]*(\?.*)?#\1/postgres\2#')

echo "[init-test-db] DB_NAME=$DB_NAME"

# Test connectivity to target DB
if psql "$DATABASE_URL_ESCAPED" -c "SELECT 1;" >/dev/null 2>&1; then
  echo "[init-test-db] Target DB reachable — applying schema and seed"
  psql "$DATABASE_URL_ESCAPED" -f src/schema2.sql
  psql "$DATABASE_URL_ESCAPED" -f test/seed_db.sql
  echo "[init-test-db] Done"
  exit 0
fi

# If target DB not reachable, try to create it using the admin connection
echo "[init-test-db] Target DB not reachable; attempting to create DB via admin connection"

if ! psql "$ADMIN_URL" -c "SELECT 1;" >/dev/null 2>&1; then
  echo "[init-test-db] ERROR: Admin connection to Postgres failed using: $ADMIN_URL" >&2
  echo "[init-test-db] Try connecting manually or adjust DATABASE_URL to point to a superuser DB." >&2
  exit 4
fi

# Check existence
EXISTS=$(psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME';") || true
if [ "$EXISTS" = "1" ]; then
  echo "[init-test-db] Database $DB_NAME already exists, trying to apply schema"
else
  echo "[init-test-db] Database $DB_NAME does not exist. Attempting to create using 'createdb' (if available), otherwise falling back to admin psql."

  if command -v createdb >/dev/null 2>&1; then
    echo "[init-test-db] 'createdb' found. Parsing connection info to use it."
    # If URL contains user/pass@, extract them
    if printf "%s" "$DATABASE_URL_ESCAPED" | grep -q "@"; then
      AUTH=$(printf "%s" "$DATABASE_URL_ESCAPED" | sed -E 's#^[^:]+://([^@]+)@.*#\1#')
      USER=$(printf "%s" "$AUTH" | sed -E 's#^([^:]+):?.*$#\1#')
      PASS=$(printf "%s" "$AUTH" | sed -E 's#^[^:]+:(.*)$#\1#' || true)
    else
      USER=""
      PASS=""
    fi

    # Extract host:port part
    AUTH_HOSTPORT=$(printf "%s" "$DATABASE_URL_ESCAPED" | sed -E 's#^[^:]+://([^/]+).*#\1#')
    # strip any user@ prefix
    HOSTPORT=$(printf "%s" "$AUTH_HOSTPORT" | sed -E 's#^.@##;s#.*@(.+)$#\1#')
    HOST=$(printf "%s" "$HOSTPORT" | sed -E 's#^([^:]+)(:.*)?$#\1#')
    PORT=$(printf "%s" "$HOSTPORT" | sed -E 's#^[^:]+:([0-9]+)$#\1#' || true)

    # Export PG env vars for createdb to pick up
    if [ -n "$USER" ]; then export PGUSER="$USER"; fi
    if [ -n "$PASS" ]; then export PGPASSWORD="$PASS"; fi
    if [ -n "$HOST" ]; then export PGHOST="$HOST"; fi
    if [ -n "$PORT" ]; then export PGPORT="$PORT"; fi

    echo "[init-test-db] Running: createdb $DB_NAME"
    if createdb "$DB_NAME" >/dev/null 2>&1; then
      echo "[init-test-db] createdb succeeded"
    else
      echo "[init-test-db] createdb failed or database may already exist. Falling back to admin psql..."
      echo "[init-test-db] Creating database $DB_NAME via admin psql"
      psql "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\";"
    fi

    # Clear PGPASSWORD for security
    unset PGPASSWORD || true
  else
    echo "[init-test-db] 'createdb' not found. Creating database $DB_NAME via admin psql"
    psql "$ADMIN_URL" -c "CREATE DATABASE \"$DB_NAME\";"
  fi
fi

# Apply schema and seed
echo "[init-test-db] Applying schema and seed to $DB_NAME"
psql "$DATABASE_URL_ESCAPED" -f src/schema2.sql
psql "$DATABASE_URL_ESCAPED" -f test/seed_db.sql

echo "[init-test-db] Completed successfully"