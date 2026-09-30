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
deno task dev           # run the server (needs ADMIN_TOKEN, DATABASE_URL to be useful)
ADMIN_TOKEN=... deno task links issue --tracks 1,2 --judges 2,3   # see "Operating"
```

Always check **exit codes**, not just "N passed" (see Gotchas). Environment:
`DATABASE_URL`, `ADMIN_TOKEN` (admin routes return 503 without it), `PORT`
(3000), `PUBLIC_URL` (base for issued links), `JUDGE_SCORE_TIMEOUT_MS` (60000),
`PERFORMANCE_TIMEOUT_MS` (0 = none), `REQUIRE_DB=1` (integration tests fail
instead of skipping), `E2E_PORT` (8000), `DEBUG=1`.

## Layout

```
app/src/            server
  main.ts           routes, auth middleware, admin API, /response, shutdown
  session.ts        Session: phases, waits, replay-on-connect, abort/skip, status
  sessionManager.ts sessions map; findConflict (one session per track, judges held)
  sse.ts            per-connection lifecycle (identity-guarded cleanup, ping)
  responseService.ts  /response logic (validate, ownership, scores); route stays thin
  resolveTag.ts     waitForTag/resolveTag rendezvous (takes AbortSignal)
  contract.ts       tag builders + payload validation, shared with the browser
  credentials.ts    admin-issued credentials (hashes only), in-memory cache
  protocol.ts types.ts db.ts
app/frontend-src/   browser code (TS) + the three HTML pages (dj, jd, sb)
  connect.ts        ResilientEventSource, whoami/connect/bootstrap, postResponse
  sseClient.ts (base) dj.ts jd.ts sb.ts   main-{dj,jd,sb}.ts (bundle entry points)
public/             built bundles dj.js jd.js sb.js (generated, tracked)
app/tests/          unit/ frontend/ contract/ integration/ + auth-utils.ts test-utils.ts
node-tests/         Playwright (Node only): e2e/pages.spec.ts, playwright.config.ts
docker/             docker-compose.yml, postgres/db-init/{01_schema,02_seed}.sql
scripts/            build_artifacts.ts, issue-links.ts (operator CLI)
tools/              e2e.sh, run-e2e.sh, init-test-db.sh
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
  tables); browser DB = schema + seed.
- Never log credentials: `/join/<secret>` is redacted in the request log.

## Repo conventions

`.vscode/copilot-instructions.md` and `.vscode/system.md` describe the intended
structure (public/ is the only served directory; DB access via an adapter layer; no
business logic in route handlers; Node only for Playwright). The repo differs in
places: source dir is `app/frontend-src` (not `artifacts-src`), compose file is
`docker/docker-compose.yml`, and the server serves the three HTML pages from
`app/frontend-src` through an explicit allowlist of routes (not a static mount).
Keep new code within the spirit of those rules; ask before restructuring.

## Status

Phases 0-7 of the "make it correctly functioning" plan are done and committed
(latest: `d05e436` Phase 7). Suites: ~90 unit, ~79 frontend, 27 contract, 6
integration, 7 browser tests; all green with exit code 0.

## Open items (next session)

1. **Audio files are not served.** The DJ page requests
   `/<competitionId>-<competitorId>-announce` and `-music` from the server root;
   there is no route and no files, so a real performance 404s and is reported as
   skipped. Proposed: `GET /audio/<name>` from `AUDIO_DIR`, DJ page uses `/audio/...`,
   and `/start` reports competitors with missing audio up front. Need from the owner:
   where the music comes from and its format (mp3/wav).
2. **Server restart loses the running session** (in-memory). Idea: on start, skip
   competitors already fully scored. Needs a decision on what "start" means.
3. Missing-judge-score records are in memory only; persist if results/audit need them.
4. Single-instance assumption: the revocation cache is in process memory.
5. Never run on GitHub: `ci.yml` was validated (YAML + running each job's commands
   locally) but not executed there. `tools/run-e2e.sh` (Docker) is unverified because
   Docker wasn't running. `.vscode/tasks.json` references a missing
   `start-debug-session.sh`.
