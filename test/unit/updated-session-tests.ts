// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "std/assert/equals";
import { assertRejects } from "std/assert/rejects";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { Session } from "../../src/session.ts";
import type { Competition, SSEClient } from "../../src/types.ts";
import { waitForTag } from "../../src/resolveTag.ts";
import {
  connectAsUnassigned,
  createDependencies,
  createMockClient,
  delay,
  schedulePerf,
  scheduleScore,
} from "../test-utils.ts";

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

  const mockClient = createMockClient("judge5");

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
  const djClient = createMockClient("dj0");
  const scoreboardClient = createMockClient("sb10");

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

Deno.test("Session - clearUnneededClients should preserve permanent clients", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const djClient = createMockClient("dj0");
  const judgeAClient = createMockClient("judge2");
  const judgeBClient = createMockClient("judge3");
  const scoreboard = createMockClient("sb10");

  // Set up clients
  session.clients.set("dj0", djClient);
  session.clients.set("judge2", judgeAClient);
  session.clients.set("judge3", judgeBClient);
  session.clients.set("sb10", scoreboard);

  const nextCompetition: Competition = {
    id: 11,
    name: "Competition 2",
    competitors: [],
    rubric: {
      id: 2,
      criteria: [{ id: 2, name: "Creativity" }],
      judges: [
        { id: 2, name: "Judge A", criteria: [2] }, // Still needed
      ],
    },
  };

  const permanentClientIds = ["dj0", "sb10"]; // DJ and scoreboard

  session.clearUnneededClients(nextCompetition, permanentClientIds);

  // Permanent clients should remain
  assertEquals(session.clients.has("dj0"), true);
  assertEquals(session.clients.has("sb10"), true);

  // Judge A still needed for next competition
  assertEquals(session.clients.has("judge2"), true);
  // Judge B not needed, should be moved to unassigned pool
  assertEquals(session.clients.has("judge3"), false);
  assertEquals(deps.unassignedClients.get("judge3"), judgeBClient);
});

Deno.test("Session - clearUnneededClients with no next competition", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const djClient = createMockClient("dj0");
  const judgeClient = createMockClient("judge2");
  const scoreboard = createMockClient("sb10");

  session.clients.set("dj0", djClient);
  session.clients.set("judge2", judgeClient);
  session.clients.set("sb10", scoreboard);

  const permanentClientIds = ["dj0", "sb10"];

  session.clearUnneededClients(undefined, permanentClientIds);

  // Permanent clients should remain
  assertEquals(session.clients.has("dj0"), true);
  assertEquals(session.clients.has("sb10"), true);

  // Judge should be moved to unassigned pool
  assertEquals(session.clients.has("judge2"), false);
  assertEquals(deps.unassignedClients.get("judge2"), judgeClient);
});

Deno.test("Session - requireAllClients should wait for undefined clients", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);

  // Register clients as undefined (disconnected)
  session.clients.set("judge1", undefined);
  session.clients.set("judge2", undefined);

  const mockClient1 = createMockClient("judge1");
  const mockClient2 = createMockClient("judge2");

  const requirePromise = session.requireAllClients();

  delay(10).then(() => {
    session.connectClient(mockClient1);
    session.connectClient(mockClient2);
  });

  await requirePromise;
});

Deno.test("Session - require should wait for specific clients", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);

  const mockClient = createMockClient("dj0");

  session.clients.set("dj0", undefined);

  const requirePromise = session.require(["dj0"]);
  delay(10).then(() => session.connectClient(mockClient));

  await requirePromise;
  assertEquals(session.clients.has("dj0"), true);
});

Deno.test("Session - broadcast should send to all connected clients", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);
  const messages: string[] = [];

  const mockClient1: SSEClient = {
    id: "judge1",
    controller: {
      enqueue: (msg: string) => messages.push(`client1:${msg}`),
    },
  };

  const mockClient2: SSEClient = {
    id: "sb10",
    controller: {
      enqueue: (msg: string) => messages.push(`client2:${msg}`),
    },
  };

  session.clients.set("judge1", mockClient1);
  session.clients.set("sb10", mockClient2);
  session.clients.set("judge3", undefined); // Disconnected client
  session.broadcast({
    event: "client_status",
    connected_clients: ["judge1", "sb10"],
  });

  assertEquals(messages.length, 2);
  assertEquals(messages[0].includes("client_status"), true);
  assertEquals(messages[1].includes("client_status"), true);
});

Deno.test("Session - broadcast should mark client as undefined on error", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const mockClient: SSEClient = {
    id: "judge1",
    controller: {
      enqueue: () => {
        throw new Error("Write failed");
      },
    },
  };

  session.clients.set("judge1", mockClient);
  session.broadcast({
    event: "client_status",
    connected_clients: ["judge1"],
  });

  // Client should be marked as undefined (disconnected)
  assertEquals(session.clients.get("judge1"), undefined);
});

Deno.test("Session - broadcastClientStatus should only report connected", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);
  let lastMessage: any = null;

  const mockClient: SSEClient = {
    id: "judge1",
    controller: {
      enqueue: (msg: string) => {
        const lines = msg.split("\n");
        const dataLine = lines.find((l) => l.startsWith("data: "));
        if (dataLine) {
          lastMessage = JSON.parse(dataLine.substring(6));
        }
      },
    },
  };

  session.clients.set("judge1", mockClient);
  session.clients.set("judge2", undefined); // Disconnected
  session.clients.set("judge3", undefined); // Disconnected

  session.broadcastClientStatus();

  assertEquals(lastMessage.connected_clients.length, 1);
  assertEquals(lastMessage.connected_clients[0], "judge1");
});

