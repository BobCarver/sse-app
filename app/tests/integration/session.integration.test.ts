// deno-lint-ignore-file no-explicit-any
// Backend integration: real Hono app + Postgres. Runs a full session in-process
// (no server): 1 DJ, 2 judges, 1 scoreboard, 1 competition with 2 competitors.
// Requires DATABASE_URL pointing at a database with the schema loaded (empty tables).
import { assert, assertEquals } from "@std/assert";
import {
  getNextSessionForTrack,
  getResumeRows,
  getSessionCompetitionsWithRubrics,
  getSessionTrackId,
  recordProgress,
  resetSession,
  saveScore,
  sql,
} from "../../src/db.ts";
import { planResume } from "../../src/resume.ts";
import { Hono } from "@hono/hono";
import {
  app,
  audio,
  credentials,
  resumeActiveSessions,
} from "../../src/main.ts";
import { registerDemoRoutes } from "../../src/demo.ts";
import { announceAudio } from "../../src/audioAnnouncer.ts";
import { SessionManager } from "../../src/sessionManager.ts";
import { clearAllResolvers } from "../../src/resolveTag.ts";
import { perfTag, scoreTag } from "../../src/contract.ts";
import { createMockClient, delay } from "../test-utils.ts";
import { adminHeaders, cookieFor } from "../auth-utils.ts";

// These tests need a database and are skipped without one. CI sets REQUIRE_DB=1
// so a missing/misconfigured database fails loudly instead of skipping silently.
Deno.test("integration: database is configured when required", () => {
  if (Deno.env.get("REQUIRE_DB") && !sql) {
    throw new Error("REQUIRE_DB is set but DATABASE_URL is not (no database)");
  }
});

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

      // Progress was persisted: everything completed, no dangling pointers.
      const [ses] = await db`
        SELECT status, current_competition, current_competitor
        FROM sessions WHERE id = 1`;
      assertEquals(ses.status, "completed");
      assertEquals(ses.current_competition, null);
      assertEquals(ses.current_competitor, null);
      const [comp] = await db`SELECT status FROM competitions WHERE id = 10`;
      assertEquals(comp.status, "completed");
      const [track] = await db`SELECT current_session FROM tracks WHERE id = 1`;
      assertEquals(track.current_session, null);
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

const admin = async (method: string, path: string): Promise<Response> =>
  await app.fetch(
    new Request(`http://localhost${path}`, { method, headers: adminHeaders }),
  );

