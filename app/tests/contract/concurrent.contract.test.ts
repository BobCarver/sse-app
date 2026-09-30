// Two tracks run sessions at the same time: DJ/scoreboard are per track,
// messages never cross tracks, and judge/track conflicts are detected.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { app } from "../../src/main.ts";
import { Session } from "../../src/session.ts";
import { SessionManager, sessions } from "../../src/sessionManager.ts";
import { clearAllResolvers } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition } from "../../src/types.ts";
import { createMockClient, delay } from "../test-utils.ts";

function comp(id: number, competitorId: number, judgeId: number): Competition {
  return {
    id,
    name: `C${id}`,
    competitors: [{ id: competitorId, name: "X", duration: 1000 }],
    rubric: {
      id: 1,
      criteria: [{ id: 1, name: "T" }],
      judges: [{ id: judgeId, name: "J", criteria: [1] }],
    },
  };
}

async function post(sub: string, body: unknown) {
  const { token } = await (await app.request(`/register?sub=${sub}`)).json();
  return app.request("/response", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session_token=${token}`,
    },
    body: JSON.stringify(body),
  });
}

const msgs = (c: ReturnType<typeof createMockClient>) =>
  c.__messages.map((m) => m.split("\n")[0]);

Deno.test("two tracks run concurrently without crossing messages", async () => {
  clearAllResolvers();
  sessions.clear();
  const unassigned = new Map();
  const saved: number[] = [];
  const mk = (id: number, trackId: number, judge: number) =>
    new Session(id, {
      unassignedClients: unassigned,
      trackId,
      claimedClients: [`judge${judge}`],
      saveScore: (s) => {
        saved.push(s.competition_id);
        return Promise.resolve();
      },
    });
  const s1 = mk(1, 1, 5);
  const s2 = mk(2, 2, 6);
  const clients = {
    dj1: createMockClient("dj1"),
    sb1: createMockClient("sb1"),
    judge5: createMockClient("judge5"),
    dj2: createMockClient("dj2"),
    sb2: createMockClient("sb2"),
    judge6: createMockClient("judge6"),
  };
  for (const c of Object.values(clients)) unassigned.set(c.id, c);

  const run1 = s1.runSession([comp(10, 100, 5)], ["dj1", "sb1"]);
  const run2 = s2.runSession([comp(20, 200, 6)], ["dj2", "sb2"]);
  await delay(50);

  // Interleave: track 2 finishes its performance first.
  assertEquals(
    (await post("dj2", { tag: perfTag(20, 0), payload: true })).status,
    200,
  );
  assertEquals(
    (await post("dj1", { tag: perfTag(10, 0), payload: true })).status,
    200,
  );
  await delay(20);
  assertEquals(
    (await post("judge6", {
      tag: scoreTag(20, 200, 6),
      payload: [{ criteria_id: 1, score: 7 }],
    })).status,
    200,
  );
  assertEquals(
    (await post("judge5", {
      tag: scoreTag(10, 100, 5),
      payload: [{ criteria_id: 1, score: 9 }],
    })).status,
    200,
  );
  await Promise.all([run1, run2]);

  assertEquals(saved.sort(), [10, 20]);
  // Track 1 clients only ever saw competition 10; track 2 only competition 20.
  const text = (c: ReturnType<typeof createMockClient>) =>
    c.__messages.join("");
  for (const id of ["dj1", "sb1", "judge5"] as const) {
    assertEquals(text(clients[id]).includes('"competition_id":20'), false, id);
  }
  for (const id of ["dj2", "sb2", "judge6"] as const) {
    assertEquals(text(clients[id]).includes('"competition_id":10'), false, id);
  }
  assertEquals(msgs(clients.sb1).includes("event: score_update"), true);
});

Deno.test("findConflict: one running session per track; judges held until session ends", async () => {
  clearAllResolvers();
  sessions.clear();
  const unassigned = new Map();
  const s1 = SessionManager.createSession(1, {
    unassignedClients: unassigned,
    trackId: 1,
    claimedClients: ["judge5", "judge6"],
    saveScore: () => Promise.resolve(),
  });
  const running = s1.runSession([comp(10, 100, 5)], ["dj1"]); // waits for dj1
  await delay(10);

  // same track
  assertStringIncludes(
    SessionManager.findConflict(2, 1, ["judge9"])!,
    "Track 1",
  );
  // other track, judge already in session 1 (even though not in current competition)
  assertStringIncludes(
    SessionManager.findConflict(2, 2, ["judge6", "judge9"])!,
    "judge6",
  );
  // other track, free judges
  assertEquals(SessionManager.findConflict(2, 2, ["judge9"]), undefined);
  // the session itself is not a conflict with itself (idempotent restart)
  assertEquals(SessionManager.findConflict(1, 1, ["judge5"]), undefined);

  // Session ends -> judges released
  unassigned.set("dj1", createMockClient("dj1"));
  s1.connectClient(unassigned.get("dj1"));
  await delay(20);
  await post("dj1", { tag: perfTag(10, 0), payload: false }); // skipped -> no scoring
  await running;
  SessionManager.deleteSession(1);
  assertEquals(SessionManager.findConflict(2, 1, ["judge5"]), undefined);
});
