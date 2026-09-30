// Contract test: drives the real Hono app (/register, /response) against a real
// Session, using the same tag builders and body shapes the browser clients use.
import { assertEquals } from "@std/assert";
import { app } from "../../src/main.ts";
import { Session } from "../../src/session.ts";
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

async function token(sub: string): Promise<string> {
  const res = await app.request(`/register?sub=${sub}`);
  return (await res.json()).token;
}

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
