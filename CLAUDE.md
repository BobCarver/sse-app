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
deno task test:e2e      # Playwright with the e2e bundle, needs DATABASE_URL with the schema (see README)
./tools/run-e2e.sh      # same, with Docker providing Postgres
./tools/run-tests.sh    # deno task test with Docker Postgres (schema-only DB; `... test:unit` for one task)
deno task build         # rebuild public/*.js (tracked in git; deno bundle)
deno task fmt           # fix formatting (covers app/, scripts/ and shared/ only)
deno task demo          # DEMO=1 server + /demo page with the demo bundle (see "Demo"); deno task demo:bundle makes it
deno task fixtures      # regenerate the committed e2e bundle (fixtures/bundles/e2e) from scripts/fixtures.ts
deno task dev           # run the server, restarting on file changes (needs a bundle; ADMIN_TOKEN, DATABASE_URL to be useful)
ADMIN_TOKEN=... deno task links issue --tracks 1,2 --judges 2,3   # see "Operating"
ADMIN_TOKEN=... deno task links push [--final]   # send the scores to the portal now (see "Cloud copy")
```

Always check **exit codes**, not just "N passed" (see Gotchas). Environment:

- Server: `DATABASE_URL`, `ADMIN_TOKEN` (admin routes return 503 without it), `PORT`
  (3000), `PUBLIC_URL` (base for issued links), `BUNDLE_DIR` (./bundle: manifest.json +
  data.json), `AUDIO_DIR` (./audio, gitignored: the bundle's audio files), `DEBUG=1`.
- Timing: `JUDGE_SCORE_TIMEOUT_MS` (60000), `PERFORMANCE_TIMEOUT_MS` (0 = none),
  `ALLOWANCE_ANNOUNCE_S` / `ALLOWANCE_SCORING_S` / `ALLOWANCE_CHANGEOVER_S` (20/30/45,
  per-competitor seconds for the delay estimate).
- Running the day: `ARMING` (0 = sessions do not arm themselves; also off with `DEMO=1`),
  `DJ_GATES` (0 = no DJ start/end buttons; tests and e2e set it).
- Cloud copy: `CLOUD_URL` (https; http for localhost only), `CLOUD_TOKEN`,
  `CLOUD_PUSH_INTERVAL_S` (300). Off without `CLOUD_URL`.
- Demo: `DEMO=1`, `DEMO_DOMAIN` (lvh.me), `DEMO_SESSION` (1000).
- Tests and tools: `REQUIRE_DB=1` (integration tests fail instead of skipping),
  `E2E_PORT` (8000), `BASE_URL` (the `links` CLI's server, default http://localhost:3000).

## Layout

```
app/src/            server
  main.ts           routes, auth middleware, admin API, /response, shutdown
  session.ts        Session: phases, waits, replay-on-connect, skip/hold/release/cancel, status
  sessionManager.ts sessions map; findConflict (one session per track); JudgeClaims (per competition)
  sequencer.ts      arms each track's open session (boot, after End session, after cancel)
  sessionStarter.ts SessionStarter: plan, take the track (memory + DB lock), register atomically, run; deps injected (unit-tested without a DB); wired in main.ts (wireSession)
  estimate.ts       delay estimate: cascading expected starts (allowances per competitor)
  sse.ts            per-connection lifecycle (identity-guarded cleanup, ping)
  responseService.ts  /response logic (validate, ownership, scores); route stays thin
  audioStorage.ts   AudioStorage interface + disk impl (swap for a bucket later)
  bundle.ts         load + verify the festival bundle (BundleError lists every problem)
  festival.ts       the loaded festival in memory (sessions, rubrics, judges, audio); festival()/setFestival()
  progress.ts       the cursor and deriveStatus (statuses are derived, not stored);  resume.ts  planResume
  audioLibrary.ts   read-only view of the bundle's audio (metadata from festival.ts), missing()
  adminAuth.ts      admin cookie sessions;  adminOverview.ts  festival tree for /admin;  adminTypes.ts  shared shapes
  demo.ts           DEMO=1 only: /demo page (4 frames), reset
  sha256.ts         sha256 with a pure-JS fallback (no crypto.subtle on plain http)
  cloudPush.ts      cloud copy: snapshot push of scores + skips (when a competition/session ends, digest skip, backoff, final push)
  audioManifest.ts  the track's file list + digest;  audioAnnouncer.ts  audio_available ticks
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
shared/festival-bundle/  the bundle format, shared with the portal: types, validator,
                    canonical serialiser, digest, rubric resolution (+ its tests); std lib only
