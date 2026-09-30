// deno-lint-ignore-file no-explicit-any
// Backend integration: real Hono app + Postgres. Runs a full session in-process
// (no server): 1 DJ, 2 judges, 1 scoreboard, 1 competition with 2 competitors.
// Requires DATABASE_URL pointing at a database with the schema loaded (empty tables).
import { assert, assertEquals } from "@std/assert";
import { saveScore, sql } from "../../src/db.ts";
import { app } from "../../src/main.ts";
import { SessionManager } from "../../src/sessionManager.ts";
import { clearAllResolvers } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import { delay } from "../test-utils.ts";
import { adminHeaders, cookieFor } from "../auth-utils.ts";

const SEED_SQL = new URL("./seeds/session_seed.sql", import.meta.url).pathname;

type SSEEvent = { event: string; data: any };

/** One persistent reader per stream; events are queued and consumed by name. */
class SSEStream {
  private events: SSEEvent[] = [];
  private ctl = new AbortController();
  private pump!: Promise<void>;

  static async open(sub: string): Promise<SSEStream> {
    const s = new SSEStream();
    const cookie = await cookieFor(sub);
    const res = await app.fetch(
      new Request("http://localhost/events", {
        headers: { cookie },
        signal: s.ctl.signal,
      }),
    );
    assertEquals(res.status, 200, `SSE open failed for ${sub}`);
    s.cookie = cookie;
    s.pump = s.read(res.body!.getReader());
    return s;
  }

  cookie = "";

  private async read(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith(":")) continue; // comment / ping
          let event = "message", data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          this.events.push({
            event,
            data: data ? JSON.parse(data) : undefined,
          });
        }
      }
    } catch (_e) {
      // aborted
    }
  }

  /** Wait for the next event with this name; other events stay queued. */
  async next(name: string, timeout = 3000): Promise<any> {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const i = this.events.findIndex((e) => e.event === name);
      if (i !== -1) return this.events.splice(i, 1)[0].data;
      await delay(10);
    }
    throw new Error(
      `timeout waiting for "${name}"; queued: ${
        this.events.map((e) => e.event)
      }`,
    );
  }

  /** Names of queued (unconsumed) events, in arrival order. */
  queued(): string[] {
    return this.events.map((e) => e.event);
  }

  async close() {
    this.ctl.abort();
    await this.pump;
  }
}

async function respond(stream: SSEStream, body: unknown) {
  const res = await app.fetch(
    new Request("http://localhost/response", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: stream.cookie },
      body: JSON.stringify(body),
    }),
  );
  await res.body?.cancel();
  return res.status;
}

