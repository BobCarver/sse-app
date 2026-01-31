import { assertEquals } from "std/assert/equals";
import { assertRejects } from "std/assert/rejects";
import { clearAllResolvers } from "../../src/resolveTag.ts";
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
