# CLAUDE.md

Scoring app for dance competitions. One central Deno server talks to a fixed set
of clients over **SSE (server → client)** and **`fetch` POST (client → server)**:
DJs (play the music), judges (score), and scoreboards (display). WebSockets were
tried and abandoned; SSE + fetch is deliberate (see "Decisions").

Runtimes are kept separate: **Deno** = app, build, most tests. **Node** = only the
Playwright browser tests in `node-tests/`. **Docker** = Postgres.

## Commands

```sh
deno task static        # type-check + lint + fmt check + "committed bundles are current"
deno task test          # unit -> frontend -> contract -> integration (stops on first failure)
deno task test:unit | test:frontend | test:contract | test:integration
deno task test:e2e      # Playwright, needs DATABASE_URL with schema AND seed (see README)
./tools/run-e2e.sh      # same, with Docker providing Postgres
deno task build         # rebuild public/*.js (tracked in git; deno bundle)
deno task fmt           # fix formatting (covers app/ and scripts/ only)
deno task demo          # DEMO=1 server + /demo page (see "Demo"); deno task demo:seed loads its data
deno task dev           # run the server, restarting on file changes (needs ADMIN_TOKEN, DATABASE_URL to be useful)
ADMIN_TOKEN=... deno task links issue --tracks 1,2 --judges 2,3   # see "Operating"
```

Always check **exit codes**, not just "N passed" (see Gotchas). Environment:
`DATABASE_URL`, `ADMIN_TOKEN` (admin routes return 503 without it), `PORT`
(3000), `PUBLIC_URL` (base for issued links), `JUDGE_SCORE_TIMEOUT_MS` (60000),
`PERFORMANCE_TIMEOUT_MS` (0 = none), `AUDIO_DIR` (./audio, gitignored), `MAX_AUDIO_BYTES` (50 MB), `AUDIO_CUTOFF_MINUTES` (30), `REQUIRE_DB=1` (integration tests fail
instead of skipping), `E2E_PORT` (8000), `DEBUG=1`.

## Layout

```
app/src/            server
  main.ts           routes, auth middleware, admin API, /response, shutdown
  session.ts        Session: phases, waits, replay-on-connect, abort/skip, status
  sessionManager.ts sessions map; findConflict (one session per track, judges held)
  sse.ts            per-connection lifecycle (identity-guarded cleanup, ping)
  responseService.ts  /response logic (validate, ownership, scores); route stays thin
  audioStorage.ts   AudioStorage interface + disk impl (swap for a bucket later)
  audioLibrary.ts   upload validation (sniffs mp3/wav), metadata, missing()
  adminAuth.ts      admin cookie sessions;  adminOverview.ts  festival tree for /admin;  adminTypes.ts  shared shapes
  demo.ts           DEMO=1 only: /demo page (4 frames), demo audio, reset
  sha256.ts         sha256 with a pure-JS fallback (no crypto.subtle on plain http)
  audioManifest.ts  frozen per-session file list + digest;  audioAnnouncer.ts  audio_available ticks
  resolveTag.ts     waitForTag/resolveTag rendezvous (takes AbortSignal)
  contract.ts       tag builders + payload validation, shared with the browser
  credentials.ts    admin-issued credentials (hashes only), in-memory cache
  protocol.ts types.ts db.ts
app/frontend-src/   browser code (TS) + the three HTML pages (dj, jd, sb)
  connect.ts        ResilientEventSource, whoami/connect/bootstrap, postResponse
  sseClient.ts (base) dj.ts jd.ts sb.ts   main-{dj,jd,sb,admin}.ts (bundle entry points)
  admin.html/admin.ts/adminView.ts   the admin page (adminView = pure render functions)
public/             built bundles dj.js jd.js sb.js (generated, tracked)
app/tests/          unit/ frontend/ contract/ integration/ + auth-utils.ts test-utils.ts
node-tests/         Playwright (Node only): e2e/pages.spec.ts, playwright.config.ts
docker/             docker-compose.yml, postgres/db-init/{01_schema,02_seed}.sql
scripts/            build_artifacts.ts, issue-links.ts (operator CLI)
tools/              e2e.sh, run-e2e.sh
.github/workflows/ci.yml   static / tests / e2e jobs
```

## How it works

