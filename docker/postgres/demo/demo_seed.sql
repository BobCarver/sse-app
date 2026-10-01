-- demo_seed.sql: a small, complete scenario for trying the system by hand
-- (see "Demo" in the README). Needs 01_schema.sql first.
--
--   psql "$DATABASE_URL" -f docker/postgres/demo/demo_seed.sql      (or: deno task demo:seed)
--
-- Safe to run repeatedly, and to load next to 02_seed.sql: every id is in the
-- 1000+ range. It is NOT in db-init/ on purpose: Docker would load it into the
-- test databases, and the tests expect the small seed there.
--
-- Scenario: one track (DJ dj1000, scoreboard sb1000), one session with two
-- competitions, five competitors, two judges (judge1001, judge1002) who each
-- score Technique and Musicality.
BEGIN;

INSERT INTO festivals (id, name) VALUES (1000, 'Demo Festival')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tracks (id, festival_id, name, location)
VALUES (1000, 1000, 'Demo Stage', 'Main Hall')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sessions (id, track_id, name, status, start_time)
VALUES (1000, 1000, 'Demo Session', 'upcoming', NOW())
ON CONFLICT (id) DO NOTHING;

-- Rubric: two criteria, both judges score both.
INSERT INTO rubrics (id, name) VALUES (1000, 'Demo rubric')
ON CONFLICT (id) DO NOTHING;

INSERT INTO criteria (id, name) VALUES (1000, 'Technique'), (1001, 'Musicality')
ON CONFLICT (id) DO NOTHING;

INSERT INTO rubric_criteria (rubric_id, criteria_id, weight)
VALUES (1000, 1000, 1.0), (1000, 1001, 1.0)
ON CONFLICT DO NOTHING;

-- Judges
INSERT INTO users (id, name, email, password_hash, role) VALUES
  (1001, 'Judge Ada', 'ada@demo.example', 'demo', 'judge'),
  (1002, 'Judge Ben', 'ben@demo.example', 'demo', 'judge')
ON CONFLICT DO NOTHING;

INSERT INTO judges (id, user_id) VALUES (1001, 1001), (1002, 1002)
ON CONFLICT (id) DO NOTHING;

INSERT INTO rubric_judges (rubric_id, judge_id) VALUES (1000, 1001), (1000, 1002)
ON CONFLICT DO NOTHING;

INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id) VALUES
  (1000, 1001, 1000), (1000, 1001, 1001),
  (1000, 1002, 1000), (1000, 1002, 1001)
ON CONFLICT DO NOTHING;

-- Competitors
INSERT INTO competitors (id, name, type) VALUES
  (1001, 'Alex Rivera', 'individual'),
  (1002, 'Sam Okafor', 'individual'),
  (1003, 'Jordan Lee', 'individual'),
  (1004, 'Mia & Leo', 'couple'),
  (1005, 'Team Sparks', 'team')
ON CONFLICT (id) DO NOTHING;

-- Two competitions in one session. Durations are SECONDS.
INSERT INTO competitions (id, session_id, order_number, rubric_id, name, status) VALUES
  (1000, 1000, 1, 1000, 'Solo Jive', 'upcoming'),
  (1001, 1000, 2, 1000, 'Showcase Waltz', 'upcoming')
ON CONFLICT (id) DO NOTHING;

INSERT INTO competition_competitors (competition_id, competitor_id, duration, order_number) VALUES
  (1000, 1001, 15, 1),
  (1000, 1002, 15, 2),
  (1000, 1003, 15, 3),
  (1001, 1004, 15, 1),
  (1001, 1005, 15, 2)
ON CONFLICT DO NOTHING;

COMMIT;
