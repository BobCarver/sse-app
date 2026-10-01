# Dance competition scoring

A Deno server (Hono) that runs dance-competition sessions for DJs, judges and
scoreboards over SSE (server to client) and `fetch` POST (client to server).
Architecture, decisions and open items: see `CLAUDE.md`.

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

## Admin page

Open `/admin` (for example `http://localhost:3000/admin`) and sign in with the
admin token (`ADMIN_TOKEN`). The token is entered once into a form; the server
answers with a separate `HttpOnly`, `SameSite=Strict` cookie that expires after 12
hours, so the token never appears in a URL or the page. The command-line tool keeps
using the bearer token.

- **Festival tab**: the whole festival as a tree with a hide/reveal triangle at every
  level: festival, track, session, competition, competitor. Upcoming, in progress and
  finished are shown in grey, amber and green (and as text, not colour alone).
  Everything refreshes every three seconds; which triangles are open is remembered.
- **Sessions** have Start, Skip and Abort (Skip stops waiting for whatever the session
  is stuck on), what the running session is doing, and who it is waiting for.
- **Competitors** show how many judges have scored them and whether announcement and
  music audio exist; click an audio badge to upload or replace it (after the cut-off
  you are asked to confirm).
- **Links**: every track's DJ and scoreboard, and every judge (Judges tab), has a
  **New link** button. The link is shown once with **Copy**, a **QR code** to scan,
  and **Email** / **Text message** / **WhatsApp** buttons that open your own mail,
  messages or WhatsApp with the link filled in (a judge's email is prefilled when it is
  on file). Type a phone number (with country code) in the dialog to send straight to
  one person; it is used for that send only and is not saved. Without a number, WhatsApp
  opens its contact chooser. Existing
  links are listed with **Revoke**, which locks the device out at once.

## Demo: see the whole system in one tab

A development page shows a scoreboard, a DJ and two judges side by side, each
signed in as its own device, with buttons to start, skip, abort and reset the
session. It is off unless `DEMO=1` (it hands out sign-in links to whoever holds
the admin token), so never enable it in production.

```sh
# 1. a database with the schema, then the demo data (psql required)
export DATABASE_URL=postgres://postgres:test@localhost:5432/test_db
psql "$DATABASE_URL" -f docker/postgres/db-init/01_schema.sql
deno task demo:seed          # one track, one session, two competitions, five competitors, two judges

# 2. the server in demo mode
ADMIN_TOKEN=demo deno task demo

# 3. open the page (it moves itself to lvh.me, see below)
open "http://localhost:3000/demo?token=demo"
```

In the page: **1. Reset + make audio** (generates a short beep and a tone melody
per competitor), wait for the DJ frame to say *Audio ready*, click **Enable
audio** in the DJ frame once, then **2. Start session**. For each act the DJ frame
plays the announcement; press **play** there to start the song (it never starts by
itself), or **skip** to move on to the next competitor. When the song ends the judges
get sliders and the scoreboard fills in. **Reset** clears it
to run again. The demo data is `docker/postgres/demo/demo_seed.sql` (ids 1000+, so
it can sit next to the test seed; it is deliberately not in `db-init/`). Use
`&session=<id>` to demo a different session, for example `1` with the test seed.

**Why `lvh.me`?** A device is identified by one cookie and cookies are shared by
everything on a host, so four frames on `localhost` would all be the same device.
The page puts each frame on its own subdomain (`dj.lvh.me`, `judge1.lvh.me`, ...;
`lvh.me` resolves to 127.0.0.1) and keeps them same-site with the page, so the
`SameSite=Strict` cookie works unchanged. Offline, add
`127.0.0.1 scoreboard.lvh.me dj.lvh.me judge1.lvh.me judge2.lvh.me lvh.me` to
`/etc/hosts`, or set `DEMO_DOMAIN` to a domain you control.

