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

-- Session
INSERT INTO sessions (track_id, name, status, start_time, created_at)
SELECT t.id, 'session1', 'upcoming', NOW(), NOW()
FROM tracks t
WHERE t.name='track1' AND NOT EXISTS (
  SELECT 1 FROM sessions s WHERE s.name='session1' AND s.track_id = t.id
);

-- Rubric and Criteria
INSERT INTO rubrics (name, created_at)
SELECT 'rubric1', NOW()
WHERE NOT EXISTS (SELECT 1 FROM rubrics WHERE name='rubric1');

INSERT INTO criteria (name)
SELECT 'Technique'
WHERE NOT EXISTS (SELECT 1 FROM criteria WHERE name='Technique');

-- Users and Judge
INSERT INTO users (name, email, password_hash, role, created_at)
SELECT 'Judge A', 'judgeA@example.com', 'testhash', 'judge', NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email='judgeA@example.com');

INSERT INTO users (name, email, password_hash, role, created_at)
SELECT 'CompetitorUser', 'competitor@example.com', 'testhash', 'competitor', NOW()
WHERE NOT EXISTS (SELECT 1 FROM users WHERE email='competitor@example.com');

INSERT INTO judges (user_id, created_at)
SELECT u.id, NOW() FROM users u
WHERE u.email='judgeA@example.com' AND NOT EXISTS (
  SELECT 1 FROM judges j WHERE j.user_id = u.id
);

-- Competitor and membership
INSERT INTO competitors (name, type, created_at)
SELECT 'Competitor 1', 'individual', NOW()
WHERE NOT EXISTS (SELECT 1 FROM competitors WHERE name='Competitor 1');

INSERT INTO competitor_members (competitor_id, user_id)
SELECT c.id, u.id FROM competitors c, users u
WHERE c.name='Competitor 1' AND u.email='competitor@example.com'
  AND NOT EXISTS (
    SELECT 1 FROM competitor_members cm WHERE cm.competitor_id = c.id AND cm.user_id = u.id
  );

-- Competition
INSERT INTO competitions (session_id, order_number, rubric_id, name, status, created_at)
SELECT s.id, 1, r.id, 'Competition 1', 'upcoming', NOW()
FROM sessions s, rubrics r
WHERE s.name='session1' AND r.name='rubric1' AND NOT EXISTS (
  SELECT 1 FROM competitions c WHERE c.name='Competition 1' AND c.session_id = s.id
);

-- competition_competitors
INSERT INTO competition_competitors (competition_id, competitor_id, duration, score, order_number)
SELECT c.id, comp.id, 120, NULL, 1
FROM competitions c, competitors comp
WHERE c.name='Competition 1' AND comp.name='Competitor 1' AND NOT EXISTS (
  SELECT 1 FROM competition_competitors cc WHERE cc.competition_id = c.id AND cc.competitor_id = comp.id
);

-- Rubric mappings
INSERT INTO rubric_criteria (rubric_id, criteria_id, weight)
SELECT r.id, cr.id, 1.0
FROM rubrics r, criteria cr
WHERE r.name='rubric1' AND cr.name='Technique'
  AND NOT EXISTS (
    SELECT 1 FROM rubric_criteria where rubric_id = r.id AND criteria_id = cr.id
  );

INSERT INTO rubric_judges (rubric_id, judge_id)
SELECT r.id, j.id FROM rubrics r, judges j
WHERE r.name='rubric1' AND j.id = (SELECT id FROM judges LIMIT 1)
  AND NOT EXISTS (
    SELECT 1 FROM rubric_judges WHERE rubric_id = r.id AND judge_id = j.id
  );

INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id)
SELECT r.id, j.id, cr.id FROM rubrics r, judges j, criteria cr
WHERE r.name='rubric1' AND j.id = (SELECT id FROM judges LIMIT 1) AND cr.name='Technique'
  AND NOT EXISTS (
    SELECT 1 FROM rubric_judge_criteria WHERE rubric_id = r.id AND judge_id = j.id AND criteria_id = cr.id
  );

COMMIT;
