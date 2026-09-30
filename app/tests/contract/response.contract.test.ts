// Contract test: drives the real Hono app (/response, with issued credentials) against a real
// Session, using the same tag builders and body shapes the browser clients use.
import { assertEquals } from "@std/assert";
import { app } from "../../src/main.ts";
import { secretFor } from "../auth-utils.ts";
import { Session } from "../../src/session.ts";
import { sessions } from "../../src/sessionManager.ts";
import { clearAllResolvers } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import type { Competition, ScoreSubmission } from "../../src/types.ts";
import { createMockClient, delay } from "../test-utils.ts";

const competition: Competition = {
  id: 10,
  name: "Contest",
  competitors: [{ id: 100, name: "A", duration: 1000 }],
  rubric: {
    id: 1,
    criteria: [{ id: 1, name: "Technique" }, { id: 2, name: "Artistry" }],
    judges: [{ id: 2, name: "J", criteria: [1, 2] }],
  },
};

const token = secretFor;

async function post(tok: string, body: unknown, raw = false) {
  return await app.request("/response", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `session_token=${tok}`,
    },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

Deno.test("contract: full flow via POST /response resolves session waits", async () => {
  clearAllResolvers();
  const saved: ScoreSubmission[] = [];
  const unassignedClients = new Map();
  const session = new Session(1, {
    unassignedClients,
    saveScore: (s) => {
      saved.push(s);
      return Promise.resolve();
    },
  });
  const dj = createMockClient("dj0");
  const judge = createMockClient("judge2");
  unassignedClients.set(dj.id, dj);
  unassignedClients.set(judge.id, judge);

  sessions.set(1, session);
  const done = session.runSession([competition], ["dj0"]);
  await delay(50);

  const djTok = await token("dj0");
  const judgeTok = await token("judge2");

  // DJ completes the performance at position 0
  let res = await post(djTok, { tag: perfTag(10, 0), payload: true });
  assertEquals(res.status, 200);
  await delay(20);

  // Judge submits scores
  const scores = [{ criteria_id: 1, score: 8 }, { criteria_id: 2, score: 9.5 }];
  res = await post(judgeTok, { tag: scoreTag(10, 100, 2), payload: scores });
  assertEquals(res.status, 200);

  await done;
  assertEquals(saved.length, 1);
  assertEquals(saved[0].judge_id, 2);
  assertEquals(saved[0].scores, scores);
});

Deno.test("contract: rejects malformed requests", async () => {
  clearAllResolvers();
  const tok = await token("judge2");
  assertEquals((await post(tok, "not json", true)).status, 400);
  assertEquals((await post(tok, {})).status, 400);
  assertEquals((await post(tok, { tag: "error:boom" })).status, 400);
  assertEquals(
    (await post(tok, { tag: perfTag(10, 0), payload: "yes" })).status,
    400,
  );
  assertEquals(
    (await post(tok, { tag: scoreTag(10, 100, 2), payload: undefined })).status,
    400,
  );
  assertEquals(
    (await post(tok, {
      tag: scoreTag(10, 100, 2),
      payload: [{ criteria_id: 1, score: NaN }],
    })).status,
    400,
  );
});

Deno.test("contract: valid tag with nobody waiting is 404; no token is 401", async () => {
  clearAllResolvers();
  const tok = await token("dj0");
  assertEquals(
    (await post(tok, { tag: perfTag(99, 0), payload: true })).status,
    404,
  );
  const res = await app.request("/response", {
    method: "POST",
    body: JSON.stringify({ tag: perfTag(99, 0), payload: true }),
  });
  assertEquals(res.status, 401);
});

Deno.test("contract: score validation against the live rubric", async () => {
  clearAllResolvers();
  sessions.clear();
  const saved: ScoreSubmission[] = [];
  const unassignedClients = new Map();
  const session = new Session(1, {
    unassignedClients,
    saveScore: (s) => {
      saved.push(s);
      return Promise.resolve();
    },
  });
  unassignedClients.set("dj0", createMockClient("dj0"));
  unassignedClients.set("judge2", createMockClient("judge2"));
  sessions.set(1, session);
  const done = session.runSession([competition], ["dj0"]);
  await delay(50);

  const judgeTok = await token("judge2");
  const tag = scoreTag(10, 100, 2);
  const ok = [{ criteria_id: 1, score: 8 }, { criteria_id: 2, score: 9 }];

  // Still in the performance phase: scoring is not open yet.
  assertEquals((await post(judgeTok, { tag, payload: ok })).status, 404);

  await post(await token("dj0"), { tag: perfTag(10, 0), payload: true });
  await delay(20);

  // Wrong competitor / competition: window is closed for them.
  assertEquals(
    (await post(judgeTok, { tag: scoreTag(10, 999, 2), payload: ok })).status,
    404,
  );
  // Judge that is not in this competition's rubric.
  assertEquals(
    (await post(judgeTok, { tag: scoreTag(10, 100, 7), payload: ok })).status,
    404,
  ); // no waiter for judge 7

  const bad: unknown[] = [
    [{ criteria_id: 1, score: 8 }], // missing criterion 2
    [...ok, { criteria_id: 3, score: 5 }], // extra criterion
    [{ criteria_id: 1, score: 8 }, { criteria_id: 1, score: 9 }], // duplicate
    [{ criteria_id: 1, score: 0.5 }, { criteria_id: 2, score: 9 }], // below min
    [{ criteria_id: 1, score: 10.5 }, { criteria_id: 2, score: 9 }], // above max
  ];
  for (const payload of bad) {
    assertEquals(
      (await post(judgeTok, { tag, payload })).status,
      400,
      JSON.stringify(payload),
    );
  }

  // Rejected attempts did not consume the judge's slot: a valid retry works,
  // and scores are rounded to the one decimal the database stores.
  const res = await post(judgeTok, {
    tag,
    payload: [{ criteria_id: 1, score: 8.46 }, { criteria_id: 2, score: 9 }],
  });
  assertEquals(res.status, 200);
  await done;
  assertEquals(saved.length, 1);
  assertEquals(saved[0].scores, [
    { criteria_id: 1, score: 8.5 },
    { criteria_id: 2, score: 9 },
  ]);
  sessions.clear();
});
