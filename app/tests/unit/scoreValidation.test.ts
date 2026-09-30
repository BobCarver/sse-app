import { assertEquals } from "@std/assert";
import { Session } from "../../src/session.ts";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { scoreTag } from "../../src/contract.ts";
import type { Competition, ScoreSubmission } from "../../src/types.ts";
import {
  createDependencies,
  createMockClient,
  delay,
  schedulePerf,
} from "../test-utils.ts";

const competition: Competition = {
  id: 10,
  name: "C",
  competitors: [{ id: 100, name: "A", duration: 1 }, {
    id: 101,
    name: "B",
    duration: 1,
  }],
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }, { id: 2, name: "S" }],
    judges: [{ id: 2, name: "J2", criteria: [1, 2] }, {
      id: 3,
      name: "J3",
      criteria: [1],
    }],
  },
};

function scoringSession(): Session {
  const s = new Session(1, createDependencies());
  s.currentCompetition = competition;
  s.currentPosition = 1;
  s.currentPhase = "scoring";
  return s;
}

Deno.test("validateScoreSubmission: accepts exactly the judge's criteria", () => {
  const s = scoringSession();
  assertEquals(
    s.validateScoreSubmission(10, 101, 2, [{ criteria_id: 2, score: 1 }, {
      criteria_id: 1,
      score: 10,
    }]),
    undefined,
  );
  // judge 3 only scores criterion 1
  assertEquals(
    s.validateScoreSubmission(10, 101, 3, [{ criteria_id: 1, score: 5 }]),
    undefined,
  );
});

Deno.test("validateScoreSubmission: closed unless scoring the current competitor", () => {
  const s = scoringSession();
  const ok = [{ criteria_id: 1, score: 5 }];
  assertEquals(s.validateScoreSubmission(10, 100, 3, ok)?.kind, "closed"); // previous competitor
  assertEquals(s.validateScoreSubmission(11, 101, 3, ok)?.kind, "closed"); // other competition
  s.currentPhase = "performing";
  assertEquals(s.validateScoreSubmission(10, 101, 3, ok)?.kind, "closed");
  s.currentPhase = "idle";
  assertEquals(s.validateScoreSubmission(10, 101, 3, ok)?.kind, "closed");
});

Deno.test("validateScoreSubmission: judge outside the rubric is forbidden", () => {
  assertEquals(
    scoringSession().validateScoreSubmission(10, 101, 9, [{
      criteria_id: 1,
      score: 5,
    }])?.kind,
    "forbidden",
  );
});

Deno.test("validateScoreSubmission: wrong criteria or out-of-range is invalid", () => {
  const s = scoringSession();
  const kind = (scores: { criteria_id: number; score: number }[]) =>
    s.validateScoreSubmission(10, 101, 2, scores)?.kind;
  assertEquals(kind([{ criteria_id: 1, score: 5 }]), "invalid"); // missing 2
  assertEquals(
    kind([{ criteria_id: 1, score: 5 }, { criteria_id: 3, score: 5 }]),
    "invalid",
  ); // wrong id
  assertEquals(
    kind([{ criteria_id: 1, score: 5 }, { criteria_id: 1, score: 5 }]),
    "invalid",
  ); // duplicate
  assertEquals(
    kind([{ criteria_id: 1, score: 0.9 }, { criteria_id: 2, score: 5 }]),
    "invalid",
  );
  assertEquals(
    kind([{ criteria_id: 1, score: 10.1 }, { criteria_id: 2, score: 5 }]),
    "invalid",
  );
  // boundaries are inclusive
  assertEquals(
    kind([{ criteria_id: 1, score: 1 }, { criteria_id: 2, score: 10 }]),
    undefined,
  );
});

async function runOne(saveScore: (s: ScoreSubmission) => Promise<void>) {
  clearAllResolvers();
  const deps = createDependencies();
  deps.saveScore = saveScore;
  const session = new Session(1, deps);
  deps.unassignedClients.set("dj0", createMockClient("dj0"));
  deps.unassignedClients.set("judge3", createMockClient("judge3"));
  const solo: Competition = {
    ...competition,
    competitors: [competition.competitors[0]],
    rubric: { ...competition.rubric, judges: [competition.rubric.judges[1]] },
  };
  const done = session.runSession([solo], ["dj0"]);
  schedulePerf(10, 0, 50);
  setTimeout(
    () => resolveTag(scoreTag(10, 100, 3), [{ criteria_id: 1, score: 7 }]),
    100,
  );
  await done;
  await delay(10);
  return session;
}

Deno.test("saveScore: transient failure is retried and then saved", async () => {
  let calls = 0;
  const saved: ScoreSubmission[] = [];
  const session = await runOne((s) => {
    if (++calls < 3) return Promise.reject(new Error("blip"));
    saved.push(s);
    return Promise.resolve();
  });
  assertEquals(calls, 3);
  assertEquals(saved.length, 1);
  assertEquals(session.unsavedScores.length, 0);
});

Deno.test("saveScore: persistent failure is kept in unsavedScores, session still completes", async () => {
  const session = await runOne(() => Promise.reject(new Error("down")));
  assertEquals(session.isRunning(), false);
  assertEquals(session.unsavedScores.length, 1);
  assertEquals(session.unsavedScores[0].judge_id, 3);
});
