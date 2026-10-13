# Redesign prompt: static festival data, cursor progress, per-track sequencer

Paste the prompt below into a new session in `sse-app` when the work is due. It
summarises an analysis session (2026-10-03 to 2026-10-08). `portal.md` is the
companion spec for the registration portal, which produces the festival bundle this
server runs from.

---

## Prompt

Redesign how the competition server gets its festival data, records progress and
runs sessions. Read CLAUDE.md, this file and `portal.md` first. Settle the open
decisions with the owner before coding. Work in the phases below; after each, run
`deno task static` and the full suite with and without `DATABASE_URL` (check exit
codes, not just "N passed"), rebuild `public/*.js` if frontend code changes, and do
not commit until asked.

### Goals

1. **The festival structure is a static, read-only JSON bundle** made by the portal
   (`manifest.json`, `data.json` as a nested tree, `audio/<sha256>.<ext>`; `portal.md`
   section 5). It is loaded into memory and never written. **No late changes:** the
   bundle is final once the festival starts.
2. **Postgres holds only what happens on the day:** scores, missing-score records,
   the per-track cursor, actual start/end times and finished/cancelled markers per
   session, skip records, device credentials, and the loaded bundle's digest and exact
   `data.json` text.
3. **Progress is a cursor, not statuses spread across tables.** One row per track
   (a track has at most one open session): `open_session`, cursor competition,
   cursor competitor, `phase` (`performing` | `scoring`). One single-row update per
   step.
4. **Sessions run themselves per track (sequencer).** No administrator start: each
   track always has its next session armed; the planned time gates the DJ's start;
   delays cascade; the administrator handles exceptions only.
5. **Scores are copied to the cloud** without the event ever waiting on it.

### Decisions already made

**Data**
- Structure comes from the JSON bundle, held in memory. The structure tables
  (`festivals`, `tracks`, `sessions`, `competitions`, `rubrics`, `criteria`,
  `rubric_*`, `judges`, `competitors`, `competition_competitors`, `audio_files`)
  are no longer read on the competition server; drop them once tests no longer need
  them.
- `data.json` is a nested tree (festival > rubrics and tracks > sessions >
  competitions > competitors, portal.md section 5). Each rubric is listed once under
  the festival; a competition names it by `rubric_id`. The loader resolves that id, so
  the same `Competition` objects that `getSessionCompetitionsWithRubrics` returns
  today come out, and `session.ts` changes little.
- **Pairing guard:** on first use the database records the bundle `digest` and the
  exact `data.json` text; the server refuses to start with a different bundle once
  anything has run. Scores (or the cursor rows) carry the digest or festival id so
  scores from two bundles cannot mix.
- **No foreign keys from `scores`:** every score is validated against the loaded
  structure before it is saved (`responseService` already checks the rubric), and
  the bundle is validated on load.
- **Bundle verification on load:** `data_sha256`; every hash in the manifest present
  in `AUDIO_DIR` with matching size and sha256; referential integrity; strict
  running order (every session, competition and entry has an `order_number`,
  unique for sessions per track, competitions per session, entries per
  competition; the portal assigns one by default); every competition's `rubric_id`
  names a rubric in the festival; rubric ids are unique; every judge criterion names
  a criterion of its rubric. Refuse with a clear message otherwise.
- Copying the bundle is done by any tool (USB, `cp`,
  `rsync -a --ignore-existing`); the verification decides correctness. A built-in
  HTTPS pull from the portal comes later (fetch the manifest, then missing hashes
  only, with Range resume).

**Progress**
- Everything before the cursor in running order is finished; everything after is
  upcoming. Derived, not stored: competition status, per-competitor status, "on
  now".
- **Skipped is recorded, not derived:** a competitor is skipped only by an explicit
  operator action (a performance skip or a scoring skip), stored as a skip record.
  A competitor before the cursor with no scores and no skip record cannot exist,
  because scoring cannot close without scores unless it was skipped (decision 4).
