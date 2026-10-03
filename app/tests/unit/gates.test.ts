// The DJ's buttons: every competition waits for the DJ to start it (scoreboards
// say it is about to begin) and the finished session waits for the DJ to end it
// (scoreboards say when the next session starts); only then are judges released.
import { assertEquals } from "@std/assert";
import { Session, type SessionDependencies } from "../../src/session.ts";
import { clearAllResolvers, resolveTag } from "../../src/resolveTag.ts";
import { beginTag, closeTag, perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition } from "../../src/types.ts";
import { createDependencies, createMockClient, delay } from "../test-utils.ts";

const comp = (id: number, name: string, ...competitorIds: number[]) =>
  ({
    id,
    name,
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
  }) as Competition;

const five = [{ criteria_id: 1, score: 5 }];
const sent = (c: { __messages: string[] }, event: string) =>
  c.__messages.filter((m) => m.startsWith(`event: ${event}\n`))
    .map((m) => JSON.parse(m.split("data: ")[1]));

function setup(
  extra: Partial<SessionDependencies> = {},
  judgeConnected = true,
) {
  clearAllResolvers();
  const deps: SessionDependencies = {
    ...createDependencies(),
    djGates: true,
    ...extra,
  };
  const clients: Record<string, ReturnType<typeof createMockClient>> = {};
  for (const id of ["dj1", "sb1", "judge2"]) {
    clients[id] = createMockClient(id);
    if (id !== "judge2" || judgeConnected) {
      deps.unassignedClients.set(id, clients[id]);
    }
  }
  return { session: new Session(1, deps), clients };
}

Deno.test("gates: a competition waits for the DJ, and the session for the DJ to end it", async () => {
  const next = { name: "Evening", startTime: new Date("2026-10-03T19:30:00Z") };
  const { session, clients } = setup({
    followingSession: () => Promise.resolve(next),
  });
  const done = session.runSession([comp(10, "Juniors", 100)], ["dj1", "sb1"]);
  await delay(30);

  // The scoreboard is told what is about to begin; nothing has started.
  assertEquals(sent(clients.sb1, "competition_ready"), [
    { competition_id: 10, name: "Juniors" },
  ]);
  assertEquals(sent(clients.sb1, "competition_start"), []);
  assertEquals(session.status().waiting_for, ["dj-start"]);

  resolveTag(beginTag(10), true); // the DJ presses Start
  await delay(30);
  assertEquals(sent(clients.sb1, "competition_start").length, 1);
  assertEquals(sent(clients.dj1, "performance_start").length, 1);

  resolveTag(perfTag(10, 0), true);
  await delay(20);
  resolveTag(scoreTag(10, 100, 2), five);
  await delay(30);

  // Everything is scored, but the session is not over: it waits for the DJ.
  assertEquals(session.isRunning(), true);
  assertEquals(sent(clients.sb1, "session_finished"), [{
    session_id: 1,
    next_session_name: "Evening",
    next_session_start: "2026-10-03T19:30:00.000Z",
  }]);
  assertEquals(sent(clients.judge2, "session_end"), []); // judge still held
  assertEquals(session.status().waiting_for, ["dj-close"]);

  resolveTag(closeTag(1), true); // the DJ presses End session
  await done;
  assertEquals(sent(clients.judge2, "session_end").length, 1);
  assertEquals(sent(clients.sb1, "session_end")[0].reason, "completed");
});

Deno.test("gates: with no following session the message says so", async () => {
  const { session, clients } = setup();
  const done = session.runSession([comp(10, "Juniors", 100)], ["dj1", "sb1"]);
  await delay(20);
  resolveTag(beginTag(10), true);
  await delay(20);
  resolveTag(perfTag(10, 0), false); // skipped: straight to the end
  await delay(30);
  assertEquals(sent(clients.dj1, "session_finished"), [{
    session_id: 1,
    next_session_name: null,
    next_session_start: null,
  }]);
  resolveTag(closeTag(1), true);
  await done;
});

Deno.test("gates: each competition has its own break", async () => {
  const { session, clients } = setup();
  const done = session.runSession(
    [comp(10, "Juniors", 100), comp(11, "Seniors", 110)],
    ["dj1", "sb1"],
  );
  await delay(20);
  resolveTag(beginTag(10), true);
  await delay(20);
  resolveTag(perfTag(10, 0), false);
  await delay(30);
  // The second competition is announced and waits.
  assertEquals(sent(clients.sb1, "competition_ready").map((m) => m.name), [
    "Juniors",
    "Seniors",
  ]);
  assertEquals(sent(clients.sb1, "competition_start").length, 1);
  resolveTag(beginTag(11), true);
  await delay(20);
  assertEquals(sent(clients.sb1, "competition_start").length, 2);
  resolveTag(perfTag(11, 0), false);
  await delay(30);
  resolveTag(closeTag(1), true);
  await done;
});

Deno.test("gates: pressing Start before the judges are in is not lost", async () => {
  const { session, clients } = setup({}, false);
  const done = session.runSession([comp(10, "Juniors", 100)], ["dj1", "sb1"]);
  await delay(20);
  resolveTag(beginTag(10), true); // early: judge2 has not connected
  await delay(20);
  assertEquals(sent(clients.sb1, "competition_start"), []);

  session.connectClient(clients.judge2); // now they arrive
  await delay(30);
  assertEquals(sent(clients.sb1, "competition_start").length, 1);
  session.abort();
  await done;
});

Deno.test("gates: a DJ that reconnects during the break is asked again", async () => {
  const { session, clients } = setup();
  const done = session.runSession([comp(10, "Juniors", 100)], ["dj1", "sb1"]);
  await delay(20);
  const again = createMockClient("dj1");
  session.connectClient(again);
  await delay(20);
  assertEquals(sent(again, "competition_ready"), [
    { competition_id: 10, name: "Juniors" },
  ]);
  session.abort();
  await done;
  assertEquals(clients.dj1 !== undefined, true);
});

Deno.test("gates: an administrator skip goes on without the DJ", async () => {
  const { session } = setup();
  const done = session.runSession([comp(10, "Juniors", 100)], ["dj1", "sb1"]);
  await delay(20);
  assertEquals(session.skip(), "gate"); // start without the DJ
  await delay(20);
  assertEquals(session.status().phase, "performing");
  resolveTag(perfTag(10, 0), false);
  await delay(30);
  assertEquals(session.status().waiting_for, ["dj-close"]);
  assertEquals(session.skip(), "gate"); // end without the DJ
  await done;
});

Deno.test("gates: a competition already under way before a restart is not held again", async () => {
  const { session, clients } = setup();
  const done = session.runSession(
    [comp(10, "Juniors", 100, 101)],
    ["dj1", "sb1"],
    { finished: new Set(["10:100"]) },
  );
  await delay(30);
  // No "about to begin": the DJ is straight on to 101.
  assertEquals(sent(clients.sb1, "competition_ready"), []);
  assertEquals(sent(clients.dj1, "performance_start"), [
    { competition_id: 10, position: 1 },
  ]);
  session.abort();
  await done;
});

Deno.test("gates: off, the session runs straight through", async () => {
  const { session, clients } = setup({ djGates: false });
  const done = session.runSession([comp(10, "Juniors", 100)], ["dj1", "sb1"]);
  await delay(30);
  assertEquals(sent(clients.sb1, "competition_ready"), []);
  assertEquals(sent(clients.dj1, "performance_start").length, 1);
  resolveTag(perfTag(10, 0), false);
  await done; // no close gate either
});
