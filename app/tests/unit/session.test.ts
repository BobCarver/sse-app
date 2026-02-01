import { assertEquals } from "std/assert/equals";
import {
  clearAllResolvers,
  resolveTag,
  waitForTag,
} from "../../src/resolveTag.ts";
import { Session } from "../../src/session.ts";
import type { Competition, ScoreSubmission, SSEClient } from "../../src/types.ts";
import {
  connectAsUnassigned,
  createDependencies,
  createMockClient,
  delay,
  schedulePerf,
  scheduleScore,
  startSession,
} from "../test-utils.ts";

// deno-lint-ignore-file no-explicit-any

Deno.test("Session - constructor should initialize empty session", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  assertEquals(session.id, 1);
  assertEquals(session.running, false);
  assertEquals(session.clients.size, 0);
});

Deno.test("Session - isRunning should return running state", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  assertEquals(session.isRunning(), false);

  session.running = true;
  assertEquals(session.isRunning(), true);
});

Deno.test("Session - connectClient should register client if slot exists", () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);

  const mockClient = createMockClient("judge5");

  // Pre-register client slot
  session.clients.set("judge5", undefined);

  session.connectClient(mockClient);

  assertEquals(session.clients.has("judge5"), true);
  assertEquals(session.clients.get("judge5"), mockClient);
});

Deno.test("Session - connectClient should not register if no slot exists", () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);

  const mockClient = createMockClient("judge5");

  // Don't pre-register slot
  session.connectClient(mockClient);

  // Should not be added
  assertEquals(session.clients.has("judge5"), false);
});

Deno.test("Session - connectClient should resolve waiting tag", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);

  const mockClient = createMockClient("judge5");

  // Pre-register slot
  session.clients.set("judge5", undefined);

  const promise = waitForTag("required:judge5");

  delay(10).then(() => session.connectClient(mockClient));

  await promise;
  assertEquals(session.clients.has("judge5"), true);
});

Deno.test("Session - disconnectClient should mark as undefined", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const mockClient = createMockClient("judge5");

  session.clients.set("judge5", mockClient);
  assertEquals(session.clients.get("judge5"), mockClient);

  session.disconnectClient("judge5");

  // Should still have slot but marked as undefined
  assertEquals(session.clients.has("judge5"), true);
  assertEquals(session.clients.get("judge5"), undefined);
});

Deno.test("Session - removeClient should delete client entirely", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const mockClient = createMockClient("judge5") as unknown as SSEClient;

  session.clients.set("judge5", mockClient);
  assertEquals(session.clients.has("judge5"), true);

  session.removeClient("judge5");

  // Should be completely removed
  assertEquals(session.clients.has("judge5"), false);
});

Deno.test("Session - registerPermanentClients should check unassigned pool", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  // deno-lint-ignore no-unused-vars
  const djClient = createMockClient("dj0") as unknown as SSEClient;
  const scoreboardClient = createMockClient("sb10") as unknown as SSEClient;

  // Add scoreboard to unassigned pool
  deps.unassignedClients.set("sb10", scoreboardClient);

  session.registerPermanentClients(["dj0", "sb10"]);

  // DJ should be undefined (not in pool)
  assertEquals(session.clients.has("dj0"), true);
  assertEquals(session.clients.get("dj0"), undefined);

  // Scoreboard should be assigned from pool
  assertEquals(session.clients.has("sb10"), true);
  assertEquals(session.clients.get("sb10"), scoreboardClient);

  // Should be removed from unassigned pool
  assertEquals(deps.unassignedClients.has("sb10"), false);
});

Deno.test("Session - registerRequiredClients should check unassigned pool", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const judgeClient = createMockClient("judge2");

  // Add judge to unassigned pool
  deps.unassignedClients.set("judge2", judgeClient);

  const competition: Competition = {
    id: 10,
    name: "Test Competition",
    competitors: [],
    rubric: {
      id: 1,
      criteria: [{ id: 1, name: "Technique" }],
      judges: [
        { id: 2, name: "Judge A", criteria: [1] },
        { id: 3, name: "Judge B", criteria: [1] },
      ],
    },
  };

  session.registerRequiredClients(competition);

  // Judge 2 should be assigned from pool
  assertEquals(session.clients.get("judge2"), judgeClient);
  assertEquals(deps.unassignedClients.has("judge2"), false);

  // Judge 3 should be undefined (not in pool)
  assertEquals(session.clients.get("judge3"), undefined);
});