fixtures/bundles/   e2e/ (committed) and demo/ (generated, gitignored) festival bundles
docker/             docker-compose.yml, postgres/db-init/01_schema.sql
scripts/            build_artifacts.ts, issue-links.ts (operator CLI), fixtures.ts (e2e + demo bundles)
tools/              e2e.sh, run-e2e.sh, run-tests.sh
.github/workflows/ci.yml   static / tests / e2e jobs
```

## How it works

**Identities** (`dj<trackId>`, `sb<trackId>`, `judge<judgeId>`) come from
admin-issued links, never from the URL. `GET /join/<secret>` sets an HttpOnly
`session_token` cookie (the secret itself; only its SHA-256 is stored in
`client_credentials`) and redirects to `/dj`, `/judge` or `/scoreboard`. Pages call
`GET /session` to learn who they are. Revocation is immediate (server-side lookup).
Admin = `Authorization: Bearer $ADMIN_TOKEN`.

**The festival bundle** (redesign Phase 1; `redesign.md`, `portal.md` section 5). The
structure (tracks, sessions, competitions, rubrics, judges, competitors, audio) comes from
a static bundle made by the portal: `BUNDLE_DIR/manifest.json`, `BUNDLE_DIR/data.json`
(nested tree; rubrics listed once under the festival, competitions name theirs by
`rubric_id`) and `AUDIO_DIR/<sha256>.<ext>`. At boot (`loadFestival` in `main.ts`)
`bundle.ts` verifies everything (shape, strict `order_number` at every level, references,
`data_sha256`, `digest`, every audio file's size and sha256) and the server exits with
the list of problems if anything is wrong. `pairBundle` (`db.ts`) records the bundle's
digest and exact `data.json` text in `festival_bundle` on first use; a different bundle
is refused once anything has run (scores, session_runs, skips, missing scores, an open
track). The festival is held in memory (`festival()` in `festival.ts`) and never
written; the structure tables are gone from the schema (an old database keeps them,
unread). `shared/festival-bundle/` is the format, shared with the portal (types,
`validateData`/`validateManifest`, `canonicalData`, `makeManifest`, `bundleDigest`,
`resolveSession`). Test and demo festivals are defined in `scripts/fixtures.ts`.
Issuing a credential returns 404 if the judge/track is not in the bundle. The bundle
carries no emails, so the admin page's judges have none.

**Persistence: what Postgres holds** (`docker/postgres/db-init/01_schema.sql`; the
structure is never stored, it comes from the bundle). `festival_bundle` (the paired
bundle's digest + exact `data.json`), `scores` (one row per judge, competitor and
criterion, upserted), `track_progress` (one row per track: the open session = the lock,
and the cursor), `session_runs` (opened/started/finished/cancelled/held times),
`skips` and `missing_scores` (append-only audit), `client_credentials` (hashes only).
No foreign keys to the structure: ids are checked against the loaded bundle in code.
The server holds in memory only what can be rebuilt: the festival, live sessions, the
revocation cache, audio reports, the cloud copy's state. A restart resumes at the cursor.

**Sessions run themselves** (redesign Phase 3; `sequencer.ts`). Each track always has its
**open session armed**: the one holding the track, else the first in running order (planned
start, then `order_number`) not finished or cancelled. Arming = `SessionStarter.start` (`sessionStarter.ts`, wired in `main.ts`)
(load from the festival, take the track, register DJ and scoreboard, wait for clients, audio
gate, planned-time gate, the DJ's begin gate). The sequencer arms at boot (which also resumes
a session a crash or shutdown cut off: no audio gate when it had started), after a session
ends normally (End session) and after a cancel; an error or shutdown is not re-armed (no
restart loop). It is on when the server is started directly, off with `ARMING=0` or
`DEMO=1`. `POST /sessions/:id/start` (admin) still starts one by hand (tests, demo).
**One open session per track**, enforced in the database: the track's `track_progress` row
is the lock (`openSession`), taken when armed and given back when the session finishes, is
cancelled, or is stopped before anything ran. A second session on a held track gets 409
"Track N has session M open", also after a restart. A finished or cancelled session is not
started again (409). DJ and scoreboard are the track's permanent clients. **Judges are
claimed per competition** (`JudgeClaims` in `sessionManager.ts`): when its start gate opens
(after the planned start) and given back (into the unassigned pool) when it ends. A judge
another track holds is waited for, shown as `judge<N> (held by track <T>)` in `waiting_for`;
`skip` goes on without them (excused: recorded `absent`). The session tells every judge who
took part when it ends (`session_end`). Multiple tracks run concurrently.

**Planned start.** A session's first competition cannot begin before its planned
`start_time` (not a trigger: the DJ still presses Start). `competition_ready` carries
`starts_at` (null when already past) and `server_time`; the DJ page's button stays disabled
with a countdown by the server's clock (`countdown()` in `dj.ts`), the scoreboard says
"Competition “X” begins at HH:MM", the session waits (`planned start <iso>` in
`waiting_for`, not skippable) and `/response` answers 425 to an early `begin:`. A session
that had begun before a restart is not held back again. Long waits are slept in steps
(`setTimeout` fires at once beyond ~24.8 days).

**Delays cascade** (`estimate.ts`): a session starts at the later of its planned time and the
end of the one before it; the open session's remaining entries count their duration plus the
allowances. `session_finished.next_session_estimate` (null when on time; late = more than a
minute after planned) gives "about 14:25 (planned 14:00)" on the scoreboard and DJ page; the
admin overview has `estimated_start` per session.

**Operator exceptions**: `skip` (as before), **hold** (`POST /admin/sessions/:id/hold`:
whatever is under way finishes, but no competition, performance, scoring or end starts until
**release**; `waiting_for` starts with `held by operator`; `session_runs.held_at`, so a
restart keeps it, and a session not running yet starts held) and **cancel** (drops it for
good: stops it if running, `session_end` reason `cancelled`, `cancelled_at` written, track
given back, the sequencer arms the next). There is **no abort** (the route is gone);
`Session.abort()` remains for the server shutdown.

**The DJ paces the session** (`djGates`, on unless `DJ_GATES=0`). Before every competition the
server sends `competition_ready {competition_id, name}` to all clients and waits for the DJ's
`begin:<competition>`: the scoreboard shows an orange banner "Competition “<name>” is about to
begin" over the dimmed last scores (gone at `competition_start`), and the DJ page shows a big
**Start competition: <name>** button (`#begin`). The wait runs while the judges connect, so an
early press is not lost. After the last competition the session does not end: it sends
`session_finished {session_id, next_session_name, next_session_start}` (the track's next
session by start time then order_number that has not finished, `followingSession`; null =
none), the scoreboard says
"Session ended. The next session begins at <time>" (it stays after `session_end`) and the DJ
button becomes **End session** (`close:<sessionId>`); then the session ends (`session_end`)
and the track moves on. Both gates replay on reconnect, show as `dj-start` / `dj-close` in
`waiting_for`, and an operator `skip` releases them (returns `"gate"`). A competition that was
already under way before a restart is not held again (resume plan). Only the session's DJ may
answer `begin:`/`close:` (403 otherwise). The DJ page is dark-themed like the other two.

