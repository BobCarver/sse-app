# Dance competition scoring

A Deno server (Hono) that runs dance-competition sessions for DJs, judges and
scoreboards over SSE (server to client) and `fetch` POST (client to server).
Architecture, decisions and open items: see `CLAUDE.md`.

Run locally:

- Start server: `deno task start` (needs a festival bundle, see below)
- Run tests: `deno task test`

## The festival bundle

The festival's structure (tracks, sessions, competitions, rubrics, judges,
competitors and their audio) is not entered on this server: it comes from a
**festival bundle** exported by the registration portal (`portal.md` section 5):
`manifest.json`, `data.json` and `audio/<sha256>.<ext>`. Copy it with any tool
(USB stick, `cp`, `rsync -a --ignore-existing`) and point the server at it:

```sh
BUNDLE_DIR=/srv/sse/bundle AUDIO_DIR=/srv/sse/audio ADMIN_TOKEN=... deno task start
```

`BUNDLE_DIR` (default `./bundle`) holds `manifest.json` and `data.json`;
`AUDIO_DIR` (default `./audio`) holds the audio files. At start the server checks
everything (the data's running order and references, the manifest, every audio
file's size and sha256) and refuses to start with a list of what is wrong. The
database remembers the bundle it first ran with and refuses a different one once
anything has happened (use a fresh database for a different bundle). The bundle
is final: there are no uploads or changes on this server.

**Audio.** Each track's DJ page downloads the audio of *all of that track's sessions*
once, as soon as the page is open (there is no cut-off time), checks every file's
hash, keeps it in the browser and plays from that copy. The first session to start on
a track waits until the DJ page reports it holds everything (`audio:dj<N>` under
`sessions`; `skip` stops waiting). Open the DJ page well before the event, over HTTPS
or `localhost` if you can (on plain http the copy is kept in memory only, and a page
reload downloads it again). If a file is missing or broken the DJ skips that
performance, which is recorded as a skip.

## Configuration

Environment variables (all optional except where noted):

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | none | Postgres for scores, progress and credentials; without it nothing is saved |
| `ADMIN_TOKEN` | none | enables the admin API, page and `deno task links` (503 without it) |
| `BUNDLE_DIR`, `AUDIO_DIR` | `./bundle`, `./audio` | the festival bundle and its audio files |
| `PORT`, `PUBLIC_URL` | `3000`, none | listen port; public address used in issued links behind a proxy |
| `JUDGE_SCORE_TIMEOUT_MS` | `60000` | how long judges have to score |
| `PERFORMANCE_TIMEOUT_MS` | `0` (none) | cap on a performance; a timeout counts as skipped |
| `ALLOWANCE_ANNOUNCE_S`, `ALLOWANCE_SCORING_S`, `ALLOWANCE_CHANGEOVER_S` | `20`, `30`, `45` | per-competitor seconds in the "about 14:25" delay estimate |
| `ARMING` | on | `0`: sessions do not start themselves (start by hand) |
| `DJ_GATES` | on | `0`: no DJ Start / End buttons (tests and the browser tests) |
| `CLOUD_URL`, `CLOUD_TOKEN`, `CLOUD_PUSH_INTERVAL_S` | off, none, `300` | cloud copy of the scores, see below |
| `DEMO`, `DEMO_DOMAIN`, `DEMO_SESSION` | off, `lvh.me`, `1000` | development demo page, see below |
| `REQUIRE_DB`, `E2E_PORT`, `BASE_URL`, `DEBUG` | | tests (`1` makes a missing database a failure; browser-test port) / the `links` tool's server / debug logging |

## Cloud copy of the scores

With `CLOUD_URL` (https; plain http only for localhost) and `CLOUD_TOKEN` set, the
server sends the festival's scores (and skips) to the portal's receiver, without
the event ever waiting on it:

- A snapshot goes out **when a competition ends and when a session ends**, and every
  `CLOUD_PUSH_INTERVAL_S` (300 s) as a safety net and retry. It is not sent again
  while nothing has changed. The portal replaces the festival's scores with each
  snapshot, so a missed push needs no special handling.
- If the portal cannot be reached the server carries on, retries with a growing pause
  (up to 5 minutes) and the admin page header says "Cloud copy: offline since ...".
  Otherwise it says "Cloud copy: last sent 12 s ago".
- **After the event**, send the authoritative copy and check it arrived:

  ```sh
  ADMIN_TOKEN=... deno task links push --final
  ```

  `push` without `--final` sends now unless nothing changed. Both exit with an error
  and the reason if the portal did not accept it.
- The payload is `POST` JSON with `Authorization: Bearer $CLOUD_TOKEN`:
  `festival_id`, `bundle_digest` (the receiver should reject a different bundle),
  `digest`, `final`, `sent_at`, `scores[]` (`competition_id, competitor_id, judge_id,
  criteria_id, score`) and `skips[]`. The receiver is part of the portal (`portal.md`
  section 9).

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
    `sessions`, recorded in the database, and judges are told scoring closed.
  - Scoring cannot close with no scores at all: if nobody scored a competitor,
    the session stops and waits. `skip <sessionId>` then skips that competitor
    (recorded as a skip), or `reopen <sessionId>` asks the judges again.
  - `hold <sessionId>` pauses it: what is under way finishes, nothing new starts
    until `release <sessionId>`. A hold survives a restart.
  - `cancel <sessionId>` drops a session for good (running or not yet run):
    every page is told, it is never run, and the track moves on to its next
    session. There is no abort.
  - Judges have `JUDGE_SCORE_TIMEOUT_MS` (default 60000) to score; set
    `PERFORMANCE_TIMEOUT_MS` to cap a performance (default: no limit).
  - The DJ presses **Enable audio** once after opening the page; browsers block
    playback until then. A performance that starts earlier waits for the click.
- Sessions run themselves: each track arms its next session (at start-up, after
  the DJ ends a session, after a cancel). A session cannot begin before its
  planned time: the DJ's **Start competition** button counts down to it, and when
  the track runs late the scoreboard shows the expected time ("about 14:25,
  planned 14:00"). `ARMING=0` turns this off; then start a session by hand with
  `POST /sessions/<id>/start` and `Authorization: Bearer $ADMIN_TOKEN`.
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
| `deno task test:e2e` | browser tests (Playwright) driving the real pages, with the e2e bundle | yes (schema loaded) |

- Integration tests skip themselves without `DATABASE_URL`. Set `REQUIRE_DB=1`
  to make a missing database a failure (CI does).
- The bundles are built with `deno bundle`, whose output depends on the Deno
  version, so `deno task static` fails if `public/` is stale: run `deno task
  build` and commit. CI pins the Deno version in `.github/workflows/ci.yml`.
- Fix formatting with `deno task fmt`.

### Database for the integration and browser tests

With Docker (Postgres on localhost:5432; schema loaded):

```sh
./tools/run-e2e.sh              # up -> load schema -> browser tests -> down
TEARDOWN=0 ./tools/run-e2e.sh   # leave the database running afterwards
```

or step by step:

```sh
deno task docker:postgres:compose:up
deno task docker:postgres:db-init      # the schema
export DATABASE_URL=postgres://postgres:test@localhost:5432/test_db
deno task test:e2e                     # builds the bundles, starts the app, runs Playwright
docker compose -f docker/docker-compose.yml down -v   # reset completely
```

To run the Deno suite (unit, frontend, contract, integration) the same way:

```sh
./tools/run-tests.sh              # Docker Postgres -> empty schema-only database -> deno task test
./tools/run-tests.sh test:integration   # or any single task
TEARDOWN=0 ./tools/run-tests.sh   # leave the database running afterwards
```

It uses a separate schema-only database (`test_empty`) because the compose
default database may hold what a browser-test run left behind, and the contract
and integration tests expect empty tables.

Without Docker, point `DATABASE_URL` at any Postgres and load
`docker/postgres/db-init/01_schema.sql` with `psql`. The integration tests need
**empty tables** (they bring their festival and clean up after themselves). The
browser tests run the server with the committed e2e bundle
(`fixtures/bundles/e2e`: session 1, competition 10, judges 2/3; regenerate with
`deno task fixtures` after changing `scripts/fixtures.ts`). Playwright starts the
app on port 8000 (`E2E_PORT` to change), or reuses one already running there.

## Admin page

Open `/admin` (for example `http://localhost:3000/admin`) and sign in with the
admin token (`ADMIN_TOKEN`). The token is entered once into a form; the server
answers with a separate `HttpOnly`, `SameSite=Strict` cookie that expires after 12
hours, so the token never appears in a URL or the page. The command-line tool keeps
using the bearer token. The header also shows the state of the cloud copy.

- **Festival tab**: the whole festival as a tree with a hide/reveal triangle at every
  level: festival, track, session, competition, competitor. Upcoming, in progress and
  finished are shown in grey, amber and green (and as text, not colour alone).
  Everything refreshes every three seconds; which triangles are open is remembered.
- **Sessions** have Start (by hand), Skip, Re-open scoring, Hold/Release and Cancel
  (Skip stops waiting for whatever the session is stuck on; Re-open scoring is for a
  competitor nobody scored), what the running session is doing, who it is waiting
  for, and the expected start when the track runs late.
- **Competitors** show how many judges have scored them and whether the bundle has
  their announcement and music audio.
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
signed in as its own device, with buttons to start, skip, cancel and reset the
session. It is off unless `DEMO=1` (it hands out sign-in links to whoever holds
the admin token), so never enable it in production.

```sh
# 1. a database with the schema (a fresh one: it pairs with the demo bundle)
export DATABASE_URL=postgres://postgres:test@localhost:5432/demo_db
psql "$DATABASE_URL" -f docker/postgres/db-init/01_schema.sql
deno task demo:bundle        # fixtures/bundles/demo: one track, one session, two competitions,
                             # five competitors with generated tones, two judges

# 2. the server in demo mode, with the demo bundle
ADMIN_TOKEN=demo deno task demo

# 3. open the page (it moves itself to lvh.me, see below)
open "http://localhost:3000/demo?token=demo"
```

In the page: wait for the DJ frame to say *Audio ready* (it downloads the bundle's
audio: a short beep and a tone melody per competitor), click **Enable audio** in
the DJ frame once, then **Start session**. For each act the DJ frame plays the
announcement; press **play** there to start the song (it never starts by itself),
or **skip** to move on to the next competitor. When the song ends the judges get
sliders and the scoreboard fills in. **Reset** clears the session's scores, skips
and progress to run it again. The demo festival is defined in `scripts/fixtures.ts`
(ids 1000+). Use `&session=<id>` to demo a different session of the loaded bundle.

**Why `lvh.me`?** A device is identified by one cookie and cookies are shared by
everything on a host, so four frames on `localhost` would all be the same device.
The page puts each frame on its own subdomain (`dj.lvh.me`, `judge1.lvh.me`, ...;
`lvh.me` resolves to 127.0.0.1) and keeps them same-site with the page, so the
`SameSite=Strict` cookie works unchanged. Offline, add
`127.0.0.1 scoreboard.lvh.me dj.lvh.me judge1.lvh.me judge2.lvh.me lvh.me` to
`/etc/hosts`, or set `DEMO_DOMAIN` to a domain you control.

