# Hono Starter

Quick Hono + Deno starter.

Run locally:

- Start server: `deno task start`
- Run tests: `deno task test`

E2E with Docker Compose:

- Bring up the Postgres service (mapped to localhost:5432):

  ```sh
  deno task docker:postgres:compose:up
  ```

- Apply the schema and seed (one-shot init):

  ```sh
  deno task docker:postgres:db-init
  ```

- Run the E2E test harness (will use the DB):

  ```sh
  make e2e-run
  ```

- One-liner: bring DB up, init, run tests, and teardown:

  ```sh
  make e2e-full
  ```

- Convenience script (includes teardown by default):

  ```sh
  ./tools/run-e2e.sh
  # To keep DB running after tests:
  TEARDOWN=0 ./tools/run-e2e.sh
  ```

Includes `/events` SSE demo route.
