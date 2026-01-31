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