Deno.test({
  name: "Full session flow: 1 DJ, 2 judges, 1 scoreboard, 2 competitors",
  ignore: !sql, // needs DATABASE_URL
  fn: async () => {
    const db = sql!;
    assertEquals(Array.isArray(await db`SELECT 1 as ok`), true);
    await db.unsafe(await Deno.readTextFile(SEED_SQL));

    const streams: SSEStream[] = [];
    try {
      // Track 1 => DJ "dj1" and scoreboard "sb1"; judges by judge id.
      const dj = await SSEStream.open("dj1");
      const j2 = await SSEStream.open("judge2");
      const j3 = await SSEStream.open("judge3");
      const sb = await SSEStream.open("sb1");
      streams.push(dj, j2, j3, sb);

      const start = await app.fetch(
        new Request("http://localhost/sessions/1/start", {
          method: "POST",
          headers: adminHeaders,
        }),
      );
      assertEquals(start.status, 200);
      const started = await start.json();
      assertEquals(started.trackId, 1);

      for (const s of streams) {
        const { competition } = await s.next("competition_start");
        assertEquals(competition.id, 10);
        assertEquals(competition.competitors.map((c: any) => c.id), [100, 101]);
      }

      for (const [pos, competitorId] of [[0, 100], [1, 101]] as const) {
        assertEquals((await dj.next("performance_start")).position, pos);
        assertEquals(
          await respond(dj, { tag: perfTag(10, pos), payload: true }),
          200,
        );

        for (const j of [j2, j3]) {
          const en = await j.next("enable_scoring");
          assertEquals([en.competition_id, en.position], [10, pos]);
        }

        const scores = [{ criteria_id: 1, score: 8.5 }];

        // Bad submissions are refused and don't use up the judge's turn.
        const badTag = scoreTag(10, competitorId, 2);
        assertEquals(
          await respond(j2, {
            tag: badTag,
            payload: [{ criteria_id: 1, score: 11 }],
          }),
          400,
        );
        assertEquals(
          await respond(j2, {
            tag: badTag,
            payload: [{ criteria_id: 99, score: 5 }],
          }),
          400,
        );

        assertEquals(
          await respond(j2, {
            tag: scoreTag(10, competitorId, 2),
            payload: scores,
          }),
          200,
        );
        assertEquals(
          await respond(j3, {
            tag: scoreTag(10, competitorId, 3),
            payload: scores,
          }),
          200,
        );

        const seen = [
          await sb.next("score_update"),
          await sb.next("score_update"),
        ];
        assertEquals(seen.map((s) => s.judge_id).sort(), [2, 3]);
        for (const s of seen) {
          assertEquals([s.competition_id, s.competitor_id], [10, competitorId]);
          assertEquals(s.scores, scores);
        }
      }

      // Session discards itself when finished.
      for (let i = 0; i < 100 && SessionManager.getSession(1); i++) {
        await delay(20);
      }
      assertEquals(SessionManager.getSession(1), undefined);

      // Every judge's score for every competitor was persisted (4 rows).
      const rows = await db`
        SELECT competitor_id, judge_id, criteria_id, score::float AS score
        FROM scores WHERE competition_id = 10
        ORDER BY competitor_id, judge_id`;
      assertEquals(
        rows.map((
          r: any,
        ) => [r.competitor_id, r.judge_id, r.criteria_id, r.score]),
        [[100, 2, 1, 8.5], [100, 3, 1, 8.5], [101, 2, 1, 8.5], [
          101,
          3,
          1,
          8.5,
        ]],
      );

      // Saving again updates in place (idempotent), it does not fail or duplicate.
      await saveScore({
        competition_id: 10,
        competitor_id: 100,
        judge_id: 2,
        scores: [{ criteria_id: 1, score: 6.5 }],
      });
      const [{ n }] =
        await db`SELECT count(*)::int AS n FROM scores WHERE competition_id = 10`;
      assertEquals(n, 4);
      const [{ score }] = await db`
        SELECT score::float AS score FROM scores
        WHERE competition_id = 10 AND competitor_id = 100 AND judge_id = 2`;
      assertEquals(score, 6.5);

      // Track and judges are free again: the session can be started once more.
      assert(
        SessionManager.findConflict(2, 1, ["judge2", "judge3"]) === undefined,
      );
    } finally {
      await Promise.all(streams.map((s) => s.close()));
      await delay(50); // let SSE cleanup clear its ping timers
      // Cleanup seeded rows (deterministic IDs used in seed)
      await db.unsafe(`
      DELETE FROM client_credentials;
    DELETE FROM scores WHERE competition_id = 10;
      DELETE FROM competition_competitors WHERE competition_id = 10;
      DELETE FROM competitions WHERE id = 10;
      DELETE FROM rubric_judge_criteria WHERE rubric_id = 1 AND judge_id IN (2,3);
      DELETE FROM rubric_judges WHERE rubric_id = 1 AND judge_id IN (2,3);
      DELETE FROM rubric_criteria WHERE rubric_id = 1 AND criteria_id = 1;
      DELETE FROM criteria WHERE id = 1;
      DELETE FROM rubrics WHERE id = 1;
      DELETE FROM competitors WHERE id IN (100,101);
      DELETE FROM judges WHERE id IN (2,3);
      DELETE FROM users WHERE id IN (10,11);
      DELETE FROM sessions WHERE id = 1;
      DELETE FROM tracks WHERE id = 1;
      DELETE FROM festivals WHERE id = 1;
    `);
    }
  },
});

async function seed(db: NonNullable<typeof sql>) {
  await db.unsafe(await Deno.readTextFile(SEED_SQL));
}

async function unseed(db: NonNullable<typeof sql>) {
  await db.unsafe(`
    DELETE FROM client_credentials;
    DELETE FROM scores WHERE competition_id = 10;
    DELETE FROM competition_competitors WHERE competition_id = 10;
    DELETE FROM competitions WHERE id = 10;
    DELETE FROM rubric_judge_criteria WHERE rubric_id = 1 AND judge_id IN (2,3);
    DELETE FROM rubric_judges WHERE rubric_id = 1 AND judge_id IN (2,3);
    DELETE FROM rubric_criteria WHERE rubric_id = 1 AND criteria_id = 1;
    DELETE FROM criteria WHERE id = 1;
    DELETE FROM rubrics WHERE id = 1;
    DELETE FROM competitors WHERE id IN (100,101);
    DELETE FROM judges WHERE id IN (2,3);
    DELETE FROM users WHERE id IN (10,11);
    DELETE FROM sessions WHERE id = 1;
    DELETE FROM tracks WHERE id = 1;
    DELETE FROM festivals WHERE id = 1;
  `);
}