Deno.test({
  name:
    "Operator: skip past a judge who never connects; their scores are recorded as absent",
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
      const j2 = await track(SSEStream.open("judge2")); // judge3 never shows up
      const sb = await track(SSEStream.open("sb1"));
      const start = await admin("POST", "/sessions/1/start");
      assertEquals(start.status, 200);
      await start.body?.cancel();

      // The session is stuck; the operator can see on whom.
      await delay(150);
      const list = await (await admin("GET", "/admin/sessions")).json();
      assertEquals([list[0].running, list[0].waiting_for], [true, ["judge3"]]);

      const skip = await admin("POST", "/admin/sessions/1/skip");
      assertEquals((await skip.json()).skipped, "waiting");
      for (const s of [dj, j2, sb]) await s.next("competition_start");

      const scores = [{ criteria_id: 1, score: 7 }];
      for (const [pos, competitorId] of [[0, 100], [1, 101]] as const) {
        assertEquals((await dj.next("performance_start")).position, pos);
        assertEquals(
          await respond(dj, { tag: perfTag(10, pos), payload: true }),
          200,
        );
        await j2.next("enable_scoring");
        // only judge 2 is waited for: the competitor finishes as soon as they score
        assertEquals(
          await respond(j2, {
            tag: scoreTag(10, competitorId, 2),
            payload: scores,
          }),
          200,
        );
        assertEquals((await sb.next("score_update")).judge_id, 2);
      }
      for (let i = 0; i < 100 && SessionManager.getSession(1); i++) {
        await delay(20);
      }
      assertEquals(SessionManager.getSession(1), undefined);

      // Every stream is told how it ended, including that scores are missing.
      assertEquals(await dj.next("session_end"), {
        reason: "completed",
        incomplete: 2,
      });
      const rows =
        await db`SELECT DISTINCT judge_id FROM scores WHERE competition_id = 10`;
      assertEquals(rows.map((r: any) => r.judge_id), [2]);
    } finally {
      await Promise.all(open.map((s) => s.close()));
      await delay(50);
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Operator: abort mid-performance tells every page, frees the session, and it can be started again",
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
      assertEquals((await admin("POST", "/sessions/1/start")).status, 200);
      await dj.next("performance_start"); // stuck: the DJ never answers

      const abort = await admin("POST", "/admin/sessions/1/abort");
      assertEquals(abort.status, 200);
      await abort.body?.cancel();
      for (const s of [dj, j2, j3, sb]) {
        assertEquals(await s.next("session_end"), {
          reason: "aborted",
          incomplete: 0,
        });
      }
      for (let i = 0; i < 100 && SessionManager.getSession(1); i++) {
        await delay(20);
      }
      assertEquals(SessionManager.getSession(1), undefined);
      // the DJ's late answer goes nowhere
      assertEquals(
        await respond(dj, { tag: perfTag(10, 0), payload: true }),
        404,
      );

      // Same session, same clients: starts cleanly and runs from the top.
      const again = await admin("POST", "/sessions/1/start");
      assertEquals(again.status, 200);
      await again.body?.cancel();
      for (const s of [dj, j2, j3, sb]) {
        assertEquals((await s.next("competition_start")).competition.id, 10);
      }
      assertEquals((await dj.next("performance_start")).position, 0);
      await admin("POST", "/admin/sessions/1/abort").then((r) =>
        r.body?.cancel()
      );
      for (let i = 0; i < 100 && SessionManager.getSession(1); i++) {
        await delay(20);
      }
    } finally {
      await Promise.all(open.map((s) => s.close()));
      await delay(50);
      SessionManager.deleteSession(1);
      clearAllResolvers();
      await unseed(db);
    }
  },
});

Deno.test({
  name: "Issuing a credential checks that the judge or track exists",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    try {
      const issue = async (client_id: string) => {
        const res = await app.fetch(
          new Request("http://localhost/admin/credentials", {
            method: "POST",
            headers: { ...adminHeaders, "content-type": "application/json" },
            body: JSON.stringify({ client_id }),
          }),
        );
        await res.body?.cancel();
        return res.status;
      };
      assertEquals(await issue("judge2"), 201);
      assertEquals(await issue("dj1"), 201);
      assertEquals(await issue("sb1"), 201);
      assertEquals(await issue("judge999"), 404);
      assertEquals(await issue("dj999"), 404);
    } finally {
      await unseed(db);
    }
  },
});