- Resume = "start at the cursor": `phase = scoring` re-opens scoring with the saved
  scores (as `planResume` does for `performed` today); `phase = performing` runs
  that competitor from its performance.
- A track has at most one open session; enforce it in the database (the progress
  row is the lock), not only in memory (`findConflict` in
  `app/src/sessionManager.ts` is memory-only today).
- A session cut off by a crash must be resumed and completed before the next
  session on its track.
- Actual start and end times are recorded next to the cursor (delay, estimates,
  results).
- With the structure out of the database, the planned roles/column grants are no
  longer needed for read-only data; still connect as a non-superuser role.

**Sequencer (session management)**
- Each track has an ordered list of sessions (by `start_time`, then
  `order_number`). Its **open session** is the first not finished or cancelled.
- The server keeps the open session **armed**: at boot, after a crash, and after
  the DJ presses **End session**. Arming = what `startSession` does today (load,
  register DJ and scoreboard, wait for clients, audio gate, then the DJ's begin
  gate). This replaces `POST /sessions/:id/start` for normal running and
  `resumeActiveSessions` at boot.
- The planned `start_time` is a **gate on the DJ's Start button, not a trigger**.
  The DJ page shows a countdown; the scoreboard shows the planned time. The DJ can
  never start before it: the Start button stays disabled until then.
- **Delays cascade:** a session starts at the later of its planned time and the
  previous session's end. The scoreboard's "next session" message shows an
  estimate when the track runs late ("about 14:25, planned 14:00") from the
  remaining entries' durations plus a per-competitor allowance (announcement,
  scoring, changeover; config, or learned from the day's actual times). Today
  `session_finished` shows the planned time even when it has already passed.
- **Judges are claimed per competition** (when its begin gate opens, released when
  it ends), not for the whole session. A judge still held by another track shows in
  `waiting_for` (e.g. `judge1002 (held by track 2)`) instead of a 409. An operator
  `skip` still releases the wait. This also stops an early-armed session from
  holding judges another track needs.
- The administrator handles exceptions: `skip` as now, plus **hold** (pauses the
  session where it is: nothing runs until it is released) and **cancel** (drops the
  session for good: marked cancelled in the database, never run, the track moves on
  to its next session). There is no `abort`.
- Tests and the demo need manual control: a switch to turn arming off (like
  `AUTO_RESUME=0`), or keep `POST /sessions/:id/start` for tests. Browser tests run
  with `DJ_GATES=0`, so an armed session would otherwise run by itself.

**Audio**
- The bundle is frozen, so the per-session upload cut-off and the admin upload
  route (`PUT /admin/audio/...`) lose their purpose on the competition server.
- The DJ downloads **the whole track's audio once** after the bundle is loaded
  (`audioCache.ts` keeps the hash-based fetch-and-verify); the audio gate becomes
  "this track's set is complete", checked once per day, and the audio manifest is
  built from the bundle, not from `audio_files`.

**Cloud copy**
- Background **snapshot push over HTTPS** (outbound only) every 30-60 s of the
  festival's scores (and optionally the cursor and actual times) to the portal's
  authenticated receiver, skipped when a digest is unchanged; the portal replaces
  that festival's scores in one transaction. A final full push after the event is
  the authoritative results upload. Ids match because the portal assigned them.
  Best effort: a failed or missing push is retried later and never blocks scoring,
  the cursor or the DJ.
  The admin page shows "cloud copy: last sent N s ago / offline since ...".
  Logical replication (needs a VPN to the venue) and an outbox (more code than the
  volume justifies) were considered and rejected.

### Decide before coding (ask the owner)

1. **Decided:** the DJ may never start before the planned time (Start stays disabled).
2. **Decided:** judges are claimed per competition (see Sequencer).
3. **Decided:** `hold` (pauses the session) and `cancel` (drops it for good) are added
   for the administrator; `skip` stays; `abort` is removed.
4. **Decided: zero-score close.** Scoring cannot close with no scores at all. It
   stops for the operator, who either skips the competitor explicitly or re-opens
   scoring. Only a skip closes a competitor with no scores.
