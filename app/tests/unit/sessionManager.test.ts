// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertThrows } from "@std/assert";
import { SessionManager, sessions } from "../../src/sessionManager.ts";

const makeDeps = () => {
  return {
    unassignedClients: new Map<string, any>(),
    saveScore: async (_submission: any) => {},
  };
};

Deno.test("SessionManager - createSession should create new session", () => {
  sessions.clear();

  const deps = makeDeps();
  const session = SessionManager.createSession(1, deps);

  assertEquals(session.id, 1);
  assertEquals(sessions.has(1), true);
});
Deno.test("SessionManager - createSession should throw if session exists", () => {
  sessions.clear();

  const deps = makeDeps();
  SessionManager.createSession(1, deps);

  assertThrows(
    () => SessionManager.createSession(1, deps),
    Error,
    "Session 1 already exists",
  );
});
Deno.test("SessionManager - getSession should return existing session", () => {
  sessions.clear();

  const deps = makeDeps();

  const created = SessionManager.createSession(1, deps);
  const retrieved = SessionManager.getSession(1);

  assertEquals(retrieved, created);
});
Deno.test("SessionManager - getSession should return undefined for non-existent", () => {
  sessions.clear();

  const result = SessionManager.getSession(999);

  assertEquals(result, undefined);
});
Deno.test("SessionManager - deleteSession should remove session", () => {
  sessions.clear();

  const deps = makeDeps();

  SessionManager.createSession(1, deps);
  assertEquals(sessions.has(1), true);

  SessionManager.deleteSession(1);
  assertEquals(sessions.has(1), false);
});
Deno.test("SessionManager - findSessionForClient should find session", () => {
  sessions.clear();

  const deps = makeDeps();

  const session = SessionManager.createSession(1, deps);

  // Mock client
  const mockClient = {
    id: "judge5",
    controller: { enqueue: () => {} },
  };

  session.clients.set("judge5", mockClient);

  const found = SessionManager.findSessionForClient("judge5");

  assertEquals(found, session);
});
Deno.test("SessionManager - findSessionForClient should return null if not found", () => {
  sessions.clear();

  const deps = makeDeps();

  SessionManager.createSession(1, deps);

  const result = SessionManager.findSessionForClient("unknown");

  assertEquals(result, null);
});
Deno.test("SessionManager - findSessionForClient should search all sessions", () => {
  sessions.clear();

  const deps = makeDeps();

  // deno-lint-ignore no-unused-vars
  const session1 = SessionManager.createSession(1, deps);
  const session2 = SessionManager.createSession(2, deps);

  const mockClient = {
    id: "dj10",
    type: "dj" as const,
    controller: { enqueue: () => {} },
  };

  session2.clients.set("dj10", mockClient);

  const found = SessionManager.findSessionForClient("dj10");

  assertEquals(found, session2);
});