Deno.test({
  name: "Schema: rubric_judge_criteria rows must reference real rubric links",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    try {
      let rejected = false;
      try {
        // Judge 99 is not attached to rubric 1.
        await db`INSERT INTO rubric_judge_criteria (rubric_id, judge_id, criteria_id)
          VALUES (1, 99, 1)`;
      } catch {
        rejected = true;
      }
      assert(rejected, "insert with an unlinked judge should be refused");
    } finally {
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Audio: upload, DJ-only playback with ranges, and cut-off at session start",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    const dir = await Deno.makeTempDir();
    Deno.env.set("AUDIO_DIR", dir);
    await seed(db);
    // Session starts in 2h: uploads are open (cut-off is 30 min before).
    await db`UPDATE sessions SET start_time = NOW() + interval '2 hours' WHERE id = 1`;
    const streams: SSEStream[] = [];
    try {
      const bytes = new Uint8Array(1000).map((_, i) => i % 251);
      bytes.set([0x49, 0x44, 0x33]); // "ID3"
      const put = async (
        path: string,
        body: Uint8Array<ArrayBuffer>,
        query = "",
      ) => {
        const res = await app.fetch(
          new Request(`http://localhost/admin/audio/${path}${query}`, {
            method: "PUT",
            headers: adminHeaders,
            body,
          }),
        );
        const json = await res.json();
        return { status: res.status, json };
      };
      const get = async (who: string, headers: HeadersInit = {}) => {
        const res = await app.fetch(
          new Request("http://localhost/audio/10/100/music", {
            headers: { cookie: await cookieFor(who), ...headers },
          }),
        );
        return { res, body: new Uint8Array(await res.arrayBuffer()) };
      };
      const manifest = async (who: string) => {
        const res = await app.fetch(
          new Request("http://localhost/audio-manifest", {
            headers: { cookie: await cookieFor(who) },
          }),
        );
        return { status: res.status, json: await res.json() };
      };

      assertEquals((await put("10/100/music", bytes)).status, 201);
      assertEquals((await put("10/100/bogus", bytes)).status, 400);
      assertEquals(
        (await put("10/100/music", new TextEncoder().encode("nope"))).status,
        400,
      );
      // Competitor 999 is not in competition 10.
      assertEquals((await put("10/999/music", bytes)).status, 404);

      // The track's DJ gets the file, whole and by range.
      const full = await get("dj1");
      assertEquals(full.res.status, 200);
      assertEquals(full.res.headers.get("content-type"), "audio/mpeg");
      assertEquals(full.body, bytes);
      const part = await get("dj1", { range: "bytes=10-19" });
      assertEquals(part.res.status, 206);
      assertEquals(part.res.headers.get("content-range"), "bytes 10-19/1000");
      assertEquals(part.body, bytes.subarray(10, 20));
      const tail = await get("dj1", { range: "bytes=-5" });
      assertEquals(tail.body, bytes.subarray(995));
      assertEquals(
        (await get("dj1", { range: "bytes=5000-" })).res.status,
        416,
      );

      // Nobody else: another track's DJ, judges, scoreboards.
      assertEquals((await get("dj2")).res.status, 403);
      assertEquals((await get("judge2")).res.status, 403);
      assertEquals((await get("sb1")).res.status, 403);
      // Not uploaded: announce.
      const none = await app.fetch(
        new Request("http://localhost/audio/10/100/announce", {
          headers: { cookie: await cookieFor("dj1") },
        }),
      );
      assertEquals(none.status, 404);
      await none.body?.cancel();

      // Before the cut-off the DJ is offered nothing, but is told when.
      const early = await manifest("dj1");
      assertEquals(early.status, 425);
      assertEquals(early.json.available, false);
      assert(early.json.available_at, "says when the set becomes available");
      assertEquals(early.json.files, []);
      assertEquals((await manifest("judge2")).status, 403);

      // The cut-off passes (start in 10 min, cut-off is 30 min before start).
      await db`UPDATE sessions SET start_time = NOW() + interval '10 minutes' WHERE id = 1`;
      const m1 = await manifest("dj1");
      assertEquals(m1.status, 200);
      assertEquals(m1.json.available, true);
      assertEquals(m1.json.files.length, 1);
      assertEquals(m1.json.files[0].url, "/audio/10/100/music");
      assertEquals(m1.json.files[0].bytes, 1000);
      assert(/^[0-9a-f]{64}$/.test(m1.json.digest));

      // Uploads are now closed; the administrator can force a replacement.
      const closed = await put("10/100/music", bytes);
      assertEquals(closed.status, 409);
      assert(closed.json.closed_at);
      const bytes2 = bytes.map((b) => 255 - b) as Uint8Array<ArrayBuffer>;
      bytes2.set([0x49, 0x44, 0x33]);
      assertEquals((await put("10/100/music", bytes2, "?force=1")).status, 201);
      const m2 = await manifest("dj1");
      assert(m2.json.digest !== m1.json.digest, "digest follows the change");

      // The DJ is told (once per change) that the set is final.
      const source = {
        nextSession: getNextSessionForTrack,
        competitions: getSessionCompetitionsWithRubrics,
      };
      const mock = createMockClient("dj1");
      const deps = { audio, source, connectedClients: () => [mock] };
      await announceAudio(deps);
      await announceAudio(deps);
      const told = (mock as any).__messages.filter((m: string) =>
        m.startsWith("event: audio_available")
      );
      assertEquals(told.length, 1);
      assertEquals(
        JSON.parse(told[0].split("data: ")[1]).digest,
        m2.json.digest,
      );

      // Start the session: it reports the audio that never arrived...
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
      const started = await start.json();
      assertEquals(start.status, 200);
      assertEquals(started.missing_audio.length, 3); // 2 announce + 101 music

      // ...and holds the start until the DJ reports holding the current set.
      const ready = async (who: string, digest: string) => {
        const res = await app.fetch(
          new Request("http://localhost/audio-ready", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: await cookieFor(who),
            },
            body: JSON.stringify({ digest }),
          }),
        );
        await res.body?.cancel();
        return res.status;
      };
      await delay(150);
      assertEquals(
        SessionManager.getSession(1)!.status().waiting_for,
        ["audio:dj1"],
      );
      assertEquals(await ready("judge2", m2.json.digest), 403);
      assertEquals(await ready("dj1", "not-a-digest"), 400);
      assertEquals(await ready("dj1", m1.json.digest), 200); // the old set
      await delay(100);
      assertEquals(
        SessionManager.getSession(1)!.status().waiting_for,
        ["audio:dj1"],
      );
      assertEquals(await ready("dj1", m2.json.digest), 200);
      await dj.next("competition_start");

      // Uploads stay closed during the session, even with force.
      assertEquals((await put("10/100/music", bytes, "?force=1")).status, 409);

      const abort = await app.fetch(
        new Request("http://localhost/admin/sessions/1/abort", {
          method: "POST",
          headers: adminHeaders,
        }),
      );
      await abort.body?.cancel();
      await delay(100);
    } finally {
      await Promise.all(streams.map((s) => s.close()));
      await delay(50);
      await db`DELETE FROM audio_files`;
      await unseed(db);
      Deno.env.delete("AUDIO_DIR");
      await Deno.remove(dir, { recursive: true });
    }
  },
});