**Identities** (`dj<trackId>`, `sb<trackId>`, `judge<judgeId>`) come from
admin-issued links, never from the URL. `GET /join/<secret>` sets an HttpOnly
`session_token` cookie (the secret itself; only its SHA-256 is stored in
`client_credentials`) and redirects to `/dj`, `/judge` or `/scoreboard`. Pages call
`GET /session` to learn who they are. Revocation is immediate (server-side lookup).
Admin = `Authorization: Bearer $ADMIN_TOKEN`.

**Sessions.** `POST /sessions/:id/start` (admin) loads competitions from the DB and
runs `Session.runSession` in the background. **One running session per track**
(DJ and scoreboard are the track's permanent clients). A judge is **held by a
session until it ends** (`claimedClients`); a second start that needs a held judge
or a busy track gets 409. Multiple tracks run concurrently.

**Flow per competitor:** `performance_start` (all) -> DJ plays -> DJ POSTs
`perf:<comp>:<position>` (true = done, false = skipped) -> `enable_scoring`
(judges only) -> each judge POSTs `score:<comp>:<competitor>:<judge>` -> server
validates against the rubric, rounds to 1 decimal, upserts to `scores`, sends
`score_update` to **scoreboards only**. Judges never see each other's scores.

**Progress is persisted** (best effort, in order, via `recordProgress` in `db.ts`):
`sessions.status` (active; completed, or back to `upcoming` if aborted/failed),
`competitions.status`, `sessions.current_competition/competitor`,
`tracks.current_session`. Issuing a credential returns 404 if the judge/track
doesn't exist.

**Audio.** Bytes on disk in `AUDIO_DIR` (content-addressed `<sha256>.<ext>`),
metadata in `audio_files` (one row per competition/competitor/kind, kind =
`announce`|`music`). Order of events for a session:
1. Uploads (`PUT /admin/audio/:competition/:competitor/:kind`, admin, raw mp3/wav;
   the portal must reuse `audio.add` and this rule) are open until the **cut-off**:
   `sessions.start_time - AUDIO_CUTOFF_MINUTES`, or the session starting, whichever
   is first. After that 409, except admin `?force=1` (logged; never during a run).
2. After the cut-off the set is final. `GET /audio-manifest` (DJ only) returns the
   next session's files + a `digest` (425 + `available_at` before the cut-off). The
   server announces it with the small SSE event `audio_available` (ticker every
   15 s, once per connection/change; audio itself never travels over SSE).
3. The DJ page (`audioCache.ts`) downloads each file over HTTP, verifies sha256 +
   size, stores it in Cache Storage under its hash (a replaced song = new key, old
   one evicted), shows "Audio: N/M ready", plays from the local copy (network URL
   as fallback), and POSTs `/audio-ready {digest}` when it holds everything.
4. `runSession` waits (as `audio:dj<N>` in `waiting_for`; operator `skip` releases
   it) until that DJ's reported digest equals the expected one. Sessions with no
   audio are not gated.
`GET /audio/:competition/:competitor/:kind` serves files (Range supported) to the
DJ of that track only. `/start` lists `missing_audio` but does not block.

**Admin page.** `GET /admin` (page, no login needed to load) + `/js/admin.js`. Browser
sign-in: `POST /admin/login {token}` -> random session id in the `admin_session`
cookie (HttpOnly, SameSite=Strict, 12 h, in memory; `/admin/logout`, `/admin/me`).
`requireAdmin` accepts the bearer token (CLI) or that cookie; a cookie-authenticated
change must also send `x-admin-request: 1`. `GET /admin/overview` returns the whole
tree (`adminOverview.ts`: festival > track > session > competition > competitor, with
statuses, live session state, judges, audio flags, connected devices and active links).
Statuses map `upcoming|active|completed` -> upcoming|in_progress|finished; a competitor
is finished when every rubric judge has scored it. The page is vanilla TS: pure
functions return HTML strings (every value through `escapeHtml`), native `<details>`
gives the triangles, QR codes come from the JSR package `@libs/qrcode` (SVG, no dependencies), and
Copy falls back to select-and-copy because `navigator.clipboard` needs https/localhost.
Browser bundles must stay reproducible across machines: prefer JSR packages (bundled by
URL); an npm dependency makes `deno bundle` embed the machine's npm-cache path, which is
why `scripts/normalize_bundle.ts` rewrites those paths (CI failed on this once).
Use `credentials.all()` (not `list()`) to list links: it loads from the database first.
Tests: `adminAuth`/`adminOverview`/`credentials` (unit), `adminView` (frontend),
`admin.contract` (login/cookie/CSRF), the overview in the integration suite, and
`node-tests/e2e/admin.spec.ts`.

**Demo (development only).** `DEMO=1` enables `GET /demo?token=<ADMIN_TOKEN>&session=<id>`
(default session 1000 = `docker/postgres/demo/demo_seed.sql`, ids 1000+, loaded with
`deno task demo:seed`, deliberately not in `db-init/`). One tab, four iframes
(scoreboard, DJ, two judges), each a separate device. Cookies are per host, so the
frames use sibling hosts of `DEMO_DOMAIN` (default `lvh.me` -> 127.0.0.1): own cookie
each, yet same-site with the page so `SameSite=Strict` still works. The page issues
fresh credentials (labelled `demo`; old ones are revoked) and has buttons that call
the admin API plus `POST /demo/audio/:id` (generated tones) and `POST /demo/reset/:id`.
The browser test is `node-tests/e2e/demo.spec.ts` (Chromium maps `*.lvh.me` to
127.0.0.1, no DNS needed).

**Insecure origins.** `caches` (Cache Storage) and `crypto.subtle` exist only on https
and localhost. A DJ laptop opened by LAN address over http has neither, so the
prefetcher falls back to an in-memory cache (reload re-downloads) and `sha256.ts`
computes hashes in JS. Without that the start gate would wait forever for the DJ's
ready report. Prefer https or `localhost` for real events.

**Client -> server contract** (`contract.ts`): `POST /response {tag, payload}`.
Ownership is enforced (only the session's DJ answers `perf:*`; only `judge<N>`
answers `score:*:N`); JSON content-type required. Codes: 404 window closed / no
waiter, 403 not yours, 400 invalid, 401 revoked.

**Events** (server -> client): `client_status, competition_start, performance_start,
performance_recovery, enable_scoring, score_update, scoring_closed,
performance_skipped, session_end, superseded, ping`.

**Reconnects:** on every connect the server *replays current state as the normal
events* (DJ gets `performance_recovery`, not `performance_start`, so the
announcement isn't repeated; scoreboards also get scores so far). Client handlers
must therefore be **idempotent** (judge keeps sliders, DJ ignores recovery for the
performance it is already handling). `ResilientEventSource` adds a 45 s watchdog
(server sends a real `ping` event), backoff reopen, stops on `superseded` (second
tab) or a revoked credential. A second connection with the same id supersedes
the first; stale-stream cleanup only acts if the closing stream still owns the slot.

**Operating** (`deno task links ...`, needs `ADMIN_TOKEN`, `--base <url>`):
`issue --tracks 1,2 --judges 2,3` (links shown once), `list`, `revoke <id>`,
`sessions` (phase, waiting_for, missing scores), `skip <sessionId>` (stop waiting
for missing clients / skip performance / close scoring), `abort <sessionId>`.
Missing judge scores are recorded in memory as `timeout|closed|absent`.
SIGTERM aborts sessions, notifies clients, closes the DB pool.

**Durations are SECONDS** (`competition_competitors.duration`); converted in the
client only.

## Decisions (and why)

- SSE + fetch, not WebSockets: traffic is asymmetric and tiny; `EventSource`
  reconnects for free; every POST gets an HTTP status. Reliability comes from
  replay-on-connect + watchdog, not from the transport.
- Admin-issued links, not a shared PIN: per-device revocation matters for a scored
  event. Cookie holds the opaque credential (no JWT, no expiry/refresh logic).
- Tags are global, not per-session: competition ids are DB-unique; the real
  collision risk (`required:<clientId>`) is handled by the one-session-per-track
  and held-judge rules, and `waitForTag` rejects a duplicate wait.
- Committed `public/*.js` bundles + a CI staleness check. Deno version is pinned in
  `ci.yml` (`DENO_VERSION`) because `deno bundle` output depends on it.

## Gotchas

- **`deno test` can print "ok | N passed" and still exit 1** with
  `Promise resolution is still pending`: a test that never finished isn't counted.
  This hid two hanging tests for several phases. Check `$?`.
- FakeTime does not advance timers registered after a promise continuation; prefer
  injectable delays (`postResponse(body, delays)`) to fake timers for retry logic.
- Chromium's `setOffline` does not break an open EventSource. Browser tests drop a
  connection by `close()` + dispatching `error` on the wrapped EventSource.
- macOS: `sed -i ''` (not `-i`); `deno fmt` reflows HTML (fmt is scoped to
  `app/` + `scripts/`, excluding `app/frontend-src/*.html`).
- Browser tests share session id 1 and one DB: run serially, and every test must
  `abort` its session in `finally` (helper `finish()`), or the next test breaks.
- After the last judge scores in the one-competitor seed the session ends at once,
  so a judge's status can read "Session complete", not "Scores submitted".
- DJ audio needs a click: the DJ presses **Enable audio** once; earlier
  performances wait for it. E2E uses `--autoplay-policy=no-user-gesture-required`.
- Local scratch Postgres (macOS/Homebrew): `initdb -D d -U postgres --auth=trust`;
  start with `LC_ALL=en_US.UTF-8 pg_ctl -D d -o "-p 54329 -k /tmp/pgs" start`
  (needs the locale and a short socket dir). Integration DB = schema only (empty
  tables); browser DB = schema + seed. The binaries are under
  `/opt/homebrew/opt/postgresql@17/bin` (not on PATH). The Deno tests connect over
  TCP, so also start with `-c listen_addresses=127.0.0.1` and use
  `DATABASE_URL=postgres://postgres@127.0.0.1:54329/<db>`; a unix-socket `?host=`
  URL does not work with the driver. Run the whole suite both with and without
  `DATABASE_URL` (CI sets it for every job): `REQUIRE_DB=1 DATABASE_URL=... deno task test`.
- Contract tests run with `DATABASE_URL` set but an empty schema in CI, so
  `auth.contract.test.ts` replaces `clientCheck.exists` (the "does this judge/track
  exist" check on credential issue) with a stub. Do the same in any new contract
  test that issues credentials for ids the schema doesn't contain.
- Browser tests: the Playwright server needs `--allow-write` and `AUDIO_DIR` (set in
  `node-tests/playwright.config.ts`), and `setup()` uploads real silent WAVs with
  `?force=1` because the seed's session start is already past the audio cut-off.
  Kill any leftover `app/src/main.ts` server before a run (`reuseExistingServer`).
- Never log credentials: `/join/<secret>` is redacted in the request log.

## Repo conventions

`.vscode/copilot-instructions.md` states the rules to keep (public/ and the HTML
allowlist are all that is served; DB access via `db.ts`; thin route handlers; Node
only for Playwright) and matches the current layout. The server serves the three
HTML pages from `app/frontend-src` through an explicit allowlist of routes (not a
static mount). Keep new code within the spirit of those rules; ask before restructuring.

## Status

Phases 0-7 of the "make it correctly functioning" plan are done and committed.
Since then (latest: `8c4b4ff`): `/response` extracted to a service, session
progress persisted, FKs on `rubric_judge_criteria`, credential issue checks the
judge/track exists, and competitor audio (storage, cut-off, manifest, DJ prefetch,
start gate). Suites: ~101 unit, ~86 frontend, 27 contract, 9 integration (with a
DB), 7 browser tests; all green with exit code 0, with and without a database.
`deno task static` only passes once generated `public/*.js` is committed.

Working style (owner): analysis only when asked to analyse; commit only when asked.

## Open items (next session)

1. **Audio, next steps.** Decide whether a missing announce is fatal (recommended:
   skip only the announcement and still play the music; today the DJ page fails the
   performance and it is reported as skipped); transcode/
   normalise loudness; the competitor portal (accounts, registration, uploads via
   `audio.add`, `audio_files.owner_user_id`); the DJ report map is in memory (DJ
   re-reports on its next sync); `sessions.start_time` must be accurate for the
   cut-off to mean anything (seed data uses NOW(), i.e. already past).
2. **Server restart loses the running session** (in-memory). Idea: on start, skip
   competitors already fully scored. Needs a decision from the owner: after a
   restart, should "start" resume where it left off, or begin again and skip the
   already-scored competitors?
3. Missing-judge-score records are in memory only; persist if results/audit need them.
4. Single-instance assumption: the revocation cache is in process memory.
5. CI: `ci.yml` has run on GitHub and is green (run for `9b4409a`: static, tests,
   browser tests; browser job ~7 min). Still open: `tools/run-e2e.sh` (Docker) is
   unverified because Docker wasn't running; `.vscode/tasks.json` references a missing
   `start-debug-session.sh`; Actions warns that `actions/checkout@v4` targets Node 20
   and that `ubuntu-latest` moves to Ubuntu 26 on 2026-10-19 (bump/pin when convenient).