Deno.test("Session - runSession end-to-end should process performance and scoring", async () => {
  clearAllResolvers();

  const deps = createDependencies();

  // Spy into saved submissions
  const submissions: ScoreSubmission[] = [];
  // deno-lint-ignore require-await
  deps.saveScore = async (submission: ScoreSubmission) => {
    deps.scores.push(submission);
    submissions.push(submission);
  };

  const session = new Session(1, deps);

  // Prepare clients in unassigned pool
  const dj = createMockClient("dj0");
  const judge2 = createMockClient("judge2");
  deps.unassignedClients.set("dj0", dj);
  deps.unassignedClients.set("judge2", judge2);

  const competition: Competition = {
    id: 10,
    name: "E2E Competition",
    competitors: [{ id: 100, name: "Alice", duration: 50 }],
    rubric: {
      id: 1,
      criteria: [{ id: 1, name: "Technique" }],
      judges: [{ id: 2, name: "Judge A", criteria: [1] }],
    },
  };

  // Start the session and let helpers register clients
  const sessionPromise = await startSession(session, [competition], ["dj0"]);

  // Trigger performance and scoring quickly
  schedulePerf(10, 0, 20);
  scheduleScore(10, 100, 2, [{ criteria_id: 1, score: 8.5 }], 40);

  // Wait for the session to finish
  await sessionPromise;

  // One submission should have been saved
  assertEquals(submissions.length, 1);
  assertEquals(submissions[0].competition_id, 10);
  assertEquals(submissions[0].judge_id, 2);
  assertEquals(submissions[0].competitor_id, 100);

  // Session should have been reset and clients returned to unassigned pool
  assertEquals(session.isRunning(), false);
  assertEquals(deps.unassignedClients.has("dj0"), true);
  assertEquals(deps.unassignedClients.has("judge2"), true);
});

Deno.test("Session - skipped performance should not trigger scoring", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const submissions: ScoreSubmission[] = [];
  // deno-lint-ignore require-await
  deps.saveScore = async (submission: ScoreSubmission) => {
    deps.scores.push(submission);
    submissions.push(submission);
  };

  const session = new Session(1, deps);
  const dj = createMockClient("dj0");
  const judge2 = createMockClient("judge2");
  deps.unassignedClients.set("dj0", dj);
  deps.unassignedClients.set("judge2", judge2);

  const competition: Competition = {
    id: 11,
    name: "Skip Competition",
    competitors: [{ id: 200, name: "Bob", duration: 50 }],
    rubric: {
      id: 1,
      criteria: [{ id: 1, name: "Technique" }],
      judges: [{ id: 2, name: "Judge A", criteria: [1] }],
    },
  };

  const sessionPromise = await startSession(session, [competition], ["dj0"]);

  // Resolve performance as false (skipped)
  setTimeout(() => resolveTag("perf:11:0", false), 20);

  await sessionPromise;

  // No submissions should have been saved
  assertEquals(submissions.length, 0);
  assertEquals(session.isRunning(), false);
});

Deno.test("Session - saveScore errors are handled and session continues", async () => {
  clearAllResolvers();
  const deps = createDependencies();

  // Make saveScore throw to exercise error handling
  // deno-lint-ignore require-await
  deps.saveScore = async (_: ScoreSubmission) => {
    throw new Error("db error");
  };

  const session = new Session(1, deps);
  const dj = createMockClient("dj0");
  const judge2 = createMockClient("judge2");
  deps.unassignedClients.set("dj0", dj);
  deps.unassignedClients.set("judge2", judge2);

  const competition: Competition = {
    id: 12,
    name: "Error Competition",
    competitors: [{ id: 300, name: "Carol", duration: 50 }],
    rubric: {
      id: 1,
      criteria: [{ id: 1, name: "Technique" }],
      judges: [{ id: 2, name: "Judge A", criteria: [1] }],
    },
  };

  const sessionPromise = await startSession(session, [competition], ["dj0"]);

  // Trigger normal perf and score
  schedulePerf(12, 0, 20);
  scheduleScore(12, 300, 2, [{ criteria_id: 1, score: 7.0 }],
   40);

  await sessionPromise;

  // No submissions should be persisted due to error
  assertEquals(deps.scores.length, 0);
  assertEquals(session.isRunning(), false);
});

Deno.test("Session - handleClientReconnect sends recovery messages", async () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  // DJ reconnect during performing
  session.currentPhase = "performing";
  session.currentCompetition = {
    id: 13,
    name: "X",
    competitors: [{ id: 400, name: "Diana", duration: 50 }],
    rubric: { id: 1, criteria: [], judges: [] },
  };
  session.currentPosition = 0;

  const dj = createMockClient("dj0") as unknown as SSEClient;
  await session.handleClientReconnect(dj);
  await delay(10);
  assertEquals(
    // deno-lint-ignore no-explicit-any
    (dj as any).__messages.some((m: string) => m.includes("performance_recovery")),
    true,
  );

  // Judge reconnect during scoring (not yet submitted) should get enable_scoring
  session.currentPhase = "scoring";
  session.currentCompetition = {
    id: 14,
    name: "Y",
    competitors: [{ id: 500, name: "Eve", duration: 50 }],
    rubric: {
      id: 1,
      criteria: [],
      judges: [{ id: 2, name: "Judge A", criteria: [] }],
    },
  } ;
  session.currentPosition = 0;

  const judge = createMockClient("judge2") as unknown as SSEClient;
  await session.handleClientReconnect(judge);
  await delay(10);
  assertEquals(
    // deno-lint-ignore no-explicit-any
    (judge as any).__messages.some((m: string) => m.includes("enable_scoring")),
    true,
  );

  // If judge already submitted, no enable_scoring should be sent
  session.submittedScores.add("14:0:judge2");
  const judge2 = createMockClient("judge2") as unknown as SSEClient;
  await session.handleClientReconnect(judge2);
  await delay(10);
  assertEquals(
    // deno-lint-ignore no-explicit-any
    (judge2 as any).__messages.some((m: string) => m.includes("enable_scoring")),
    false,
  );
});

