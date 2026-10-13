-- 01_schema.sql: idempotent schema creation (run on init; safe to run again).
--
-- The festival structure (tracks, sessions, competitions, rubrics, judges,
-- competitors, audio) is NOT in the database: it comes from the festival bundle
-- (BUNDLE_DIR), held in memory and never written. The database holds only what
-- happens on the day: the loaded bundle (pairing guard), scores, the per-track
-- cursor, session start/end markers, skips, missing scores and device links.
-- Ids are the bundle's; they are checked against the loaded bundle in code, not
-- with foreign keys.
--
-- A database made by an older version still has the structure tables
-- (festivals, tracks, sessions, competitions, ...). Nothing reads them any more;
-- they are left alone here (drop them by hand once their data is not needed).

-- The one festival bundle this database belongs to. Recorded on first use; the
-- server refuses a different bundle once anything has run. data_json is the
-- exact data.json text (text, not jsonb, which would reorder keys), so a backup
-- of the database is complete on its own.
CREATE TABLE IF NOT EXISTS festival_bundle (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    festival_id INT NOT NULL,
    digest TEXT NOT NULL,
    data_json TEXT NOT NULL,
    loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Scores Table
CREATE TABLE IF NOT EXISTS scores (
    id SERIAL PRIMARY KEY,
    competition_id INT NOT NULL,
    competitor_id INT NOT NULL,
    judge_id INT NOT NULL,
    criteria_id INT NOT NULL,
    score NUMERIC(3, 1) NOT NULL CHECK (score >= 1 AND score <= 10),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (competition_id, judge_id, competitor_id, criteria_id)
);

-- Older databases: scores referred to the structure tables.
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_competition_id_fkey;
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_competitor_id_fkey;
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_judge_id_fkey;
ALTER TABLE scores DROP CONSTRAINT IF EXISTS scores_criteria_id_fkey;

-- Progress: one row per track. The row is the lock: a track has at most one
-- open session (open_session), taken when a session starts and given back when
-- it finishes. The cursor is the competitor in play or next to play:
-- everything before it in running order is finished, everything after it is
-- upcoming. phase: NULL = not started yet, performing, scoring. A cursor with
-- no competitor while a session is open = every competitor is done (the
-- session waits to be ended).
CREATE TABLE IF NOT EXISTS track_progress (
    track_id INT PRIMARY KEY,
    open_session INT UNIQUE,
    competition_id INT,
    competitor_id INT,
    phase TEXT CHECK (phase IN ('performing', 'scoring')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- What actually happened to each session: opened (first start), started (its
-- first competition began), finished (ended normally) or cancelled.
CREATE TABLE IF NOT EXISTS session_runs (
    session_id INT PRIMARY KEY,
    track_id INT NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
);

-- A competitor skipped by an explicit action (append-only). stage: the
-- performance was skipped, or scoring closed with no scores and was skipped.
-- actor: the DJ or the operator. A skip that only releases a judge or client
-- wait is not a competitor skip and is not written here.
CREATE TABLE IF NOT EXISTS skips (
    session_id INT NOT NULL,
    competition_id INT NOT NULL,
    competitor_id INT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('performance', 'scoring')),
    actor TEXT NOT NULL CHECK (actor IN ('dj', 'operator')),
    reason TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (session_id, competition_id, competitor_id)
);

-- A judge's score that never arrived (append-only; never updated or deleted).
-- A later score from a re-opened judge does not remove the row: the audit shows
-- both. A judge with a row here and no score for that competitor is missing.
CREATE TABLE IF NOT EXISTS missing_scores (
    id BIGSERIAL PRIMARY KEY,
    session_id INT NOT NULL,
    competition_id INT NOT NULL,
    competitor_id INT NOT NULL,
    judge_id INT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('timeout', 'closed', 'absent')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Client credentials: admin-issued links for DJs, judges and scoreboards.
-- Only a hash of the secret is stored; revoking a row locks that device out.
-- client_id is the SSE identity: dj<trackId>, sb<trackId> or judge<judgeId>.
CREATE TABLE IF NOT EXISTS client_credentials (
    id SERIAL PRIMARY KEY,
    client_id TEXT NOT NULL CHECK (client_id ~ '^(dj|judge|sb)[0-9]+$'),
    secret_hash TEXT NOT NULL UNIQUE,
    label TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    revoked_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scores_competition
    ON scores(competition_id, competitor_id);
CREATE INDEX IF NOT EXISTS idx_missing_scores_competitor
    ON missing_scores(competition_id, competitor_id);
