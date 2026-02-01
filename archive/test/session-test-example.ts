// tests/session.test.ts
import { assertEquals } from "std/assert";
import { Session } from "../app/src/session.ts";
import { clearAllResolvers } from "../app/src/resolveTag.ts";
import type { Competition } from "../app/src/types.ts";
import {
  connectAsUnassigned,
  createDependencies,
  createMockClient,
  delay,
  schedulePerf,
  scheduleScore,
} from "./test-utils.ts";

Deno.test("Session - runSession with mock competitions and permanent clients", async () => {
  clearAllResolvers();

  // Create unassigned clients pool
  const deps = createDependencies();
  // Create session
  const session = new Session(1, deps);

  // Mock competitions
  const competitions: Competition[] = [
    {
      id: 10,
      name: "Competition 1",
      competitors: [
        { id: 100, name: "Competitor 1", duration: 120 },
      ],
      rubric: {
        id: 1,
        criteria: [{ id: 1, name: "Technique" }],
        judges: [
          { id: 2, name: "Judge A", criteria: [1] },
          { id: 3, name: "Judge B", criteria: [1] },
        ],
      },
    },
    {
      id: 11,
      name: "Competition 2",
      competitors: [
        { id: 101, name: "Competitor 2", duration: 180 },
      ],
      rubric: {
        id: 2,
        criteria: [{ id: 2, name: "Creativity" }],
        judges: [
          { id: 2, name: "Judge A", criteria: [2] }, // Same judge
          { id: 4, name: "Judge C", criteria: [2] }, // Different judge
        ],
      },
    },
  ];

  // Permanent clients: DJ (0) and 2 scoreboards (10, 11)
  const permanentClientIds = ["dj0", "sb10", "sb11"];

  // Create mock clients
  const mockClients = {
    dj: createMockClient("dj0"),
    scoreboard1: createMockClient("sb10"),
    scoreboard2: createMockClient("sb11"),
    judgeA: createMockClient("judge2"),
    judgeB: createMockClient("judge3"),
    judgeC: createMockClient("judge4"),
  };

  // Connect permanent clients first (simulate global SSE)
  connectAsUnassigned(deps, session, mockClients.dj);
  connectAsUnassigned(deps, session, mockClients.scoreboard1);
  connectAsUnassigned(deps, session, mockClients.scoreboard2);

  // Start session in background
  const sessionPromise = session.runSession(competitions, permanentClientIds);

  // Wait a bit for session to register clients
  await delay(50);

  // Connect judges for competition 1
  connectAsUnassigned(deps, session, mockClients.judgeA);
  connectAsUnassigned(deps, session, mockClients.judgeB);

  // Simulate DJ completing performance and judges submitting scores for competition 1
  schedulePerf(10, 0, 100);
  scheduleScore(10, 100, 2, [{ criteria_id: 1, score: 8.5 }], 150);
  scheduleScore(10, 100, 3, [{ criteria_id: 1, score: 9.0 }], 150);

  // Wait for competition 2 to start (judge B should be moved to unassigned)
  await delay(300);

  // Verify judge B (3) was moved to unassigned pool
  assertEquals(deps.unassignedClients.has("judge3"), true);
  // Connect judge C for competition 2
  connectAsUnassigned(deps, session, mockClients.judgeC);

  // Simulate DJ completing performance and judges submitting scores for competition 2
  schedulePerf(11, 0, 350);
  scheduleScore(11, 101, 2, [{ criteria_id: 2, score: 7.5 }], 400);
  scheduleScore(11, 101, 4, [{ criteria_id: 2, score: 8.0 }], 400);

  // Wait for session to complete
  await sessionPromise;

  // Verify permanent clients are back in unassigned pool
  assertEquals(deps.unassignedClients.has("dj0"), true); // DJ
  assertEquals(deps.unassignedClients.has("sb10"), true); // Scoreboard 1
  assertEquals(deps.unassignedClients.has("sb11"), true); // Scoreboard 2

  // Verify all judges are in unassigned pool
  assertEquals(deps.unassignedClients.has("judge2"), true); // Judge A
  assertEquals(deps.unassignedClients.has("judge3"), true); // Judge B
  assertEquals(deps.unassignedClients.has("judge4"), true); // Judge C

  // Verify scores were saved and have expected values
  assertEquals(deps.scores.length, 4);
  assertEquals(
    deps.scores.map((
      s,
    ) => [s.competition_id, s.competitor_id, s.judge_id, s.scores[0].score]),
    [
      [10, 100, 2, 8.5],
      [10, 100, 3, 9.0],
      [11, 101, 2, 7.5],
      [11, 101, 4, 8.0],
    ],
  );

  console.log("Session completed successfully!");
});