5. **Decided moot:** `abort` is removed, so there is no abort-and-lock question.
6. **Decided: missing-score records are persisted** for the audit trail. Each record
   is one judge's missing score on one competition and competitor, with its reason
   `timeout`, `closed` or `absent`, and the time it was written. They also explain an
   unscored competitor.
7. **Decided: no emergency audio.** The bundle is final and there is no override or
   replacement upload on the day. If a file is wrong or broken, the DJ skips that
   performance, which is recorded as a skip (see "Skipped is recorded").
8. **Decided: best-effort live cloud copy.** Scores reach the portal while the venue
   has internet, but the event never waits on it. The final full push after the event
   remains the authoritative results.

### Defaults for the remaining details

These are starting values. Change them in config or in this file; none needs an
owner decision before Phase 1.

- **Shared module location.** A separate folder, `shared/festival-bundle/`, in this
  repo: bundle types, validator, canonical serialiser and rubric resolution, with
  its own tests and no dependencies outside the Deno standard library. The portal
  imports it by pinned path while both live in this repo. When the portal gets its
  own repo, the folder is published (JSR or a pinned git tag) and both projects
  depend on one version. The format version (`bundle_version`) changes only when the
  shared module changes shape, so the server and the portal cannot disagree silently.
- **Bundle location.** `BUNDLE_DIR` (default `./bundle`) holds `manifest.json` and
  `data.json`. Audio files are looked for in `AUDIO_DIR` as before, so the copy step
  puts `audio/<sha256>.<ext>` there. The server refuses to start if `BUNDLE_DIR` is
  missing or fails verification.
- **Hold and release.** `hold` pauses the session where it is: nothing runs, and any
  DJ or judge wait shows `held by operator` in `waiting_for`. The hold is written to
  the database, so a restart does not clear it. `release` lifts it and the session
  carries on from its cursor. Operator commands: `deno task links hold <sessionId>`,
  `deno task links release <sessionId>`, and matching buttons on the admin page.
- **Re-open scoring.** Valid only when the cursor is `scoring` for a competitor that
  was closed with no scores (decision 4). It re-opens scoring for that competitor, with
  any saved scores kept. Command: `deno task links reopen <sessionId>`, and an admin
  page button. It is refused in any other phase.
- **Delay allowances** (per competitor, used for the delay estimate): announcement
  20 s, scoring 30 s, changeover 45 s. Config keys `ALLOWANCE_ANNOUNCE_S`,
  `ALLOWANCE_SCORING_S`, `ALLOWANCE_CHANGEOVER_S`. Tune them after a dry run; learning
  them from the day's actual times is a later option.

### Phases

1. **Bundle loader.** Shared module with the portal (types, validator, canonical
   serialiser): load and verify the bundle, digest guard and `data.json` text in the
   database, build the in-memory structure with each competition's rubric resolved.
   Replace the structure reads in `db.ts`:
   `getSessionCompetitionsWithRubrics`, `getSessionTrackId`, `getFollowingSession`,
   `clientExists` (credential issue), the session lookup used by the audio
   cut-off, the overview queries, and the `audio_files` metadata (manifest from the
   bundle). Convert seeds and the demo (`docker/postgres/demo/demo_seed.sql`) to
   bundle fixtures.