const DEMO_SEED = new URL(
  "../../../docker/postgres/demo/demo_seed.sql",
  import.meta.url,
).pathname;

Deno.test({
  name: "Demo: the seed loads twice, and the demo page, audio and reset work",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    const dir = await Deno.makeTempDir();
    Deno.env.set("AUDIO_DIR", dir);
    // psql runs the file in a transaction; the driver runs it as one statement.
    const seedSql = (await Deno.readTextFile(DEMO_SEED)).replace(
      /^(BEGIN|COMMIT);$/gm,
      "",
    );
    try {
      await db.unsafe(seedSql);
      await db.unsafe(seedSql); // idempotent
      const [{ n }] =
        await db`SELECT COUNT(*)::int AS n FROM competitors WHERE id >= 1000`;
      assertEquals(n, 5);

      const demo = new Hono();
      let running = false;
      registerDemoRoutes(demo, {
        adminToken: () => Deno.env.get("ADMIN_TOKEN"),
        safeEqual: (a, b) => Promise.resolve(a === b),
        credentials,
        audio,
        getSessionTrackId,
        getSessionCompetitions: getSessionCompetitionsWithRubrics,
        resetSession,
        isRunning: () => running,
        announceNow: () => Promise.resolve(),
      });
      const token = Deno.env.get("ADMIN_TOKEN")!;
      const bearer = { authorization: `Bearer ${token}` };

      // Wrong or missing token: nothing is handed out.
      assertEquals((await demo.request("http://lvh.me/demo")).status, 401);
      assertEquals(
        (await demo.request("http://lvh.me/demo?token=nope")).status,
        401,
      );
      // From another host, the page moves to the demo domain (frames need siblings).
      const moved = await demo.request(
        `http://localhost:8000/demo?token=${token}`,
        { redirect: "manual" },
      );
      assertEquals(moved.status, 302);
      assertEquals(
        moved.headers.get("location"),
        `http://lvh.me:8000/demo?token=${token}`,
      );

      const page = await demo.request(`http://lvh.me:8000/demo?token=${token}`);
      assertEquals(page.status, 200);
      const html = await page.text();
      const srcs = [...html.matchAll(/<iframe src="([^"]+)"/g)].map((m) =>
        m[1]
      );
      assertEquals(srcs.length, 4);
      const hosts = srcs.map((u) => new URL(u).host);
      assertEquals(hosts, [
        "scoreboard.lvh.me:8000",
        "dj.lvh.me:8000",
        "judge1.lvh.me:8000",
        "judge2.lvh.me:8000",
      ]);
      assert(html.includes("dj1000") && html.includes("sb1000"));
      assert(html.includes("judge1001") && html.includes("judge1002"));
      assert(html.includes("Judge Ada") && html.includes("Judge Ben"));

      // Each link signs in as exactly that device.
      const who = [];
      for (const src of srcs) {
        const secret = new URL(src).pathname.split("/").pop()!;
        who.push((await credentials.authenticate(secret))?.clientId);
      }
      assertEquals(who, ["sb1000", "dj1000", "judge1001", "judge1002"]);

      // Reloading revokes the previous links and issues new ones.
      const again = await (await demo.request(
        `http://lvh.me:8000/demo?token=${token}`,
      )).text();
      const oldSecret = new URL(srcs[1]).pathname.split("/").pop()!;
      assertEquals(await credentials.authenticate(oldSecret), undefined);
      assert(again.includes("/join/") && again !== html);

      // Audio: 5 competitors x (announce + music), all valid WAVs on disk.
      assertEquals(
        (await demo.request("/demo/audio/1000", { method: "POST" })).status,
        401,
      );
      const made = await demo.request("/demo/audio/1000", {
        method: "POST",
        headers: bearer,
      });
      assertEquals((await made.json()).files, 10);
      assertEquals(
        (await audio.missing(
          await getSessionCompetitionsWithRubrics(1000),
          ["announce", "music"],
        )).length,
        0,
      );

      // Reset clears scores and status; refused while running.
      await db`UPDATE sessions SET status = 'completed' WHERE id = 1000`;
      await db`INSERT INTO scores (competition_id, competitor_id, judge_id, criteria_id, score)
        VALUES (1000, 1001, 1001, 1000, 7.5)`;
      running = true;
      assertEquals(
        (await demo.request("/demo/reset/1000", {
          method: "POST",
          headers: bearer,
        }))
          .status,
        409,
      );
      running = false;
      assertEquals(
        (await demo.request("/demo/reset/1000", {
          method: "POST",
          headers: bearer,
        }))
          .status,
        200,
      );
      const [ses] = await db`SELECT status FROM sessions WHERE id = 1000`;
      assertEquals(ses.status, "upcoming");
      const [{ scores }] = await db`SELECT COUNT(*)::int AS scores FROM scores
        WHERE competition_id >= 1000`;
      assertEquals(scores, 0);

      // A session with no competitions says how to get demo data.
      const empty = await demo.request(
        `http://lvh.me:8000/demo?token=${token}&session=424242`,
      );
      assertEquals(empty.status, 404);
      assert((await empty.text()).includes("demo:seed"));
    } finally {
      await db.unsafe(`
        DELETE FROM client_credentials;
        DELETE FROM audio_files WHERE competition_id >= 1000;
        DELETE FROM scores WHERE competition_id >= 1000;
        DELETE FROM competition_competitors WHERE competition_id >= 1000;
        DELETE FROM competitions WHERE id >= 1000;
        DELETE FROM rubric_judge_criteria WHERE rubric_id = 1000;
        DELETE FROM rubric_judges WHERE rubric_id = 1000;
        DELETE FROM rubric_criteria WHERE rubric_id = 1000;
        DELETE FROM criteria WHERE id >= 1000;
        DELETE FROM judges WHERE id >= 1000;
        DELETE FROM users WHERE id >= 1000;
        DELETE FROM competitors WHERE id >= 1000;
        DELETE FROM sessions WHERE id = 1000;
        DELETE FROM tracks WHERE id = 1000;
        DELETE FROM rubrics WHERE id = 1000;
        DELETE FROM festivals WHERE id = 1000;
      `);
      Deno.env.delete("AUDIO_DIR");
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "Admin overview: the whole festival tree comes from the database, with live statuses",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    const seedSql = (await Deno.readTextFile(DEMO_SEED)).replace(
      /^(BEGIN|COMMIT);$/gm,
      "",
    );
    const dir = await Deno.makeTempDir();
    Deno.env.set("AUDIO_DIR", dir);
    try {
      await db.unsafe(seedSql);
      const cookie = await adminCookie();
      const overview = async () => {
        const res = await app.fetch(
          new Request("http://localhost/admin/overview", {
            headers: { cookie },
          }),
        );
        assertEquals(res.status, 200);
        return await res.json();
      };

      let o = await overview();
      const fest = o.festivals.find((f: any) => f.id === 1000);
      assertEquals(fest.name, "Demo Festival");
      const track = fest.tracks[0];
      assertEquals(track.devices.map((d: any) => d.client_id), [
        "dj1000",
        "sb1000",
      ]);
      const session = track.sessions[0];
      assertEquals([session.id, session.status, session.running], [
        1000,
        "upcoming",
        false,
      ]);
      assertEquals(
        session.competitions.map((
          c: any,
        ) => [c.name, c.status, c.competitors.length]),
        [["Solo Jive", "upcoming", 3], ["Showcase Waltz", "upcoming", 2]],
      );
      assertEquals(
        session.competitions[0].judges.map((j: any) => j.name),
        ["Judge Ada", "Judge Ben"],
      );
      assertEquals(
        session.competitions[0].competitors.map((c: any) => c.name),
        ["Alex Rivera", "Sam Okafor", "Jordan Lee"],
      );
      assertEquals(
        o.judges.filter((j: any) => j.id >= 1000).map((j: any) => j.email),
        [
          "ada@demo.example",
          "ben@demo.example",
        ],
      );

      // Progress shows up as colours: one competitor scored by both judges, the
      // competition under way.
      await db`UPDATE sessions SET status = 'active', current_competition = 1000,
        current_competitor = 1002 WHERE id = 1000`;
      await db`UPDATE competitions SET status = 'active' WHERE id = 1000`;
      await db`INSERT INTO scores (competition_id, competitor_id, judge_id, criteria_id, score)
        VALUES (1000, 1001, 1001, 1000, 8), (1000, 1001, 1002, 1000, 7)`;
      o = await overview();
      const jive = o.festivals.find((f: any) =>
        f.id === 1000
      ).tracks[0].sessions[0]
        .competitions[0];
      assertEquals(jive.status, "in_progress");
      assertEquals(
        jive.competitors.map((c: any) => [c.name, c.status, c.scored_by]),
        [["Alex Rivera", "finished", 2], ["Sam Okafor", "in_progress", 0], [
          "Jordan Lee",
          "upcoming",
          0,
        ]],
      );

      // Audio and issued links appear too.
      await audio.add(
        { competitionId: 1000, competitorId: 1002, kind: "music" },
        new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]),
      );
      const linksOf = (x: any) =>
        x.judges.find((j: any) => j.id === 1001).device.links.length;
      const before = linksOf(o);
      await credentials.issue("judge1001", "test");
      o = await overview();
      const sam = o.festivals.find((f: any) =>
        f.id === 1000
      ).tracks[0].sessions[0]
        .competitions[0].competitors[1];
      assertEquals(sam.audio, { announce: false, music: true });
      assertEquals(linksOf(o), before + 1);
    } finally {
      await db.unsafe(`
        DELETE FROM client_credentials;
        DELETE FROM audio_files WHERE competition_id >= 1000;
        DELETE FROM scores WHERE competition_id >= 1000;
        DELETE FROM competition_competitors WHERE competition_id >= 1000;
        DELETE FROM competitions WHERE id >= 1000;
        DELETE FROM rubric_judge_criteria WHERE rubric_id = 1000;
        DELETE FROM rubric_judges WHERE rubric_id = 1000;
        DELETE FROM rubric_criteria WHERE rubric_id = 1000;
        DELETE FROM criteria WHERE id >= 1000;
        DELETE FROM judges WHERE id >= 1000;
        DELETE FROM users WHERE id >= 1000;
        DELETE FROM competitors WHERE id >= 1000;
        DELETE FROM sessions WHERE id = 1000;
        DELETE FROM tracks WHERE id = 1000;
        DELETE FROM rubrics WHERE id = 1000;
        DELETE FROM festivals WHERE id = 1000;
      `);
      Deno.env.delete("AUDIO_DIR");
      await Deno.remove(dir, { recursive: true });
    }
  },
});

