// tests/sse.test.ts
import { assertEquals } from "@std/assert";
import { SessionManager, sessions } from "../../src/sessionManager.ts";
import type { SSEClient } from "../../src/types.ts";
import { clearAllResolvers } from "../../src/resolveTag.ts";
import {
  connectAsUnassigned,
  createDependencies,
  createMockClient,
  delay,
  schedulePerf,
  scheduleScore,
} from "../test-utils.ts";

Deno.test("SSE - createClient should create client with controller", () => {
  const messages: string[] = [];

  const mockStream = {
    write: (chunk: string) => {
      messages.push(chunk);
      return Promise.resolve();
    },
  };

  const client: SSEClient = {
    id: "judge1",
    controller: {
      enqueue: (chunk: string) => {
        mockStream.write(chunk);
      },
    },
  };

  client.controller.enqueue("test message");

  assertEquals(messages.length, 1);
  assertEquals(messages[0], "test message");
});

Deno.test("SSE - registerClient should add to session if slot exists", () => {
  sessions.clear();
  const deps = createDependencies();
  const session = SessionManager.createSession(1, deps);

  const mockClient = createMockClient("judge5");

  // Pre-register client slot in session
  session.clients.set("judge5", undefined);

  // This simulates what registerClient does
  const foundSession = SessionManager.findSessionForClient("judge5");
  if (foundSession) {
    foundSession.connectClient(mockClient);
  }

  assertEquals(session.clients.get("judge5"), mockClient);
});

Deno.test("SSE - registerClient should add to unassigned if no session", () => {
  sessions.clear();
  const deps = createDependencies();

  const mockClient = createMockClient("judge5");

  // No session has this client registered
  const foundSession = SessionManager.findSessionForClient("judge5");

  if (!foundSession) {
    // Add to unassigned pool
    deps.unassignedClients.set("judge5", mockClient);
  }

  assertEquals(deps.unassignedClients.get("judge5"), mockClient);
});

Deno.test("SSE - cleanup should mark client as disconnected", () => {
  sessions.clear();
  const deps = createDependencies();
  const session = SessionManager.createSession(1, deps);

  const mockClient = createMockClient("judge5");

  session.clients.set("judge5", mockClient);
  assertEquals(session.clients.get("judge5"), mockClient);

  // Simulate cleanup - should call disconnectClient
  session.disconnectClient("judge5");

  // Client slot should still exist but marked as undefined
  assertEquals(session.clients.has("judge5"), true);
  assertEquals(session.clients.get("judge5"), undefined);
});

Deno.test("SSE - client from unassigned pool assigned to session", () => {
  sessions.clear();
  const deps = createDependencies();
  const session = SessionManager.createSession(1, deps);

  const mockClient = createMockClient("judge5");

  // Add client to unassigned pool
  deps.unassignedClients.set("judge5", mockClient);
  assertEquals(deps.unassignedClients.has("judge5"), true);

  // Session registers this client (simulates competition starting)
  session.clients.set("judge5", undefined);

  // Check unassigned pool and assign
  const unassignedClient = deps.unassignedClients.get("judge5");
  if (unassignedClient) {
    session.clients.set("judge5", unassignedClient);
    deps.unassignedClients.delete("judge5");
  }

  // Should be in session now
  assertEquals(session.clients.get("judge5"), mockClient);
  // Should be removed from unassigned pool
  assertEquals(deps.unassignedClients.has("judge5"), false);
});

Deno.test("SSE - client moved back to unassigned when not needed", () => {
  sessions.clear();
  const deps = createDependencies();
  const session = SessionManager.createSession(1, deps);

  const mockClient = createMockClient("judge5");

  // Client is part of session
  session.clients.set("judge5", mockClient);

  // Simulate client no longer needed (between competitions)
  const client = session.clients.get("judge5");
  if (client !== undefined) {
    deps.unassignedClients.set("judge5", client);
  }
  session.clients.delete("judge5");

  // Should be removed from session
  assertEquals(session.clients.has("judge5"), false);
  // Should be in unassigned pool
  assertEquals(deps.unassignedClients.get("judge5"), mockClient);
});

Deno.test("Integration - full session flow with permanent clients", async () => {
  clearAllResolvers();
  sessions.clear();

  const deps = createDependencies();
  const session = SessionManager.createSession(1, deps);

  // Mock competition data
  const competitions = [{
    id: 10,
    name: "Test Competition",
    competitors: [
      { id: 100, name: "Competitor 1", duration: 120 },
    ],
    rubric: {
      id: 1,
      criteria: [{ id: 1, name: "Technique" }],
      judges: [{ id: 2, name: "Judge 1", criteria: [1] }],
    },
  }];

  const permanentClientIds = ["dj0", "sb10"]; // DJ and scoreboard

  // Create mock clients
  const djMessages: string[] = [];
  const judgeMessages: string[] = [];
  const scoreboardMessages: string[] = [];

  const djClient: SSEClient = {
    id: "dj0",
    controller: {
      enqueue: (msg: string) => djMessages.push(msg),
    },
  };

  const judgeClient: SSEClient = {
    id: "judge2",
    controller: {
      enqueue: (msg: string) => judgeMessages.push(msg),
    },
  };

  const scoreboardClient: SSEClient = {
    id: "sb10",
    controller: {
      enqueue: (msg: string) => scoreboardMessages.push(msg),
    },
  };

  // Start session
  const sessionPromise = session.runSession(competitions, permanentClientIds);

  await delay(50);

  // Connect clients
  connectAsUnassigned(deps, session, djClient);
  connectAsUnassigned(deps, session, scoreboardClient);
  connectAsUnassigned(deps, session, judgeClient);

  // Simulate DJ completing performance and judge submitting score
  schedulePerf(10, 0, 100);
  scheduleScore(10, 100, 2, [{ criteria_id: 1, score: 8.5 }], 150);

  await sessionPromise;

  // Verify clients received messages
  assertEquals(djMessages.length > 0, true);
  assertEquals(judgeMessages.length > 0, true);
  assertEquals(scoreboardMessages.length > 0, true);

  // Verify all clients moved to unassigned pool after session
  assertEquals(deps.unassignedClients.has("dj0"), true);
  assertEquals(deps.unassignedClients.has("judge2"), true);
  assertEquals(deps.unassignedClients.has("sb10"), true);
});