**Flow per competitor:** `performance_start` (all) -> the DJ page plays the announcement,
then the song waits for the DJ to press **play** (it never autoplays; skip works at any
point) -> DJ POSTs `perf:<comp>:<position>` (true = done, false = skipped; a skip moves
on to the next competitor and is recorded in `skips`) -> `enable_scoring`
(judges only) -> each judge POSTs `score:<comp>:<competitor>:<judge>` -> server
validates against the rubric, rounds to 1 decimal, upserts to `scores`, sends
`score_update` to **scoreboards only**. Judges never see each other's scores.

**Scoreboard keeps the last result.** `sb.ts` does not clear on `performance_start` or
`competition_start`: the previous competitor's scores stay (labelled "Last scores: <name>"
in `#scoresFor`) until the first `score_update` for the competitor now on, which replaces
the board (and applies the next competition's judges/criteria, deferred as `pendingRubric`).
Scores for anyone not on now are ignored. A page loaded mid-performance has no previous
scores to show (the server replays only the current competitor's).

**Skipped performances.** `perf:` false (DJ skip, administrator skip, or the DJ not answering
within `PERFORMANCE_TIMEOUT_MS`) -> no scoring, the session goes on to the next competitor,
and a `skips` row is written (`stage` performance, `actor` dj or operator, `reason`; a
timeout or error counts as the DJ's, with the reason). The admin page shows skipped
competitors in purple (`Status` includes `skipped`). The DJ page's cleanup runs before it reports, and only if no
newer performance has taken over: the server starts the next performance the moment it hears
a skip, and cleaning up afterwards used to wipe the new one's audio listeners.
A missing or broken **announcement** is not a skip: the DJ page logs it and goes on to the
song (only a cancel by an administrator, or a broken song, reports `false`).

**Zero-score rule.** Scoring cannot close with no scores at all (a rubric with judges, and
none of them scored: all timed out, were closed out or absent). The session then stops at
that competitor (`phase` `unscored`, `waiting_for` "operator: no scores (skip or reopen)")
until the operator either skips it (`skip` returns `"unscored"`; a `skips` row with `stage`
scoring, `actor` operator, reason "no scores") or re-opens scoring (`reopen`: `POST
/admin/sessions/:id/reopen`, `deno task links reopen <id>`, admin page button; 409 when
there is nothing to re-open). Only a skip closes a competitor with no scores.

**Missing scores are persisted** (`missing_scores`, append-only): one row per judge per
competitor per miss, reason `timeout|closed|absent`. A later score from a re-opened judge
does not remove the row (the audit shows both). Also kept in memory for `sessions`.

**Progress is a cursor** (Phase 2; `track_progress`, one row per track): `open_session`,
cursor `competition_id`/`competitor_id` (the competitor in play or next to play) and
`phase` (NULL = not begun, `performing`, `scoring`). Everything before the cursor in running
order is finished, everything after it upcoming; statuses are derived (`deriveStatus` in
`progress.ts`), not stored. Each step is one row update (`recordProgress`, best effort, in
order): competitor started -> cursor here, performing; performed -> scoring; finalized or
skipped -> cursor moves to the next competitor (`next`, phase NULL; written and awaited
before the next one starts; a skip also appends to `skips`); no next = cursor empty (every
competitor done, the session waits to be ended). `session_runs` has the actual times:
`opened_at` (armed), `started_at` (first competition began), `finished_at`, `cancelled_at`,
`held_at`. A completed session writes `finished_at` and gives the track back. A shutdown or
error keeps the track (and cursor) unless nothing ran (`untouched`: no performance began,
nothing finished), so a session cut off is resumed and completed before the next one on its
track. The admin overview shows an armed session that has not begun as upcoming. A score that could not be saved no longer holds the
cursor back (it is logged and kept in `unsavedScores`).

**Start resumes at the cursor** (`resume.ts`, `planResume`). `POST /start` reads the
session's row (`getResumeRows`): not open -> from the top; open -> everything before the
cursor is finished; at the cursor `scoring` -> its scoring is **re-opened** with no new
performance (judges whose scores are saved keep them; scoreboards get them replayed);
`performing` or not begun -> it runs from its performance; no cursor -> only the end of the
session is left. A competition already under way (`underway`) does not show the DJ's start
button again. The response has `already_finished` and `reopened_scoring`.

**Audio.** Bytes on disk in `AUDIO_DIR` (content-addressed `<sha256>.<ext>`, copied with
the bundle), metadata from the bundle (each entry's `audio.music`/`audio.announce`; kind =
`announce`|`music`). There are no uploads on this server (the upload route and
`audio.add` are gone: the bundle is final; normalising and uploads are the portal's job).
Audio is per **track**: the bundle is final, so there is no cut-off and the set never changes.
Order of events:
1. `GET /audio-manifest` (DJ only, any time) returns the files of **all the track's
   sessions** in running order (`Festival.trackCompetitions`) + a `digest` of the set
   (`{track_id, digest, files}`). The server announces it with the small SSE event
   `audio_available` (ticker every 15 s, once per connection; audio itself never travels
   over SSE).
2. The DJ page (`audioCache.ts`) downloads each file over HTTP, verifies sha256 +
   size, stores it in Cache Storage under its hash (a file no longer in the set is
   evicted), shows "Audio: N/M ready", plays from the local copy (network URL
   as fallback), and POSTs `/audio-ready {digest}` when it holds everything.
3. The audio gate is checked once per day per DJ: the first session to arm waits (as
   `audio:dj<N>` in `waiting_for`; operator `skip` releases it) until that DJ's reported
   digest equals the track's digest. The report is kept in memory, so later sessions on
   the track pass at once (after a restart the page re-reports on reconnect; a resumed
   session is not gated). A track with no audio is not gated.
`GET /audio/:competition/:competitor/:kind` serves files (Range supported) to the
DJ of that track only. `/start` lists `missing_audio` but does not block.

**Cloud copy** (redesign Phase 5; `cloudPush.ts`, portal.md section 9). With `CLOUD_URL`
(https, or http for localhost only) and `CLOUD_TOKEN` set, a background `CloudPusher`
POSTs a snapshot **when a competition or a session ends** (`shouldPushAfter`, called from
the session's `recordProgress` in `main.ts` after the database write: the last competitor
of a competition finalized or skipped, session completed or cancelled; fire and forget)
and every `CLOUD_PUSH_INTERVAL_S` (300 s; first one 5 s after boot) as the retry and
catch-all, with `Authorization: Bearer $CLOUD_TOKEN`: `{festival_id, bundle_digest, digest, final,
sent_at, scores[{competition_id, competitor_id, judge_id, criteria_id, score}],
skips[...]}`, read in one repeatable-read transaction (`getCloudSnapshot`). The portal
replaces the festival's scores with it. Skipped when the snapshot digest (festival,
bundle, sorted scores and skips; not `sent_at`) equals the last one that arrived. Pushes run one at a time; one asked for meanwhile waits and then reads a fresh
snapshot. A
failure (network, timeout, non-2xx) never throws and never touches the event: it is
logged, shown as offline, and retried with backoff (interval x 2^failures, max 5 min).
`POST /admin/cloud/push {final}` / `deno task links push [--final]`: send now; `final`
always sends and is the authoritative upload after the event (502 with the reason if it
failed, 409 if not configured). `GET /admin/overview` has `cloud` (enabled, last sent,
last final, offline since, last error); the admin header shows it ("Cloud copy: last
sent 12 s ago" / "offline since ..."). Only scores and skips go (progress and times are
not sent yet). There is no receiver in this repo: the portal builds it (`portal.md`).

**Admin page.** `GET /admin` (page, no login needed to load) + `/js/admin.js`. Browser
sign-in: `POST /admin/login {token}` -> random session id in the `admin_session`
cookie (HttpOnly, SameSite=Strict, 12 h, in memory; `/admin/logout`, `/admin/me`).
`requireAdmin` accepts the bearer token (CLI) or that cookie; a cookie-authenticated
change must also send `x-admin-request: 1`. `GET /admin/overview` returns the whole
tree (`adminOverview.ts`: festival > track > session > competition > competitor, with
statuses, live session state, judges, audio flags, connected devices and active links).
Statuses are derived from the cursor (`deriveStatus`): before it finished (or skipped, from
`skips`), on it in progress once begun (finished once every rubric judge has scored),
after it upcoming. Sessions show "about HH:MM" when late and Held / Cancelled badges, and
have Start (by hand; disabled once finished or cancelled), Skip, Re-open scoring (enabled
while `unscored`), Hold/Release and Cancel; audio badges only show what the bundle has. The page is vanilla TS: pure
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
(default session 1000 of the demo bundle: `deno task demo:bundle` writes it to
`fixtures/bundles/demo` from `scripts/fixtures.ts`, ids 1000+, generated tones;
`deno task demo` runs with it). One tab, four iframes
(scoreboard, DJ, two judges), each a separate device. Cookies are per host, so the
frames use sibling hosts of `DEMO_DOMAIN` (default `lvh.me` -> 127.0.0.1): own cookie
each, yet same-site with the page so `SameSite=Strict` still works. The page issues
fresh credentials (labelled `demo`; old ones are revoked) and has buttons that call
the admin API plus `POST /demo/reset/:id` (deletes the session's scores, skips, missing
scores, `session_runs` row and track lock; the browser tests use it too).
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

**Events** (server -> client): `client_status, competition_ready, competition_start,
session_finished, performance_start,
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
for missing clients / skip performance / close scoring / skip an unscored competitor),
`reopen <sessionId>` (an unscored competitor: ask the judges again), `hold` / `release` /
`cancel <sessionId>`. SIGTERM stops sessions (an open session keeps its track and is resumed
at the next boot), notifies clients, closes the DB pool.

**Durations are SECONDS** (each competitor's `duration` in the bundle); converted in the
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
  `app/` + `scripts/` + `shared/`, excluding `app/frontend-src/*.html`). Bundle files
  in `fixtures/` are canonical JSON: never reformat them (their sha256 is in the manifest).
- Browser tests share session id 1 and one DB: run serially, and every test must
  cancel its session in `finally` (helper `finish()`), or the next test breaks. A
  cancelled or finished session cannot start again, so `setup()` in `pages.spec.ts`
  also resets session 1 (`POST /demo/reset/1`, needs `DEMO=1`). `DEMO=1` also keeps
  the sequencer off, so nothing arms itself during the browser tests.
- Integration tests that turn the sequencer on (`sequencer.enabled = true`) get the
  next session armed after one ends; `unseed()` turns it off and clears `judgeClaims`.
- After the last judge scores in the one-competitor e2e bundle the session ends at once,
  so a judge's status can read "Session complete", not "Scores submitted".
- DJ audio needs a click: the DJ presses **Enable audio** once; earlier
  performances wait for it. E2E uses `--autoplay-policy=no-user-gesture-required`.
- Local scratch Postgres (macOS/Homebrew): `initdb -D d -U postgres --auth=trust`;
  start with `LC_ALL=en_US.UTF-8 pg_ctl -D d -o "-p 54329 -k /tmp/pgs" start`
  (needs the locale and a short socket dir; or `-c unix_socket_directories=''` for
  TCP only). Integration and browser DBs = schema only. A database pairs with the
  first bundle that runs against it: the browser tests (e2e bundle) and the demo
  (demo bundle) need separate databases. The binaries are under
  `/opt/homebrew/opt/postgresql@17/bin` (not on PATH). The Deno tests connect over
  TCP, so also start with `-c listen_addresses=127.0.0.1` and use
  `DATABASE_URL=postgres://postgres@127.0.0.1:54329/<db>`; a unix-socket `?host=`
  URL does not work with the driver. Run the whole suite both with and without
  `DATABASE_URL` (CI sets it for every job): `REQUIRE_DB=1 DATABASE_URL=... deno task test`.
- Tests that import `main.ts` get an empty festival (`festival()` until
  `setFestival`); only `import.meta.main` loads `BUNDLE_DIR`. `auth.contract.test.ts`
  replaces `clientCheck.exists` (the "is this judge/track in the bundle" check on
  credential issue) with a stub; integration tests `setFestival(new Festival(data))`
  and `TRUNCATE` the day's tables (`seed()`/`unseed()`, which also abort leftover
  sessions). Progress writes are asynchronous: poll the database (`eventually()`).
- Browser tests: Playwright runs the server with `BUNDLE_DIR`/`AUDIO_DIR` pointing at
  `fixtures/bundles/e2e` (set in `node-tests/playwright.config.ts`). Its session start
  is in the past. After changing `scripts/fixtures.ts`
  run `deno task fixtures` (a unit test checks the committed bundle is current).
  Kill any leftover `app/src/main.ts` server before a run (`reuseExistingServer`).
- Never log credentials: `/join/<secret>` is redacted in the request log.

## Repo conventions

`.vscode/copilot-instructions.md` states the rules to keep (public/ and the HTML
allowlist are all that is served; DB access via `db.ts`; thin route handlers; Node
only for Playwright) and matches the current layout. The server serves the three
HTML pages from `app/frontend-src` through an explicit allowlist of routes (not a
static mount). Keep new code within the spirit of those rules; ask before restructuring.

## Status

Phases 0-7 of the "make it correctly functioning" plan are done, then `/response` as a
service, competitor audio and DJ gates. The **redesign (`redesign.md`) is complete**:
Phase 1 bundle loader, 2 cursor progress / skips / missing scores / zero-score rule,
3 sequencer (planned start, delay estimate, per-competition judge claims, hold / release /
cancel, no abort), 4 audio per track (no cut-off), 5 cloud copy, 6 docs. Suites: 218 unit
(incl. `shared/festival-bundle`), 124 frontend, 39 contract, 22 integration (with a DB),
12 browser tests; all green with exit code 0, with and without `DATABASE_URL` (scratch
Postgres 17). `deno task static` only passes once generated `public/*.js` is committed.

Working style (owner): analysis only when asked to analyse; commit only when asked.

## Open items (next session)

1. **Portal** (`portal.md`): registration, uploads, loudness normalisation, the exporter
   (uses `shared/festival-bundle`) and the **score receiver** for the cloud copy (the
   payload in "Cloud copy" is the proposed contract). There is no upload path on this
   server. Distribution B (an HTTPS pull of the bundle) is not built.
2. Not done: learning the delay allowances from the day's actual times; browser tests for
   the DJ countdown and the scoreboard delay message (covered by frontend tests; the e2e
   server runs with `DJ_GATES=0`); a cloud push on shutdown; sending progress and actual
   times to the cloud (only scores and skips go); the admin page does not show whether a
   DJ holds the track's audio (only `audio:dj<N>` in `waiting_for`).
3. Audio manifest is the whole track, so a DJ page that reloads with an empty cache
   downloads finished sessions' files too (narrowing it would change the digest as the day
   goes on).
4. Bundle verification hashes every audio file at each boot (fine for hundreds of
   files; cache by size+mtime if it gets slow). A dry run's database cannot take the
   final bundle (pairing guard): use a fresh database for the event.
5. Single-instance assumption: the revocation cache and the audio reports are in process
   memory.
6. CI: `ci.yml` is green on GitHub. Pinned to `ubuntu-24.04`, `actions/checkout@v5`,
   `setup-node`/`upload-artifact@v6` (Node 24; all three jobs passed on GitHub, run of
   `570aa84`; not re-run since the redesign commits). Still open: `.vscode/tasks.json`
   references a missing `start-debug-session.sh`.