Deno.test("Session - permanent clients stay across competitions", async () => {
  clearAllResolvers();

  const deps = createDependencies();
  const session = new Session(1, deps);
  const competitions: Competition[] = [
    {
      id: 10,
      name: "Competition 1",
      competitors: [{ id: 100, name: "Competitor 1", duration: 120 }],
      rubric: {
        id: 1,
        criteria: [{ id: 1, name: "Technique" }],
        judges: [{ id: 2, name: "Judge A", criteria: [1] }],
      },
    },
    {
      id: 11,
      name: "Competition 2",
      competitors: [{ id: 101, name: "Competitor 2", duration: 180 }],
      rubric: {
        id: 2,
        criteria: [{ id: 2, name: "Creativity" }],
        judges: [{ id: 3, name: "Judge B", criteria: [2] }],
      },
    },
  ];

  const permanentClientIds = ["dj0", "sb10"]; // DJ and one scoreboard

  const dj = createMockClient("dj0");
  const scoreboard = createMockClient("sb10");
  const judgeA = createMockClient("judge2");
  const judgeB = createMockClient("judge3");

  // Connect permanent clients (simulate global SSE)
  connectAsUnassigned(deps, session, dj);
  connectAsUnassigned(deps, session, scoreboard);

  const sessionPromise = session.runSession(competitions, permanentClientIds);

  await delay(50);

  // Verify permanent clients are registered
  assertEquals(session.clients.has("dj0"), true); // DJ
  assertEquals(session.clients.has("sb10"), true); // Scoreboard

  // Connect and complete competition 1
  connectAsUnassigned(deps, session, judgeA);
  schedulePerf(10, 0, 100);
  scheduleScore(10, 100, 2, [{ criteria_id: 1, score: 8.5 }], 150);

  await delay(250);

  // After competition 1, permanent clients should still be in session
  assertEquals(session.clients.has("dj0"), true); // DJ still there
  assertEquals(session.clients.has("sb10"), true); // Scoreboard still there
  assertEquals(session.clients.has("judge2"), false); // Judge A removed

  // Connect and complete competition 2
  connectAsUnassigned(deps, session, judgeB);
  schedulePerf(11, 0, 300);
  scheduleScore(11, 101, 3, [{ criteria_id: 2, score: 7.5 }], 350);
  await delay(500);
  await sessionPromise;

  // After session ends, all clients should be in unassigned pool
  assertEquals(deps.unassignedClients.has("dj0"), true);
  assertEquals(deps.unassignedClients.has("sb10"), true);
  assertEquals(deps.unassignedClients.has("judge2"), true);
  assertEquals(deps.unassignedClients.has("judge3"), true);

  // Verify scores were saved and values are correct
  assertEquals(deps.scores.length, 2);
  assertEquals(
    deps.scores.map((
      s,
    ) => [s.competition_id, s.competitor_id, s.judge_id, s.scores[0].score]),
    [
      [10, 100, 2, 8.5],
      [11, 101, 3, 7.5],
    ],
  );
});

// `createMockClient` imported from ./test-utils.ts
