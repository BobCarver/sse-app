// "start" resumes where a session left off: finished competitors are not run again.
import { assertEquals } from "@std/assert";
import { finishedCompetitors } from "../../src/resume.ts";
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
    judges: [{ id: 2, name: "J2", criteria: [1] }],
  },
});

Deno.test("finishedCompetitors: skipped, and performed with a saved score", () => {
  const rows = {
    sessionStatus: "active",
    competitors: [
      { competition_id: 10, competitor_id: 100, status: "performed" },
      { competition_id: 10, competitor_id: 101, status: "skipped" },
      { competition_id: 10, competitor_id: 102, status: "performed" }, // never scored
      { competition_id: 10, competitor_id: 103, status: "upcoming" },
    ],
    scored: [{ competition_id: 10, competitor_id: 100 }],
  };
  const done = finishedCompetitors([comp(10, 100, 101, 102, 103)], rows);
  assertEquals([...done].sort(), ["10:100", "10:101"]);
});

Deno.test("finishedCompetitors: a completed session starts from scratch", () => {
  const rows = {
    sessionStatus: "completed",
    competitors: [{
      competition_id: 10,
      competitor_id: 100,
      status: "performed",
    }],
    scored: [{ competition_id: 10, competitor_id: 100 }],
  };
  assertEquals(finishedCompetitors([comp(10, 100)], rows).size, 0);
  assertEquals(finishedCompetitors([comp(10, 100)], undefined).size, 0);
});

Deno.test("runSession: finished competitors are not run again, positions are kept", async () => {
  clearAllResolvers();
  const deps: SessionDependencies = createDependencies();
  const events: ProgressEvent[] = [];
  deps.recordProgress = (e) => {
    events.push(e);
    return Promise.resolve();
  };
  const clients: Record<string, ReturnType<typeof createMockClient>> = {};
  for (const id of ["dj1", "sb1", "judge2"]) {
    clients[id] = createMockClient(id);
    deps.unassignedClients.set(id, clients[id]);
  }
  const session = new Session(1, deps);
  const done = session.runSession(
    [comp(10, 100, 101), comp(11, 110)],
    ["dj1", "sb1"],
    new Set(["10:100", "11:110"]),
  );
  await delay(30);
  const starts = clients.dj1.__messages
    .filter((m: string) => m.startsWith("event: performance_start\n"))
    .map((m: string) => JSON.parse(m.split("data: ")[1]));
  assertEquals(starts, [{ competition_id: 10, position: 1 }]);

  resolveTag(perfTag(10, 1), true);
  await delay(20);
  resolveTag(scoreTag(10, 101, 2), [{ criteria_id: 1, score: 5 }]);
  await done;

  assertEquals(events[0], { kind: "session_started", resume: true });
  assertEquals(
    events.filter((e) => e.kind === "competition_started").length,
    1, // competition 11 had nothing left
  );
});