Deno.test({
  name:
    "Reconnects: streams killed and reopened mid-performance and mid-scoring recover",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const open: SSEStream[] = [];
    const track = async (p: Promise<SSEStream>) => {
      const s = await p;
      open.push(s);
      return s;
    };
    try {
      const dj = await track(SSEStream.open("dj1"));
      const j2 = await track(SSEStream.open("judge2"));
      const j3 = await track(SSEStream.open("judge3"));
      const sb = await track(SSEStream.open("sb1"));
      const start = await app.fetch(
        new Request("http://localhost/sessions/1/start", {
          method: "POST",
          headers: adminHeaders,
        }),
      );
      assertEquals(start.status, 200);
      for (const s of [dj, j2, j3, sb]) await s.next("competition_start");
      await dj.next("performance_start"); // competitor 100, position 0

      // --- mid-performance: DJ and scoreboard drop and come back -----------
      await dj.close();
      const dj2 = await track(SSEStream.open("dj1"));
      assertEquals((await dj2.next("competition_start")).competition.id, 10);
      // DJ resumes with performance_recovery, NOT performance_start (which would replay the announcement)
      assertEquals((await dj2.next("performance_recovery")).position, 0);
      assertEquals(dj2.queued().includes("performance_start"), false);

      await sb.close();
      const sb2 = await track(SSEStream.open("sb1"));
      await sb2.next("competition_start");
      assertEquals((await sb2.next("performance_start")).position, 0);

      assertEquals(
        await respond(dj2, { tag: perfTag(10, 0), payload: true }),
        200,
      );
      for (const j of [j2, j3]) await j.next("enable_scoring");

      // --- mid-scoring: judge 2 submits, then everyone reconnects ----------
      const scores = [{ criteria_id: 1, score: 8 }];
      assertEquals(
        await respond(j2, { tag: scoreTag(10, 100, 2), payload: scores }),
        200,
      );
      await sb2.next("score_update");

      await j2.close();
      await j3.close();
      await sb2.close();
      const j2b = await track(SSEStream.open("judge2"));
      const j3b = await track(SSEStream.open("judge3"));
      const sb3 = await track(SSEStream.open("sb1"));

      // judge 3 has not submitted: gets the whole picture and can still submit
      await j3b.next("competition_start");
      assertEquals((await j3b.next("performance_start")).position, 0);
      assertEquals((await j3b.next("enable_scoring")).position, 0);
      // judge 2 already submitted: no window is reopened
      await j2b.next("competition_start");
      await j2b.next("performance_start");
      await new Promise((r) => setTimeout(r, 100));
      assertEquals(j2b.queued().includes("enable_scoring"), false);
      // scoreboard gets the score judge 2 already gave
      await sb3.next("competition_start");
      await sb3.next("performance_start");
      const replayed = await sb3.next("score_update");
      assertEquals([replayed.judge_id, replayed.scores], [2, scores]);
      // ...and judges never see others' scores in a replay
      assertEquals(j3b.queued().includes("score_update"), false);

      // the reconnected judge's submission is accepted, live scoreboard updates
      assertEquals(
        await respond(j3b, { tag: scoreTag(10, 100, 3), payload: scores }),
        200,
      );
      assertEquals((await sb3.next("score_update")).judge_id, 3);

      // finish the second competitor so the session ends cleanly
      assertEquals((await dj2.next("performance_start")).position, 1);
      assertEquals(
        await respond(dj2, { tag: perfTag(10, 1), payload: false }),
        200,
      ); // skipped
      for (let i = 0; i < 100 && SessionManager.getSession(1); i++) {
        await delay(20);
      }
      assertEquals(SessionManager.getSession(1), undefined);
    } finally {
      await Promise.all(open.map((s) => s.close()));
      await delay(50);
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Duplicate tab: the newer connection wins and the older one is told to stop",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const open: SSEStream[] = [];
    try {
      const first = await SSEStream.open("judge2");
      open.push(first);
      const second = await SSEStream.open("judge2"); // e.g. a second tab
      open.push(second);
      await first.next("superseded");

      // The session still works with the newer connection.
      const others = [
        SSEStream.open("dj1"),
        SSEStream.open("judge3"),
        SSEStream.open("sb1"),
      ];
      for (const p of others) open.push(await p);
      const start = await app.fetch(
        new Request("http://localhost/sessions/1/start", {
          method: "POST",
          headers: adminHeaders,
        }),
      );
      assertEquals(start.status, 200);
      await second.next("competition_start");
      assertEquals(first.queued().includes("competition_start"), false);

      // Stopping the session's clients so it does not hang: abort everything.
    } finally {
      await Promise.all(open.map((s) => s.close()));
      await delay(100);
      SessionManager.deleteSession(1);
      clearAllResolvers(); // the abandoned session is still waiting on its DJ
      await delay(50);
      await unseed(db);
    }
  },
});
