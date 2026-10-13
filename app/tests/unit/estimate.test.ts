// Delay estimates: a session starts at the later of its planned time and the
// end of the one before it; the open session's remaining entries count.
import { assertEquals } from "@std/assert";
import {
  allowances,
  DEFAULT_ALLOWANCES,
  estimateStarts,
  isLate,
  planFromBundle,
  type PlannedSession,
} from "../../src/estimate.ts";

const T = (hhmm: string) => new Date(`2026-10-20T${hhmm}:00Z`);
const hhmm = (d: Date | undefined) => d?.toISOString().slice(11, 16);
const ZERO = { announce: 0, scoring: 0, changeover: 0 };

/** Session with `n` entries of `seconds` each (competition = session id). */
const session = (
  id: number,
  start: string,
  n: number,
  seconds = 60,
): PlannedSession => ({
  id,
  plannedStart: T(start),
  entries: Array.from({ length: n }, (_, i) => ({
    competitionId: id,
    competitorId: id * 100 + i,
    duration: seconds,
  })),
});

Deno.test("estimate: on time, every session starts as planned", () => {
  const est = estimateStarts(
    [session(1, "10:00", 10), session(2, "14:00", 10)],
    undefined,
    T("09:00"),
    ZERO,
  );
  assertEquals([hhmm(est.get(1)), hhmm(est.get(2))], ["10:00", "14:00"]);
});

Deno.test("estimate: the open session's remaining entries push the next one back, and delays cascade", () => {
  // 13:50, session 1 still has 30 one-minute entries left (from the cursor on).
  const est = estimateStarts(
    [
      session(1, "10:00", 40),
      session(2, "14:00", 10), // 10 minutes of entries
      session(3, "14:15", 5),
    ],
    {
      sessionId: 1,
      cursor: { competitionId: 1, competitorId: 110, phase: null },
    },
    T("13:50"),
    ZERO,
  );
  assertEquals(est.has(1), false); // the open session is not estimated
  assertEquals(hhmm(est.get(2)), "14:20"); // 13:50 + 30 entries
  assertEquals(hhmm(est.get(3)), "14:30"); // after session 2's 10 minutes
});

Deno.test("estimate: allowances are added per competitor; scoring has only its own left", () => {
  const a = { announce: 20, scoring: 30, changeover: 10 }; // +60 s each
  const est = estimateStarts(
    [session(1, "10:00", 3), session(2, "10:00", 1)],
    {
      sessionId: 1,
      cursor: { competitionId: 1, competitorId: 101, phase: "scoring" },
    },
    T("10:00"),
    a,
  );
  // 101 being scored: 40 s; 102: 60 + 60 s => 160 s after 10:00.
  assertEquals(est.get(2)?.toISOString(), "2026-10-20T10:02:40.000Z");
  // No cursor: the open session is done; the next starts as planned or now.
  const done = estimateStarts(
    [session(1, "10:00", 3), session(2, "11:00", 1)],
    { sessionId: 1, cursor: null },
    T("11:10"),
    a,
  );
  assertEquals(hhmm(done.get(2)), "11:10");
});

Deno.test("estimate: late means more than a minute after the planned time", () => {
  assertEquals(isLate(T("14:01"), T("14:00")), false);
  assertEquals(isLate(T("14:02"), T("14:00")), true);
});

Deno.test("estimate: allowances come from the environment, with defaults", () => {
  assertEquals(allowances(), DEFAULT_ALLOWANCES);
  Deno.env.set("ALLOWANCE_SCORING_S", "15");
  try {
    assertEquals(allowances().scoring, 15);
  } finally {
    Deno.env.delete("ALLOWANCE_SCORING_S");
  }
});

Deno.test("estimate: a bundle session's entries in running order", () => {
  const entry = (id: number, order: number) => ({
    id,
    name: "x",
    type: "individual" as const,
    order_number: order,
    duration: id,
    audio: {},
  });
  const plan = planFromBundle({
    id: 7,
    name: "S",
    start_time: "2026-10-20T10:00:00Z",
    order_number: 1,
    competitions: [
      {
        id: 2,
        name: "B",
        order_number: 2,
        rubric_id: 1,
        competitors: [entry(5, 1)],
      },
      {
        id: 1,
        name: "A",
        order_number: 1,
        rubric_id: 1,
        competitors: [entry(4, 2), entry(3, 1)],
      },
    ],
  });
  assertEquals(plan.entries.map((e) => [e.competitionId, e.competitorId]), [
    [1, 3],
    [1, 4],
    [2, 5],
  ]);
});