/** Sign in as the administrator the way the page does; returns the cookie. */
async function adminCookie(): Promise<string> {
  const res = await app.fetch(
    new Request("http://localhost/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: Deno.env.get("ADMIN_TOKEN") }),
    }),
  );
  await res.body?.cancel();
  assertEquals(res.status, 200);
  return res.headers.get("set-cookie")!.split(";")[0];
}

Deno.test({
  name:
    "Skip: the DJ skips the first competitor, the second still performs, and the database and admin overview show it",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const streams: SSEStream[] = [];
    try {
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
      await start.body?.cancel();

      // Competitor 100: the DJ presses skip.
      assertEquals((await dj.next("performance_start")).position, 0);
      assertEquals(
        await respond(dj, { tag: perfTag(10, 0), payload: false }),
        200,
      );

      // The session goes straight on to competitor 101 (it does not end).
      assertEquals((await dj.next("performance_start")).position, 1);
      assertEquals(
        j2.queued().includes("enable_scoring"),
        false,
        "no scoring for a skipped competitor",
      );
      assertEquals(
        await respond(dj, { tag: perfTag(10, 1), payload: true }),
        200,
      );
      for (const j of [j2, j3]) {
        assertEquals((await j.next("enable_scoring")).position, 1);
      }
      const scores = [{ criteria_id: 1, score: 7 }];
      assertEquals(
        await respond(j2, { tag: scoreTag(10, 101, 2), payload: scores }),
        200,
      );
      assertEquals(
        await respond(j3, { tag: scoreTag(10, 101, 3), payload: scores }),
        200,
      );
      assertEquals((await dj.next("session_end")).reason, "completed");
      await delay(100); // let the progress writes finish

      const rows =
        await db`SELECT competitor_id, status FROM competition_competitors
        WHERE competition_id = 10 ORDER BY order_number`;
      assertEquals(rows.map((r: any) => [r.competitor_id, r.status]), [
        [100, "skipped"],
        [101, "finalized"], // scoring closed: done for good
      ]);

      // The admin overview shows it, in its own state.
      const res = await app.fetch(
        new Request("http://localhost/admin/overview", {
          headers: { cookie: await adminCookie() },
        }),
      );
      const overview = await res.json();
      const competitors =
        overview.festivals[0].tracks[0].sessions[0].competitions[0]
          .competitors;
      assertEquals(competitors.map((c: any) => [c.id, c.status]), [
        [100, "skipped"],
        [101, "finished"],
      ]);

      // Starting the session again begins from scratch: the old outcome is cleared.
      await db`UPDATE sessions SET status = 'upcoming' WHERE id = 1`;
      await db`UPDATE competition_competitors SET status = 'skipped' WHERE competition_id = 10`;
      await recordProgress(1, { kind: "session_started" });
      const [{ n }] =
        await db`SELECT COUNT(*)::int AS n FROM competition_competitors
        WHERE competition_id = 10 AND status = 'upcoming'`;
      assertEquals(n, 2);

      // Resuming: 100 was skipped, 101 was performed and scoring was cut off
      // (the scores judges had saved are still in the database).
      await db`UPDATE sessions SET status = 'active' WHERE id = 1`;
      await db`UPDATE competition_competitors SET status = 'skipped'
        WHERE competition_id = 10 AND competitor_id = 100`;
      await db`UPDATE competition_competitors SET status = 'performed'
        WHERE competition_id = 10 AND competitor_id = 101`;
      const plan = planResume(
        await getSessionCompetitionsWithRubrics(1),
        await getResumeRows(1),
      );
      assertEquals([...plan.finished], ["10:100"]);
      assertEquals(plan.reopen?.competitorId, 101);
      assertEquals(
        plan.reopen?.scores.map((x) => [x.judge_id, x.scores]),
        [[2, [{ criteria_id: 1, score: 7 }]], [3, [{
          criteria_id: 1,
          score: 7,
        }]]],
      );
    } finally {
      await Promise.all(streams.map((s) => s.close()));
      await delay(50);
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Crash: at boot an active session resumes with the competitor that was being scored",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const streams: SSEStream[] = [];
    try {
      // The database as a crash left it: session active, 100 done, 101 performed
      // and judge 2 had scored before the server died.
      await db`UPDATE sessions SET status = 'active' WHERE id = 1`;
      await db`UPDATE competition_competitors SET status = 'finalized'
        WHERE competition_id = 10 AND competitor_id = 100`;
      await db`UPDATE competition_competitors SET status = 'performed'
        WHERE competition_id = 10 AND competitor_id = 101`;
      await db`INSERT INTO scores (competition_id, competitor_id, judge_id, criteria_id, score)
        VALUES (10, 101, 2, 1, 7)`;

      await resumeActiveSessions();
      const session = SessionManager.getSession(1);
      assert(session?.isRunning(), "the session is running again");

      const dj = await SSEStream.open("dj1");
      const j2 = await SSEStream.open("judge2");
      const j3 = await SSEStream.open("judge3");
      const sb = await SSEStream.open("sb1");
      streams.push(dj, j2, j3, sb);

      // No new performance; only judge 3 is asked, for the same competitor.
      assertEquals((await j3.next("enable_scoring")).position, 1);
      assertEquals(j2.queued().includes("enable_scoring"), false);
      assertEquals(dj.queued().includes("performance_start"), false);
      assertEquals(
        await respond(j3, {
          tag: scoreTag(10, 101, 3),
          payload: [{ criteria_id: 1, score: 8 }],
        }),
        200,
      );
      assertEquals((await dj.next("session_end")).reason, "completed");
      await delay(100);
      const rows =
        await db`SELECT competitor_id, status FROM competition_competitors
        WHERE competition_id = 10 ORDER BY order_number`;
      assertEquals(rows.map((r: any) => [r.competitor_id, r.status]), [
        [100, "finalized"],
        [101, "finalized"],
      ]);
    } finally {
      SessionManager.getSession(1)?.abort("test over");
      await Promise.all(streams.map((s) => s.close()));
      await delay(100);
      await unseed(db);
    }
  },
});