Deno.test("Session - runSession should throw if already running", async () => {
  const deps = createDependencies();
  const session = new Session(1, deps);
  session.running = true;

  await assertRejects(
    () => session.runSession([], ["dj0"]),
    Error,
    "Session 1 already running",
  );
});

Deno.test("Session - runSession should throw if no competitions", async () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  await assertRejects(
    () => session.runSession([], ["dj0"]),
    Error,
    "No competitions provided",
  );
});

Deno.test("Session - handleClientReconnect should do nothing if idle", async () => {
  const deps = createDependencies();
  const session = new Session(1, deps);
  const messages: string[] = [];

  const mockClient: SSEClient = {
    id: "judge1",
    controller: {
      enqueue: (msg: string) => messages.push(msg),
    },
  };

  await session.handleClientReconnect(mockClient);

  // Should not send any messages during idle phase
  assertEquals(messages.length, 0);
});

Deno.test("Session - runSession with permanent clients", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);

  const competitions: Competition[] = [{
    id: 10,
    name: "Test Competition",
    competitors: [{ id: 100, name: "Competitor 1", duration: 120 }],
    rubric: {
      id: 1,
      criteria: [{ id: 1, name: "Technique" }],
      judges: [{ id: 2, name: "Judge 1", criteria: [1] }],
    },
  }];

  const permanentClientIds = ["dj0", "sb10"]; // DJ and scoreboard

  const djClient = createMockClient("dj0");
  const scoreboardClient = createMockClient("sb10");
  const judgeClient = createMockClient("judge1");

  // Connect clients
  session.clients.set("dj0", undefined);
  session.clients.set("sb10", undefined);

  const sessionPromise = session.runSession(competitions, permanentClientIds);

  await delay(50);

  // Connect permanent clients
  connectAsUnassigned(deps, session, djClient);
  connectAsUnassigned(deps, session, scoreboardClient);
  connectAsUnassigned(deps, session, judgeClient);

  // Simulate DJ completing performance and judge submitting score
  schedulePerf(10, 0, 100);
  scheduleScore(10, 0, 2, {
    competition_id: 10,
    competitor_id: 100,
    judge_id: 2,
    scores: [{ criteria_id: 1, score: 8.5 }],
  }, 150);

  await sessionPromise;

  // After session, all clients should be in unassigned pool
  assertEquals(deps.unassignedClients.has("dj0"), true);
  assertEquals(deps.unassignedClients.has("sb10"), true);
  assertEquals(deps.unassignedClients.has("judge2"), true);
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

  const permanentClientIds = ["dj0", "sb10"]; // DJ and scoreboard

  const djClient = createMockClient("dj0");
  const scoreboard = createMockClient("sb10");
  const judgeA = createMockClient("judge2");
  const judgeB = createMockClient("judge3");

  const sessionPromise = session.runSession(competitions, permanentClientIds);

  await delay(50);

  // Connect permanent and competition 1 clients
  connectAsUnassigned(deps, session, djClient);
  connectAsUnassigned(deps, session, scoreboard);
  connectAsUnassigned(deps, session, judgeA);

  // Complete competition 1
  schedulePerf(10, 0, 100);
  scheduleScore(10, 0, 2, {
    competition_id: 10,
    competitor_id: 100,
    judge_id: 2,
    scores: [{ criteria_id: 1, score: 8.5 }],
  }, 150);

  await delay(250);

  // After competition 1, permanent clients should still be registered
  assertEquals(session.clients.has("dj0"), true);
  assertEquals(session.clients.has("sb10"), true);
  // Judge A should be moved to unassigned pool
  assertEquals(deps.unassignedClients.has("judge2"), true);

  // Connect judge B for competition 2
  connectAsUnassigned(deps, session, judgeB);

  // Complete competition 2
  schedulePerf(11, 0, 300);
  scheduleScore(11, 0, 3, {
    competition_id: 11,
    competitor_id: 101,
    judge_id: 3,
    scores: [{ criteria_id: 2, score: 7.5 }],
  }, 350);
  await sessionPromise;

  // After session, all clients in unassigned pool
  assertEquals(deps.unassignedClients.has("dj0"), true);
  assertEquals(deps.unassignedClients.has("sb10"), true);
  assertEquals(deps.unassignedClients.has("judge2"), true);
  assertEquals(deps.unassignedClients.has("judge3"), true);
});

Deno.test("Session - reset moves all clients to unassigned pool", () => {
  const deps = createDependencies();
  const session = new Session(1, deps);

  const djClient = createMockClient("dj0");
  const judgeClient = createMockClient("judge2");
  session.clients.set("dj0", djClient);
  session.clients.set("judge2", judgeClient);
  session.clients.set("judge3", undefined); // Disconnected

  // Manually call reset (normally called by runSession finally block)
  session["reset"]();

  // Connected clients should be in unassigned pool
  assertEquals(deps.unassignedClients.has("dj0"), true);
  assertEquals(deps.unassignedClients.has("judge2"), true);

  // Disconnected client should not be in pool
  assertEquals(deps.unassignedClients.has("judge3"), false);
  // All clients should be removed from session
  assertEquals(session.clients.size, 0);
});