2. **Progress model.** Progress row per track, actual times, finished/cancelled
   markers; a pure derive-status helper (cursor + running order + score counts ->
   per-competitor and per-competition status), unit-tested; rewrite
   `recordProgress`, `getResumeRows` / `planResume`, `getActiveSessionIds`,
   `resetSession`, and `adminOverview` inputs so they keep returning the same
   shapes. Zero-score rule per decision 4.
   - **`skips`** (append-only; one row per skipped competitor): primary key
     `(session_id, competition_id, competitor_id)`; `stage` (`performance` | `scoring`);
     `actor` (`dj` | `operator`); `reason` (optional free text, empty for DJ skips);
     `created_at` (UTC). A skip that only releases a judge or client wait is not a
     competitor skip and is not written here.
   - **`missing_scores`** (append-only; one row per judge per competitor per event):
     `id` (bigserial); `session_id`, `competition_id`, `competitor_id`, `judge_id`;
     `reason` (`timeout` | `closed` | `absent`); `recorded_at` (UTC). Rows are never
     updated or deleted. A later score from a re-opened judge does not remove the
     missing row, so the audit shows both. Current state is derived: a judge with a
     missing row and no later score for that competitor is missing.
   - Neither table carries a bundle digest: the database holds one bundle (pairing
     guard), so rows from two bundles cannot mix. Ids are checked against the loaded
     bundle in code, not with foreign keys, as for `scores`.
3. **Sequencer.** Arm the open session per track at boot, after End session and
   after a crash; planned-time gate and countdown on the DJ page; delay estimate in
   `session_finished` and on the scoreboard; judges claimed per competition with
   cross-track waits in `waiting_for`; hold (pause and release) and cancel per
   decision 3; an off switch for tests.
4. **Audio per track.** Track-level audio set and gate; retire the per-session
   cut-off and the admin upload route per decision 7 (no emergency replacement).
5. **Cloud push.** Background sender, digest skip, retry, admin-page status, final
   push command.
6. **Docs.** CLAUDE.md (data source, persistence, resume, sequencer, environment
   variables, open items), README.

### Tests to update or add

- Unit: bundle verification (bad hash, missing file, duplicate `order_number`,
  broken reference, digest mismatch, a `rubric_id` missing from the festival, judge
  criterion outside its rubric); rubric resolution (each competition gets the rubric
  it names); derive-status helper; resume from the cursor
  (both phases); zero-score rule (scoring cannot close empty; only a skip closes it);
  missing-score records written with the right reason; sequencer (arming after End session, planned-time
  gate, delay estimate, cross-track judge wait, hold pauses and release resumes,
  cancel moves the track to its next session, no start before the planned time);
  push sender (digest skip, retry)
  with an injected fetch.
- Integration (`app/tests/integration/session.integration.test.ts` reads
  `sessions.status` / `competitions.status` and writes fixtures and `start_time`
  directly; move it to bundle fixtures and the new tables): crash mid-performance
  and mid-scoring, then resume; a second session cannot open on a locked track,
  even after a restart; a different bundle is refused after the festival started.
- Browser tests: the admin page still shows skipped (purple), finished and "on
  now"; the DJ's Start button countdown; the scoreboard's delay message.

### Small items found on the way

- `getSessionCompetitionsWithRubrics` logs `sessionId=... sqlDefined=true` on every
  call (leftover debug output; it fills the demo log).
- `tracks.current_session` is written but never read (superseded by the progress
  row).

### Reference (current code)

- Start: `startSession` and `POST /sessions/:sessionId/start` in `app/src/main.ts`;
  boot recovery `resumeActiveSessions` (same file).
- Run loop: `runSession`, `beginGate`, `closeGate`, `awaitAudioReady`,
  `waitForClients` in `app/src/session.ts`.
- Progress writes: `recordProgress` in `app/src/db.ts`; demo reset `resetSession`.
- Restart reads: `getActiveSessionIds`, `getResumeRows` (`app/src/db.ts`),
  `planResume` (`app/src/resume.ts`).
- Display reads: overview queries in `app/src/db.ts`; statuses and "on now" in
  `app/src/adminOverview.ts`.
- Conflicts: `findConflict` in `app/src/sessionManager.ts`.
- Next-session message: `getFollowingSession` (`app/src/db.ts`);
  `session_finished` handlers in `app/frontend-src/sb.ts` and `dj.ts`.
- Today's state columns: `sessions.status`, `sessions.current_competition/
  competitor`, `competitions.status`, `competition_competitors.status`,
  `tracks.current_session`; only `sessions.status`,
  `competition_competitors.status` and the scores matter for a restart.
