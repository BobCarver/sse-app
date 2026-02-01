-- Festivals Table
CREATE TABLE festivals (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Tracks Table
CREATE TABLE tracks (
    id SERIAL PRIMARY KEY,
    festival_id INT NOT NULL REFERENCES festivals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    location TEXT NOT NULL,
    current_session INT, -- constraint added later (session table defined below)
    created_at TIMESTAMP DEFAULT NOW()
);

-- Rubrics Table
CREATE TABLE rubrics (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Criteria Table
CREATE TABLE criteria (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL
);

-- Sessions Table
CREATE TABLE sessions (
    id SERIAL PRIMARY KEY,
    track_id INT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    current_competition INT, -- constraint added after competitions & competitors exist
    current_competitor INT,  -- constraint added after competitors exist
    name TEXT NOT NULL,
    status text NOT NULL CHECK (status IN ('upcoming', 'active', 'completed')),
    start_time TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Competitions Table
CREATE TABLE competitions (
    id SERIAL PRIMARY KEY,
    session_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    order_number INT NOT NULL,
    rubric_id INT NOT NULL REFERENCES rubrics(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    /* status is a enum of upcoming, active or completed */
    status text NOT NULL CHECK (status IN ('upcoming', 'active', 'completed')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Users Table
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'judge', 'competitor')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Judges Table
CREATE TABLE judges (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- name TEXT NOT NULL, get name from users
    created_at TIMESTAMP DEFAULT NOW()
);

-- Competitors Table
CREATE TABLE competitors (
    id SERIAL PRIMARY KEY,
    name TEXT, -- optional display name
    type TEXT NOT NULL CHECK (type IN ('individual', 'couple', 'team')),
    -- name TEXT NOT NULL, get name from users
    created_at TIMESTAMP DEFAULT NOW()
);

-- allow multiple people (team/couple) as a competitor
CREATE TABLE competitor_members (
  competitor_id INT NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  user_id INT NOT NULL REFERENCES users(id),
  PRIMARY KEY (competitor_id, user_id)
);
-- Now add referential integrity for the "current_*" pointer columns
ALTER TABLE tracks
  ADD CONSTRAINT fk_tracks_current_session
    FOREIGN KEY (current_session) REFERENCES sessions(id)
      ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE sessions
  ADD CONSTRAINT fk_sessions_current_competition
    FOREIGN KEY (current_competition) REFERENCES competitions(id)
      ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT fk_sessions_current_competitor
    FOREIGN KEY (current_competitor) REFERENCES competitors(id)
      ON DELETE SET NULL ON UPDATE CASCADE;

-- Rubric Criteria Junction Table
CREATE TABLE rubric_criteria (
    rubric_id INT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
    criteria_id INT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
    weight DECIMAL(3,1) NOT NULL DEFAULT 1.0,
    PRIMARY KEY (rubric_id, criteria_id)
);

-- Rubric Judges Junction Table
CREATE TABLE rubric_judges (
    rubric_id INT NOT NULL REFERENCES rubrics(id) ON DELETE CASCADE,
    judge_id INT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
    PRIMARY KEY (rubric_id, judge_id)
);

-- Rubric Judge-Criteria Mapping Table
CREATE TABLE rubric_judge_criteria (
    rubric_id INT NOT NULL,
    judge_id INT NOT NULL,
    criteria_id INT NOT NULL,
    PRIMARY KEY (rubric_id, judge_id, criteria_id),
    FOREIGN KEY (rubric_id, judge_id) REFERENCES rubric_judges(rubric_id, judge_id)
        ON DELETE CASCADE,
    FOREIGN KEY (rubric_id, criteria_id) REFERENCES rubric_criteria(rubric_id, criteria_id)
        ON DELETE CASCADE
);

-- Competition Competitors Junction Table
CREATE TABLE competition_competitors (
    competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    competitor_id INT NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
    duration INT,
    score FLOAT,
    order_number INT NOT NULL,
    PRIMARY KEY (competition_id, competitor_id)
);

-- Scores Table
CREATE TABLE scores (
    id SERIAL PRIMARY KEY,
    competition_id INT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
    competitor_id INT NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
    judge_id INT NOT NULL REFERENCES judges(id) ON DELETE CASCADE,
    criteria_id INT NOT NULL REFERENCES criteria(id) ON DELETE CASCADE,
    score NUMERIC(3, 1) NOT NULL CHECK (score >= 1 AND score <= 10),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (competition_id, judge_id, competitor_id, criteria_id)
);

-- Create indexes for better performance
CREATE INDEX idx_competition_competitors_order
    ON competition_competitors(competition_id, order_number);
CREATE INDEX idx_scores_competition
    ON scores(competition_id, competitor_id);
CREATE INDEX idx_track_current_session
    ON tracks(current_session);
