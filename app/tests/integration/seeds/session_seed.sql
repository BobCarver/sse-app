-- Seed: session with 1 competition (id=10) and 2 competitors (100,101)
-- Ids chosen deterministically for tests

INSERT INTO festivals (id, name) VALUES (1, 'Test Fest') ON CONFLICT DO NOTHING;
INSERT INTO tracks (id, festival_id, name, location) VALUES (1, 1, 'Main', 'Stage') ON CONFLICT DO NOTHING;

INSERT INTO sessions (id, track_id, name, status, start_time) VALUES (1, 1, 'Test Session', 'upcoming', NOW()) ON CONFLICT DO NOTHING;

INSERT INTO rubrics (id, name) VALUES (1, 'Test Rubric') ON CONFLICT DO NOTHING;
INSERT INTO criteria (id, name) VALUES (1, 'Technique') ON CONFLICT DO NOTHING;
INSERT INTO rubric_criteria (rubric_id, criteria_id, weight) VALUES (1, 1, 1.0) ON CONFLICT DO NOTHING;

INSERT INTO users (id, name, email, password_hash, role) VALUES
  (10, 'Judge A', 'judge2@example.test', 'x', 'judge') ON CONFLICT DO NOTHING;
INSERT INTO users (id, name, email, password_hash, role) VALUES
  (11, 'Judge B', 'judge3@example.test', 'x', 'judge') ON CONFLICT DO NOTHING;

INSERT INTO judges (id, user_id) VALUES (2, 10) ON CONFLICT DO NOTHING;
INSERT INTO judges (id, user_id) VALUES (3, 11) ON CONFLICT DO NOTHING;

INSERT INTO competitors (id, name, type) VALUES (100, 'Alice', 'individual') ON CONFLICT DO NOTHING;
INSERT INTO competitors (id, name, type) VALUES (101, 'Bob', 'individual') ON CONFLICT DO NOTHING;

INSERT INTO competitions (id, session_id, order_number, rubric_id, name, status) VALUES
  (10, 1, 1, 1, 'E2E Competition', 'upcoming') ON CONFLICT DO NOTHING;

INSERT INTO competition_competitors (competition_id, competitor_id, duration, order_number) VALUES
  (10, 100, 50, 1),
  (10, 101, 50, 2)
ON CONFLICT DO NOTHING;

INSERT INTO rubric_judges (rubric_id, judge_id) VALUES (1, 2) ON CONFLICT DO NOTHING;
INSERT INTO rubric_judges (rubric_id, judge_id) VALUES (1, 3) ON CONFLICT DO NOTHING;

INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id) VALUES (1, 2, 1) ON CONFLICT DO NOTHING;
INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id) VALUES (1, 3, 1) ON CONFLICT DO NOTHING;
