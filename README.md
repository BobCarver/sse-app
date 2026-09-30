# Hono Starter

Quick Hono + Deno starter.

Run locally:

- Start server: `deno task start`
- Run tests: `deno task test`

Access: links for DJs, judges and scoreboards

Nothing on the server trusts a device until it opens an admin-issued link.

- Set `ADMIN_TOKEN` when starting the server (`ADMIN_TOKEN=... deno task start`).
  Without it the admin endpoints and `POST /sessions/:id/start` are disabled.
- Once per festival, issue a link per device. A DJ and a scoreboard belong to a
  track, a judge to a judge id (judges move between tracks with the same link):

  ```sh
  ADMIN_TOKEN=... deno task links issue --base https://scoring.example --tracks 1,2 --judges 2,3
  ```

  Links are shown once (the server keeps only a hash). Hand them out as QR codes
  (`qrencode -t ANSIUTF8 <link>`). Opening a link stores a cookie and opens the
  right page (`/dj`, `/judge`, `/scoreboard`); there are no URL parameters.
- Lost or replaced device: `deno task links list`, then
  `deno task links revoke <id>` (takes effect immediately), then issue a new one.
- Start a session: `POST /sessions/<id>/start` with `Authorization: Bearer $ADMIN_TOKEN`.
- Serve over HTTPS in production (cookies are marked `Secure` behind
  `X-Forwarded-Proto: https`), and set `PUBLIC_URL` if the server is behind a proxy
  so issued links use the public address.

E2E with Docker Compose 🧪

- Bring up the Postgres service (mapped to localhost:5432):

  ```sh
  deno task docker:postgres:compose:up
  ```

- Apply the schema and seed (one-shot init). The seed creates deterministic test
  rows (session=1, competition=10, competitor=100, judges=2/3):

  ```sh
  deno task docker:postgres:db-init
  ```

- Run the E2E test harness (Playwright). The project includes
  `./tools/run-e2e.sh` which does the full flow (up → seed → tests → teardown):

  ```sh
  ./tools/run-e2e.sh
  # To keep DB running after tests:
  TEARDOWN=0 ./tools/run-e2e.sh
  ```

- Or run the steps manually (useful for debugging):

  ```sh
  deno task docker:postgres:compose:up
  deno task docker:postgres:db-init
  cd tests && npm ci && npx playwright install --with-deps && npx playwright test
  ```

- Quick teardown (remove volumes to reset DB completely):

  ```sh
  docker compose down -v
  ```

Notes & tips:

- The Playwright `webServer` config will automatically start the server when
  running tests, but you can also start it manually on port 8000:

  ```sh
  PORT=8000 deno run --allow-net --allow-env --allow-read app/src/main.ts
  # or for dev: deno task dev
  ```

- If `/sessions/1/start` returns `No competitions found`, ensure you ran the DB
  init step (above) or run `./tools/run-e2e.sh` which seeds the DB for you.

Includes `/events` SSE demo route.
