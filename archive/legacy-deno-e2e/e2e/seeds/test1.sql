-- Seed: festival "test1" with 1 track, 1 session, 1 competition, 1 competitor,
-- 1 rubric, 1 judge (backed by a user), and 1 criteria.
BEGIN;

-- 1) Festival
INSERT INTO festivals (id, name, created_at)
VALUES (1, 'test1', NOW());

-- 2) Track (referencing festival)
INSERT INTO tracks (id, festival_id, name, location, current_session, created_at)
VALUES (1, 1, 'track1', 'Main Stage', NULL, NOW());

-- 3) Session (referencing track)
INSERT INTO sessions (id, track_id, name, status, start_time, created_at, current_competition, current_competitor)
VALUES (1, 1, 'session1', 'upcoming', NOW(), NOW(), NULL, NULL);

-- 4) Rubric and Criteria
INSERT INTO rubrics (id, name, created_at) VALUES (1, 'rubric1', NOW());
INSERT INTO criteria (id, name) VALUES (1, 'Technique');

-- 5) User for the judge + Judges row
INSERT INTO users (id, name, email, password_hash, role, created_at)
VALUES (1, 'Judge A', 'judgeA@example.com', 'testhash', 'judge', NOW());

INSERT INTO judges (id, user_id, created_at) VALUES (1, 1, NOW());

-- 6) Competitor
INSERT INTO competitors (id, name, type, created_at)
VALUES (1, 'Competitor 1', 'individual', NOW());

-- 7) Competition (references session and rubric)
INSERT INTO competitions (id, session_id, order_number, rubric_id, name, status, created_at)
VALUES (1, 1, 1, 1, 'Competition 1', 'upcoming', NOW());

-- 8) Competition-Competitors mapping
INSERT INTO competition_competitors (competition_id, competitor_id, duration, score, order_number)
VALUES (1, 1, 120, NULL, 1);

-- 9) Rubric mappings (criteria + judge + judge-criteria)
INSERT INTO rubric_criteria (rubric_id, criteria_id, weight) VALUES (1, 1, 1.0);
INSERT INTO rubric_judges (rubric_id, judge_id) VALUES (1, 1);
INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id) VALUES (1, 1, 1);

-- 10) Optionally set pointers to reflect "current" state
UPDATE sessions SET current_competition = 1, current_competitor = 1 WHERE id = 1;
UPDATE tracks SET current_session = 1 WHERE id = 1;

-- 11) Reset serial sequences to at least current max(id) to avoid collision on next inserts
SELECT setval(pg_get_serial_sequence('festivals','id'), COALESCE((SELECT MAX(id) FROM festivals), 0));
SELECT setval(pg_get_serial_sequence('tracks','id'), COALESCE((SELECT MAX(id) FROM tracks), 0));
SELECT setval(pg_get_serial_sequence('sessions','id'), COALESCE((SELECT MAX(id) FROM sessions), 0));
SELECT setval(pg_get_serial_sequence('rubrics','id'), COALESCE((SELECT MAX(id) FROM rubrics), 0));
SELECT setval(pg_get_serial_sequence('criteria','id'), COALESCE((SELECT MAX(id) FROM criteria), 0));
SELECT setval(pg_get_serial_sequence('users','id'), COALESCE((SELECT MAX(id) FROM users), 0));
SELECT setval(pg_get_serial_sequence('judges','id'), COALESCE((SELECT MAX(id) FROM judges), 0));
SELECT setval(pg_get_serial_sequence('competitors','id'), COALESCE((SELECT MAX(id) FROM competitors), 0));
SELECT setval(pg_get_serial_sequence('competitions','id'), COALESCE((SELECT MAX(id) FROM competitions), 0));

COMMIT;