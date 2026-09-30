// The session holds its start until the DJ reports it holds the session's audio.
import { assertEquals } from "@std/assert";
import { Session, type SessionDependencies } from "../../src/session.ts";
import { clearAllResolvers, getPendingTags } from "../../src/resolveTag.ts";
import type { Competition } from "../../src/types.ts";
import { createDependencies, createMockClient, delay } from "../test-utils.ts";

const comp: Competition = {
  id: 10,
  name: "C10",
  competitors: [{ id: 100, name: "P", duration: 60 }],
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }],
    judges: [{ id: 2, name: "J2", criteria: [1] }],
  },
};

function setup(reported?: string, expected = "abc") {
  clearAllResolvers();
  const deps: SessionDependencies = createDependencies();
  const reports = new Map<string, string>();
  if (reported) reports.set("dj1", reported);
  deps.audioGate = {
    expectedDigest: () => Promise.resolve(expected),
    reported: (id: string) => reports.get(id),
  };
  const session = new Session(1, deps);
  for (const id of ["dj1", "sb1", "judge2"]) {
    deps.unassignedClients.set(id, createMockClient(id));
  }
  return { session };
}

const started = (s: Session) => s.currentPhase === "performing";

Deno.test("audio gate: a DJ that already reported the right set does not delay the start", async () => {
  const { session } = setup("abc");
  const done = session.runSession([comp], ["dj1", "sb1"]);
  await delay(40);
  assertEquals(started(session), true);
  session.abort();
  await done;
});

Deno.test("audio gate: waits (visibly) until the DJ reports the expected digest", async () => {
  const { session } = setup();
  const done = session.runSession([comp], ["dj1", "sb1"]);
  await delay(40);
  assertEquals(started(session), false);
  assertEquals(session.status().waiting_for, ["audio:dj1"]);

  await session.audioReported("dj1", "stale"); // wrong set: still waiting
  await delay(20);
  assertEquals(session.status().waiting_for, ["audio:dj1"]);

  await session.audioReported("dj1", "abc");
  await delay(40);
  assertEquals(started(session), true);
  assertEquals(getPendingTags().includes("required:audio:dj1"), false);
  session.abort();
  await done;
});

Deno.test("audio gate: the operator can skip the wait", async () => {
  const { session } = setup();
  const done = session.runSession([comp], ["dj1", "sb1"]);
  await delay(40);
  assertEquals(session.skip(), "waiting");
  await delay(40);
  assertEquals(started(session), true);
  session.abort();
  await done;
});

Deno.test("audio gate: nothing to wait for when the session has no audio", async () => {
  const { session } = setup(undefined, "");
  const done = session.runSession([comp], ["dj1", "sb1"]);
  await delay(40);
  assertEquals(started(session), true);
  session.abort();
  await done;
});

Deno.test("audio gate: a report from another client is ignored", async () => {
  const { session } = setup();
  const done = session.runSession([comp], ["dj1", "sb1"]);
  await delay(40);
  await session.audioReported("dj9", "abc");
  await delay(20);
  assertEquals(started(session), false);
  session.abort();
  await done;
});
