// Who receives which live event.
import { assertEquals } from "@std/assert";
import { Session } from "../../src/session.ts";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition } from "../../src/types.ts";
import { createDependencies, createMockClient, delay } from "../test-utils.ts";

const competition: Competition = {
  id: 10,
  name: "C",
  competitors: [{ id: 100, name: "A", duration: 1 }],
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "T" }],
    judges: [{ id: 2, name: "J2", criteria: [1] }, {
      id: 3,
      name: "J3",
      criteria: [1],
    }],
  },
};

const events = (c: { __messages: string[] }) =>
  c.__messages.map((m) => m.split("\n")[0].replace("event: ", ""));

Deno.test("routing: enable_scoring reaches judges only; score_update reaches scoreboards only", async () => {
  clearAllResolvers();
  const deps = createDependencies();
  const session = new Session(1, deps);
  const c = Object.fromEntries(
    ["dj1", "sb1", "judge2", "judge3"].map((id) => [id, createMockClient(id)]),
  );
  for (const id of Object.keys(c)) deps.unassignedClients.set(id, c[id]);

  const done = session.runSession([competition], ["dj1", "sb1"]);
  await delay(30);
  resolveTag(perfTag(10, 0), true);
  await delay(20);
  resolveTag(scoreTag(10, 100, 2), [{ criteria_id: 1, score: 7 }]);
  await delay(20);

  // Judge 3 has not submitted yet, and must not have seen judge 2's score.
  assertEquals(events(c.judge3).includes("score_update"), false);

  resolveTag(scoreTag(10, 100, 3), [{ criteria_id: 1, score: 8 }]);
  await done;

  const count = (id: string, name: string) =>
    events(c[id]).filter((e) => e === name).length;
  // enable_scoring: judges only
  assertEquals([
    count("judge2", "enable_scoring"),
    count("judge3", "enable_scoring"),
  ], [1, 1]);
  assertEquals(
    [count("dj1", "enable_scoring"), count("sb1", "enable_scoring")],
    [0, 0],
  );
  // score_update: scoreboard only, both scores
  assertEquals(count("sb1", "score_update"), 2);
  for (const id of ["dj1", "judge2", "judge3"]) {
    assertEquals(count(id, "score_update"), 0, id);
  }
  // everyone still gets the shared flow events
  for (const id of Object.keys(c)) {
    assertEquals(count(id, "competition_start"), 1, id);
    assertEquals(count(id, "performance_start"), 1, id);
  }
});
