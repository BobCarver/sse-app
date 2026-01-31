-- 01_schema.sql: idempotent schema creation (run on init)
-- Use IF NOT EXISTS wherever possible to allow safe repeated runs

-- Festivals Table
CREATE TABLE IF NOT EXISTS festivals (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tracks Table
CREATE TABLE IF NOT EXISTS tracks (
    id SERIAL PRIMARY KEY,
    festival_id INT NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    current_session INT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Rubrics Table
CREATE TABLE IF NOT EXISTS rubrics (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Criteria Table
CREATE TABLE IF NOT EXISTS criteria (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL
);

-- Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    track_id INT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    current_competition INT,
    current_competitor INT,
    name TEXT NOT NULL,
    status text NOT NULL CHECK (status IN ('upcoming', 'active', 'completed')),
    start_time TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Competitions Table
CREATE TABLE IF NOT EXISTS competitions (
    id SERIAL PRIMARY KEY,
    session_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    order_number INT NOT NULL,
    rubric_id INT NOT NULL REFERENCES rubrics(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    status text NOT NULL CHECK (status IN ('upcoming', 'active', 'completed')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'judge', 'competitor')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Judges Table
CREATE TABLE IF NOT EXISTS judges (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Competitors Table
CREATE TABLE IF NOT EXISTS competitors (
    id SERIAL PRIMARY KEY,
    name TEXT,
    type TEXT NOT NULL CHECK (type IN ('individual', 'couple', 'team')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Competitor members
CREATE TABLE IF NOT EXISTS competitor_members (
  competitor_id INT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  PRIMARY KEY (competitor_id, user_id)
);

-- Add foreign key constraints for pointers (if not already enforced)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_tracks_current_session'
  ) THEN
    ALTER TABLE tracks
      ADD CONSTRAINT fk_tracks_current_session
        FOREIGN KEY (current_session) REFERENCES sessions(id)
        ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_sessions_current_competition'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT fk_sessions_current_competition
        FOREIGN KEY (current_competition) REFERENCES competitions(id)
        ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_sessions_current_competitor'
  ) THEN
    ALTER TABLE sessions
      ADD CONSTRAINT fk_sessions_current_competitor
        FOREIGN KEY (current_competitor) REFERENCES competitors(id)
        ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$$;

-- Rubric Criteria Junction Table
CREATE TABLE IF NOT EXISTS rubric_criteria (
    rubric_id INT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
    criteria_id INT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
    weight DECIMAL(3,1) NOT NULL DEFAULT 1.0,
    PRIMARY KEY (rubric_id, criteria_id)
);

-- Rubric Judges Junction Table
CREATE TABLE IF NOT EXISTS rubric_judges (
    rubric_id INT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
    judge_id INT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
    PRIMARY KEY (rubric_id, judge_id)
);

-- Rubric Judge-Criteria Mapping Table
CREATE TABLE IF NOT EXISTS rubric_judge_criteria (
    rubric_id INT NOT NULL,
    judge_id INT NOT NULL,
    criteria_id INT NOT NULL,
    PRIMARY KEY (rubric_id, judge_id, criteria_id)
);

-- Competition Competitors Junction Table
CREATE TABLE IF NOT EXISTS competition_competitors (
    competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    competitor_id INT NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
    duration INT,
    score FLOAT,
    order_number INT NOT NULL,
    PRIMARY KEY (competition_id, competitor_id)
);

-- Scores Table
CREATE TABLE IF NOT EXISTS scores (
    id SERIAL PRIMARY KEY,
    competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    competitor_id INT NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
    judge_id INT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
    criteria_id INT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
    score NUMERIC(3, 1) NOT NULL CHECK (score >= 1 AND score <= 10),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (competition_id, judge_id, competitor_id, criteria_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_competition_competitors_order
    ON competition_competitors(competition_id, order_number);
CREATE INDEX IF NOT EXISTS idx_scores_competition
    ON scores(competition_id, competitor_id);
CREATE INDEX IF NOT EXISTS idx_track_current_session
    ON tracks(current_session);
