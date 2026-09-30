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
- During an event, when something is stuck (`ADMIN_TOKEN=... deno task links ...`):
  - `sessions` shows every running session, its phase and who it is waiting for.
  - `skip <sessionId>` stops waiting for whatever it is stuck on: a client that
    never connected (the session goes on without them), a performance (treated
    as skipped; the DJ's audio stops), or judges who have not scored (scoring
    closes with the scores received). Missing scores are listed under
    `sessions` and judges are told scoring closed.
  - `abort <sessionId>` ends it now and frees the track and judges; every page
    is told. Start it again with `POST /sessions/<id>/start`.
  - Judges have `JUDGE_SCORE_TIMEOUT_MS` (default 60000) to score; set
    `PERFORMANCE_TIMEOUT_MS` to cap a performance (default: no limit).
  - The DJ presses **Enable audio** once after opening the page; browsers block
    playback until then. A performance that starts earlier waits for the click.
- Start a session: `POST /sessions/<id>/start` with `Authorization: Bearer $ADMIN_TOKEN`.
- Serve over HTTPS in production (cookies are marked `Secure` behind
  `X-Forwarded-Proto: https`), and set `PUBLIC_URL` if the server is behind a proxy
  so issued links use the public address.

## Tests and checks

Everything CI runs can be run locally with the same commands:

| Command | What it does | Needs a database |
| --- | --- | --- |
| `deno task static` | type-check, lint, format check, and that the committed bundles in `public/` match their sources | no |
| `deno task test:unit` | server logic: sessions, waits, credentials, recovery, operator controls | no |
| `deno task test:frontend` | the page classes against mocked connections | no |
| `deno task test:contract` | the real HTTP app (auth, `/response`, admin API) | no |
| `deno task test:integration` | full sessions over real event streams and Postgres | yes (`DATABASE_URL`, schema loaded, tables empty) |
| `deno task test` | the four suites above, in order | for the last one |
| `deno task test:e2e` | browser tests (Playwright) driving the real pages | yes (schema **and** seed) |

- Integration tests skip themselves without `DATABASE_URL`. Set `REQUIRE_DB=1`
  to make a missing database a failure (CI does).
- The bundles are built with `deno bundle`, whose output depends on the Deno
  version, so `deno task static` fails if `public/` is stale: run `deno task
  build` and commit. CI pins the Deno version in `.github/workflows/ci.yml`.
- Fix formatting with `deno task fmt`.

### Database for the integration and browser tests

With Docker (Postgres on localhost:5432; schema and seed loaded):

```sh
./tools/run-e2e.sh              # up -> load schema + seed -> browser tests -> down
TEARDOWN=0 ./tools/run-e2e.sh   # leave the database running afterwards
```

or step by step:

```sh
deno task docker:postgres:compose:up
deno task docker:postgres:db-init      # schema + seed (session 1, competition 10, judges 2/3)
export DATABASE_URL=postgres://postgres:test@localhost:5432/test_db
deno task test:e2e                     # builds the bundles, starts the app, runs Playwright
docker compose -f docker/docker-compose.yml down -v   # reset completely
```

Without Docker, point `DATABASE_URL` at any Postgres and load
`docker/postgres/db-init/01_schema.sql` (and `02_seed.sql` for the browser
tests) with `psql`. The integration tests need a database with the schema but
**empty tables** (they seed and clean up after themselves); the browser tests
need the seed. Playwright starts the app on port 8000 (`E2E_PORT` to change),
or reuses one already running there.

If `/sessions/1/start` returns `No competitions found`, the seed is not loaded.
