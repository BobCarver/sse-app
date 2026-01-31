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
  deno task test:e2e
  ```

- One-liner: bring DB up, init, run tests, and teardown:

  ```sh
  deno task init-db:all && deno task test:e2e && deno task docker:postgres:compose:down
  ```

- Convenience script (includes teardown by default):

  ```sh
  ./tools/run-e2e.sh
  # To keep DB running after tests:
  TEARDOWN=0 ./tools/run-e2e.sh
  ```

Includes `/events` SSE demo route.
