-- 02_seed.sql: idempotent seed for tests
BEGIN;

-- Add festival
INSERT INTO festivals (name, created_at)
SELECT 'test1', NOW()
WHERE NOT EXISTS (SELECT 1 FROM festivals WHERE name='test1');

-- Track
INSERT INTO tracks (festival_id, name, location, created_at)
SELECT f.id, 'track1', 'Main Stage', NOW()
FROM festivals f
WHERE f.name='test1' AND NOT EXISTS (
  SELECT 1 FROM tracks t WHERE t.name='track1' AND t.festival_id = f.id
);

-- Session (use deterministic id 1)
INSERT INTO sessions (id, track_id, name, status, start_time, created_at)
SELECT 1, t.id, 'session1', 'upcoming', NOW(), NOW()
FROM tracks t
WHERE t.name='track1' AND NOT EXISTS (
  SELECT 1 FROM sessions s WHERE s.id = 1
);

-- Rubric and Criteria
INSERT INTO rubrics (name, created_at)
SELECT 'rubric1', NOW()
WHERE NOT EXISTS (SELECT 1 FROM rubrics WHERE name='rubric1');

INSERT INTO criteria (name)
SELECT 'Technique'
WHERE NOT EXISTS (SELECT 1 FROM criteria WHERE name='Technique');

-- Users and Judges (deterministic ids for e2e tests)
-- Create two judge users with explicit ids 2 and 3 and a competitor user with id 100
INSERT INTO users (id, name, email, password_hash, role, created_at)
SELECT 2, 'Judge A', 'judgeA@example.com', 'testhash', 'judge', NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=2 OR email='judgeA@example.com');

INSERT INTO users (id, name, email, password_hash, role, created_at)
SELECT 3, 'Judge B', 'judgeB@example.com', 'testhash', 'judge', NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=3 OR email='judgeB@example.com');

INSERT INTO users (id, name, email, password_hash, role, created_at)
SELECT 100, 'CompetitorUser', 'competitor@example.com', 'testhash', 'competitor', NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE id=100 OR email='competitor@example.com');

-- Ensure judges rows exist with ids matching users (2 and 3)
INSERT INTO judges (id, user_id, created_at)
SELECT 2, 2, NOW()
WHERE NOT EXISTS (SELECT 1 FROM judges WHERE id=2);

INSERT INTO judges (id, user_id, created_at)
SELECT 3, 3, NOW()
WHERE NOT EXISTS (SELECT 1 FROM judges WHERE id=3);

-- Competitor and membership (use deterministic competitor id 100)
INSERT INTO competitors (id, name, type, created_at)
SELECT 100, 'Competitor 1', 'individual', NOW()
WHERE NOT EXISTS (SELECT 1 FROM competitors WHERE id=100);

INSERT INTO competitor_members (competitor_id, user_id)
SELECT c.id, u.id FROM competitors c, users u
WHERE c.id=100 AND u.id=100
  AND NOT EXISTS (
    SELECT 1 FROM competitor_members cm WHERE cm.competitor_id = c.id AND cm.user_id = u.id
  );

-- Competition (use deterministic competition id 10)
INSERT INTO competitions (id, session_id, order_number, rubric_id, name, status, created_at)
SELECT 10, s.id, 1, r.id, 'Competition 1', 'upcoming', NOW()
FROM sessions s, rubrics r
WHERE s.name='session1' AND r.name='rubric1' AND NOT EXISTS (
  SELECT 1 FROM competitions c WHERE c.id=10
);

-- competition_competitors (link competition 10 to competitor 100)
INSERT INTO competition_competitors (competition_id, competitor_id, duration, score, order_number)
SELECT 10, 100, 120, NULL, 1
WHERE NOT EXISTS (
  SELECT 1 FROM competition_competitors cc WHERE cc.competition_id = 10 AND cc.competitor_id = 100
);

-- Rubric mappings
INSERT INTO rubric_criteria (rubric_id, criteria_id, weight)
SELECT r.id, cr.id, 1.0
FROM rubrics r, criteria cr
WHERE r.name='rubric1' AND cr.name='Technique'
  AND NOT EXISTS (
    SELECT 1 FROM rubric_criteria where rubric_id = r.id AND criteria_id = cr.id
  );

-- Map rubric to judges 2 and 3 explicitly
INSERT INTO rubric_judges (rubric_id, judge_id)
SELECT r.id, 2 FROM rubrics r
WHERE r.name='rubric1' AND NOT EXISTS (
  SELECT 1 FROM rubric_judges WHERE rubric_id = r.id AND judge_id = 2
);

INSERT INTO rubric_judges (rubric_id, judge_id)
SELECT r.id, 3 FROM rubrics r
WHERE r.name='rubric1' AND NOT EXISTS (
  SELECT 1 FROM rubric_judges WHERE rubric_id = r.id AND judge_id = 3
);

-- Map each judge to the 'Technique' criteria
INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id)
SELECT r.id, 2, cr.id FROM rubrics r, criteria cr
WHERE r.name='rubric1' AND cr.name='Technique' AND NOT EXISTS (
  SELECT 1 FROM rubric_judge_criteria WHERE rubric_id = r.id AND judge_id = 2 AND criteria_id = cr.id
);

INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id)
SELECT r.id, 3, cr.id FROM rubrics r, criteria cr
WHERE r.name='rubric1' AND cr.name='Technique' AND NOT EXISTS (
  SELECT 1 FROM rubric_judge_criteria WHERE rubric_id = r.id AND judge_id = 3 AND criteria_id = cr.id
);

COMMIT;