Deno.test("Session - clearUnneededClients moves non-permanent clients back to unassigned", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const dj = createMockClient("dj0") as unknown as SSEClient;
  const judge = createMockClient("judge7") as unknown as SSEClient;
  session.clients.set("dj0", dj);
  session.clients.set("judge7", judge);

  session.clearUnneededClients(undefined, ["dj0"]);

  // judge7 should be moved back to unassigned
  assertEquals(deps.unassignedClients.has("judge7"), true);
  // only dj0 should remain in session clients
  assertEquals(session.clients.size, 1);
  assertEquals(session.clients.has("dj0"), true);
});

Deno.test("Session - require waits for missing clients", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);

  // pre-register slot but not connected
  session.clients.set("judge99", undefined);

  const p = session.require(["judge99"]);
  // connect after a small delay
  delay(20).then(() => session.connectClient(createMockClient("judge99")));

  await p;
  assertEquals(session.clients.get("judge99") !== undefined, true);
});

Deno.test("connectAsUnassigned adds to pool and connects when slot exists", () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);
  const client = createMockClient("judge5") as unknown as SSEClient;

  // pre-register slot then call helper
  session.clients.set("judge5", undefined);
  connectAsUnassigned(deps, session, client);

  assertEquals(deps.unassignedClients.get("judge5"), client);
  assertEquals(session.clients.get("judge5"), client);
});

Deno.test("connectAsUnassigned adds to pool but does not connect without slot", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);
  const client = createMockClient("judge5");

  connectAsUnassigned(deps, session, client);

  assertEquals(deps.unassignedClients.get("judge5"), client);
  assertEquals(session.clients.has("judge5"), false);
});

Deno.test("connectAsUnassigned resolves required tag when slot exists", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);
  const client = createMockClient("judge5");

  // pre-register slot
  session.clients.set("judge5", undefined);

  const p = waitForTag("required:judge5");
  connectAsUnassigned(deps, session, client);

  await p; // should resolve
  assertEquals(session.clients.get("judge5"), client);
});

Deno.test("connectAsUnassigned does not resolve required tag when no slot", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);
  const client = createMockClient("judge6");

  connectAsUnassigned(deps, session, client);

  // Attempt to wait for a short timeout - should reject
  let rejected = false;
  try {
    await waitForTag("required:judge6", 30);
  } catch (_err) {
    rejected = true;
  }

  assertEquals(rejected, true);
});

Deno.test("createDependencies returns defaults and saveScore stores submissions", async () => {
  const deps = createDependencies();
  assertEquals(deps.unassignedClients instanceof Map, true);
  assertEquals(Array.isArray(deps.scores), true);

  const submission = {
    competition_id: 99,
    competitor_id: 1,
    judge_id: 2,
    scores: [{ criteria_id: 1, score: 5 }],
  } as ScoreSubmission;
  await deps.saveScore(submission);
  assertEquals(deps.scores.length, 1);
  assertEquals(deps.scores[0], submission);
});

Deno.test("schedulePerf resolves perf tag with boolean payload", async () => {
  clearAllResolvers();
  const p = waitForTag("perf:20:0");
  schedulePerf(20, 0, 10);
  const payload = await p;
  assertEquals(payload, true);
});

Deno.test("scheduleScore resolves score tag with provided payload", async () => {
  clearAllResolvers();
  const payload =  [{ criteria_id: 1, score: 9 }];

  const p = waitForTag("score:21:101:3");
  scheduleScore(21, 101, 3, payload, 10);
  const resolved = await p;
  assertEquals(resolved, payload);
});

Deno.test("createMockClient captures messages from broadcast", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);
  const client = createMockClient("judge8") as unknown as SSEClient;
  session.clients.set("judge8", client);

  session.broadcast({ event: "test_event", foo: 1 } as any);

  // deno-lint-ignore no-explicit-any
  assertEquals((client as any).__messages.length > 0, true);
  assertEquals(
    // deno-lint-ignore no-explicit-any
    (client as any).__messages.some((m: string) => m.includes("event: test_event")),
    true,
  );
});

Deno.test("delay waits at least the specified time", async () => {
  const start = Date.now();
  await delay(30);
  const elapsed = Date.now() - start;
  assertEquals(elapsed >= 25, true);
});

Deno.test.ignore(
  "Session - connectClient should resolve waiting tag",
  async () => {
    clearAllResolvers();
    const deps = createDependencies();
    const session = new Session(1, deps);

    const mockClient = createMockClient("judge5");

    // Pre-register slot
    session.clients.set("judge5", undefined);

    const promise = waitForTag("required:5");

    delay(10).then(() => session.connectClient(mockClient));

    await promise;
    assertEquals(session.clients.has("judge5"), true);
  },
);
