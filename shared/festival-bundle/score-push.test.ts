import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkScoresAgainstBundle,
  type FestivalData,
  isValidScore,
  type ScorePush,
  type ScoreRow,
  snapshotDigest,
  sortSnapshot,
  validateScorePush,
} from "./mod.ts";

const row = (
  competition_id: number,
  competitor_id: number,
  judge_id: number,
  criteria_id: number,
  score: number,
): ScoreRow => ({
  competition_id,
  competitor_id,
  judge_id,
  criteria_id,
  score,
});

const push = (over: Partial<ScorePush> = {}): ScorePush => ({
  festival_id: 1,
  bundle_digest: "b".repeat(64),
  digest: "d".repeat(64),
  final: false,
  sent_at: "2026-10-20T19:00:00Z",
  scores: [row(100, 1001, 7, 1, 7.5)],
  skips: [{
    session_id: 10,
    competition_id: 100,
    competitor_id: 1002,
    stage: "performance",
    actor: "dj",
    reason: "",
  }],
  ...over,
});

Deno.test("score push: the digest is pinned (sender and receiver must agree)", async () => {
  const snap = sortSnapshot({
    scores: [row(2, 5, 7, 1, 7.5), row(1, 9, 7, 2, 10)],
    skips: [{
      session_id: 1,
      competition_id: 1,
      competitor_id: 3,
      stage: "performance",
      actor: "dj",
      reason: "no-show é",
    }],
  });
  assertEquals(
    await snapshotDigest(1, "abc", snap),
    "c6ffca4c01986c09c007a82f3489d94bfed8e0f20570060097d843d2cf902439",
  );
});

Deno.test("score push: row order does not change the digest", async () => {
  const a = { scores: [row(1, 1, 1, 1, 5), row(1, 1, 1, 2, 6)], skips: [] };
  const b = { scores: [row(1, 1, 1, 2, 6), row(1, 1, 1, 1, 5)], skips: [] };
  assertEquals(
    await snapshotDigest(1, "x", sortSnapshot(a)),
    await snapshotDigest(1, "x", sortSnapshot(b)),
  );
});

Deno.test("score push: scores are 1 to 10 in steps of 0.1", () => {
  for (const ok of [1, 1.1, 7.5, 9.9, 10]) assert(isValidScore(ok), String(ok));
  for (const bad of [0, 0.9, 10.1, 7.25, NaN, "7"]) {
    assert(!isValidScore(bad), String(bad));
  }
});

Deno.test("score push: a valid push passes", () => {
  assertEquals(validateScorePush(push()), []);
  assertEquals(validateScorePush(push({ scores: [], skips: [] })), []);
});

Deno.test("score push: shape problems are readable", () => {
  assertEquals(validateScorePush("text"), ["body must be a JSON object"]);
  const missing = validateScorePush({ festival_id: 1, scores: [] });
  assert(missing.includes("bundle_digest must be text"), missing.join("\n"));
  assert(missing.includes("skips must be a list"), missing.join("\n"));
  assert(missing.includes("final must be true or false"), missing.join("\n"));
  assert(
    validateScorePush(push({ sent_at: "yesterday" })).includes(
      "sent_at must be an ISO time",
    ),
  );
});

Deno.test("score push: bad rows, duplicates and unknown skip stages are refused", () => {
  const bad = validateScorePush(push({
    scores: [
      row(100, 1001, 7, 1, 7.25),
      row(100, 1001, 7, 1, 8),
      { ...row(100, 1001, 7, 2, 8), judge_id: 0 },
    ],
    skips: [
      {
        session_id: 10,
        competition_id: 100,
        competitor_id: 1002,
        stage: "warmup" as "performance",
        actor: "judge" as "dj",
        reason: "",
      },
      {
        session_id: 10,
        competition_id: 100,
        competitor_id: 1002,
        stage: "scoring",
        actor: "operator",
        reason: "",
      },
    ],
  }));
  assertEquals(bad, [
    "scores[0]: score must be 1-10 with at most one decimal",
    "scores[1]: 100/1001/7/1 is listed twice",
    "scores[2]: ids must be positive integers",
    "skips[0]: stage must be performance or scoring",
    "skips[0]: actor must be dj or operator",
    "skips[1]: 10/100/1002 is listed twice",
  ]);
});

const DATA: FestivalData = {
  festival: {
    id: 1,
    name: "F",
    rubrics: [{
      id: 1,
      name: "R",
      criteria: [{ id: 1, name: "T", weight: 1 }, {
        id: 2,
        name: "M",
        weight: 1,
      }],
      judges: [{ id: 7, name: "A", criteria: [1, 2] }, {
        id: 8,
        name: "B",
        criteria: [1],
      }],
    }],
    tracks: [{
      id: 1,
      name: "T",
      location: "",
      sessions: [{
        id: 10,
        name: "S",
        start_time: "2026-10-20T18:00:00Z",
        order_number: 1,
        competitions: [{
          id: 100,
          name: "C",
          order_number: 1,
          rubric_id: 1,
          competitors: [1001, 1002].map((id, i) => ({
            id,
            name: `P${id}`,
            type: "individual" as const,
            order_number: i + 1,
            duration: 60,
            audio: {},
          })),
        }],
      }],
    }],
  },
};

Deno.test("score push: every row must belong to the bundle", () => {
  assertEquals(checkScoresAgainstBundle(push(), DATA), []);
  const bad = checkScoresAgainstBundle(
    push({
      scores: [row(100, 1001, 8, 2, 5), row(100, 9999, 7, 1, 5)],
      skips: [{
        session_id: 11,
        competition_id: 100,
        competitor_id: 1001,
        stage: "scoring",
        actor: "operator",
        reason: "",
      }],
    }),
    DATA,
  );
  assertEquals(bad.length, 3, bad.join("\n"));
  assertStringIncludes(bad[0], "judge 8 does not score criterion 2");
  assertStringIncludes(bad[1], "competitor 9999 is not in competition 100");
  assertStringIncludes(bad[2], "competition 100 is not in session 11");
});
