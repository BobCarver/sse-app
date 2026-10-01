// A skipped performance moves the session on to the next competitor and is
// recorded as skipped (the rest of the skip/abort mechanics are in operations.test.ts).
import { assertEquals } from "@std/assert";
import { Session, type SessionDependencies } from "../../src/session.ts";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition, ProgressEvent } from "../../src/types.ts";
import { createDependencies, createMockClient, delay } from "../test-utils.ts";

const comp = (id: number, ...competitorIds: number[]): Competition => ({
  id,
  name: `C${id}`,
  competitors: competitorIds.map((c) => ({
    id: c,
    name: `P${c}`,
    duration: 60,
  })),
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }],
    judges: [{ id: 2, name: "J2", criteria: [1] }, {
      id: 3,
      name: "J3",
      criteria: [1],
    }],
  },
});

const five = [{ criteria_id: 1, score: 5 }];
const positions = (c: { __messages: string[] }) =>
  c.__messages.filter((m) => m.startsWith("event: performance_start\n"))
    .map((m) => JSON.parse(m.split("data: ")[1]).position);

function setup() {
  clearAllResolvers();
  const deps: SessionDependencies = createDependencies();
  const events: ProgressEvent[] = [];
  deps.recordProgress = (e) => {
    events.push(e);
    return Promise.resolve();
  };
  const session = new Session(1, deps);
  const clients: Record<string, ReturnType<typeof createMockClient>> = {};
  for (const id of ["dj1", "sb1", "judge2", "judge3"]) {
    clients[id] = createMockClient(id);
    deps.unassignedClients.set(id, clients[id]);
  }
  /** What happened to each competitor, in order: "performed:101", "skipped:100"... */
  const outcomes = () =>
    events.filter((e) =>
      e.kind === "competitor_performed" || e.kind === "competitor_skipped"
    )
      .map((e) =>
        `${e.kind.replace("competitor_", "")}:${
          (e as { competitorId: number }).competitorId
        }`
      );
  return { session, clients, events, outcomes };
}

Deno.test("skip: the DJ skips one competitor and the session goes on with the next, scoring only those who performed", async () => {
  const { session, clients, outcomes } = setup();
  const done = session.runSession([comp(10, 100, 101, 102)], ["dj1", "sb1"]);
  await delay(30);

  resolveTag(perfTag(10, 0), false); // DJ skips competitor 100
  await delay(30);
  assertEquals(positions(clients.dj1), [0, 1]); // straight on to the next one
  assertEquals(session.isRunning(), true); // the session did NOT end
  assertEquals(
    clients.judge2.__messages.some((m: string) =>
      m.startsWith("event: enable_scoring")
    ),
    false,
    "nobody is asked to score a skipped competitor",
  );

  resolveTag(perfTag(10, 1), true); // 101 performs
  await delay(20);
  resolveTag(scoreTag(10, 101, 2), five);
  resolveTag(scoreTag(10, 101, 3), five);
  await delay(30);
  assertEquals(positions(clients.dj1), [0, 1, 2]);

  resolveTag(perfTag(10, 2), false); // and 102 is skipped too
  await done;
  assertEquals(session.endReason, "completed");
  assertEquals(outcomes(), ["skipped:100", "performed:101", "skipped:102"]);
});

Deno.test("skip: an administrator's skip is recorded the same way", async () => {
  const { session, outcomes } = setup();
  const done = session.runSession([comp(10, 100, 101)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(session.skip(), "performance");
  await delay(30);
  assertEquals(outcomes(), ["skipped:100"]);
  session.abort();
  await done;
});

Deno.test("skip: a DJ that never answers is recorded as skipped when the performance times out", async () => {
  const { session, clients, outcomes } = setup();
  Deno.env.set("PERFORMANCE_TIMEOUT_MS", "40");
  try {
    const done = session.runSession([comp(10, 100, 101)], ["dj1", "sb1"]);
    await delay(150);
    // Competitor 100 timed out and is recorded as skipped; the session went on
    // to 101 (which, with the DJ still silent, times out as well).
    assertEquals(outcomes()[0], "skipped:100");
    assertEquals(positions(clients.dj1).slice(0, 2), [0, 1]);
    session.abort(); // a no-op if it has already finished
    await done;
  } finally {
    Deno.env.delete("PERFORMANCE_TIMEOUT_MS");
  }
});

Deno.test("skip: stopping the session mid-performance does not mark the competitor skipped", async () => {
  const { session, outcomes } = setup();
  const done = session.runSession([comp(10, 100, 101)], ["dj1", "sb1"]);
  await delay(30);
  session.abort();
  await done;
  assertEquals(outcomes(), []);
});
