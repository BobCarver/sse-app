// deno-lint-ignore-file no-explicit-any
// Backend integration: real Hono app + Postgres. Runs sessions in-process (no
// server) from a festival held in memory, as the bundle loader leaves it:
// track 1 (dj1, sb1), session 1 = competition 10 with competitors 100 and 101,
// judges 2 and 3 scoring criterion 1; session 2 follows on the same track.
// Requires DATABASE_URL pointing at a database with the schema loaded.
import { assert, assertEquals } from "@std/assert";
import type { FestivalData } from "../../../shared/festival-bundle/mod.ts";
import {
  getCloudSnapshot,
  getResumeRows,
  pairBundle,
  resetSession,
  saveScore,
  sql,
} from "../../src/db.ts";
import { Festival, festival, setFestival } from "../../src/festival.ts";
import { BundleError } from "../../src/bundle.ts";
import { Hono } from "@hono/hono";
import {
  app,
  audio,
  cloudCopy,
  credentials,
  loadFestival,
  sequencer,
} from "../../src/main.ts";
import { registerDemoRoutes } from "../../src/demo.ts";
import { CloudPusher } from "../../src/cloudPush.ts";
import { announceAudio } from "../../src/audioAnnouncer.ts";
import { judgeClaims, SessionManager } from "../../src/sessionManager.ts";
import { clearAllResolvers } from "../../src/resolveTag.ts";
import { beginTag, closeTag, perfTag, scoreTag } from "../../src/contract.ts";
import { createMockClient, delay } from "../test-utils.ts";
import { adminHeaders, cookieFor } from "../auth-utils.ts";
import {
  AudioSet,
  buildBundle,
  demoBundle,
  writeBundle,
} from "../../../scripts/fixtures.ts";

// Most tests here run sessions straight through; the DJ's start/end buttons
// (DJ_GATES) have their own test at the end.
Deno.env.set("DJ_GATES", "0");

// These tests need a database and are skipped without one. CI sets REQUIRE_DB=1
// so a missing/misconfigured database fails loudly instead of skipping silently.
Deno.test("integration: database is configured when required", () => {
  if (Deno.env.get("REQUIRE_DB") && !sql) {
    throw new Error("REQUIRE_DB is set but DATABASE_URL is not (no database)");
  }
});

/** The festival most tests run: see the top of this file. */
function seedFestival(
  startTime = "2026-01-01T09:00:00Z",
  audio: Record<string, unknown> = {},
): FestivalData {
  const entry = (id: number, name: string, order: number) => ({
    id,
    name,
    type: "individual" as const,
    order_number: order,
    duration: 60,
    audio: (audio[id] ?? {}) as Record<string, never>,
  });
  return {
    festival: {
      id: 1,
      name: "Test Fest",
      rubrics: [{
        id: 1,
        name: "Test Rubric",
        criteria: [{ id: 1, name: "Technique", weight: 1 }],
        judges: [
          { id: 2, name: "Judge A", criteria: [1] },
          { id: 3, name: "Judge B", criteria: [1] },
        ],
      }],
      tracks: [{
        id: 1,
        name: "Main",
        location: "Stage",
        sessions: [
          {
            id: 1,
            name: "Test Session",
            start_time: startTime,
            order_number: 1,
            competitions: [{
              id: 10,
              name: "E2E Competition",
              order_number: 1,
              rubric_id: 1,
              competitors: [entry(100, "Alice", 1), entry(101, "Bob", 2)],
            }],
          },
          {
            id: 2,
            name: "Second Session",
            start_time: "2030-01-01T14:00:00Z",
            order_number: 2,
            competitions: [{
              id: 20,
              name: "Later Competition",
              order_number: 1,
              rubric_id: 1,
              competitors: [entry(200, "Cleo", 1)],
            }],
          },
        ],
      }],
    },
  };
}

/** Empty the day's tables and make `data` the festival. */
async function seed(
  db: NonNullable<typeof sql>,
  data: FestivalData = seedFestival(),
) {
  await unseed(db);
  setFestival(new Festival(data, "test"));
}

async function unseed(db: NonNullable<typeof sql>) {
  // A failed test must not leave a session running into the next one.
  sequencer.enabled = false;
  const left = SessionManager.getAllSessions();
  for (const s of left) s.abort("test over");
  if (left.length > 0) await delay(100);
  for (const s of left) SessionManager.deleteSession(s.id);
  clearAllResolvers();
  judgeClaims.clear();
  await db`TRUNCATE scores, track_progress, session_runs, skips,
    missing_scores, festival_bundle, client_credentials`;
  setFestival(Festival.empty());
}

/** Poll until `read()` equals `want` (progress is written asynchronously). */
async function eventually<T>(read: () => Promise<T>, want: T, ms = 2000) {
  const end = Date.now() + ms;
  let got = await read();
  while (Date.now() < end) {
    try {
      assertEquals(got, want);
      return;
    } catch {
      await delay(20);
      got = await read();
    }
  }
  assertEquals(got, want);
}

/** Wait for the session to discard itself. */
async function gone(id = 1) {
  for (let i = 0; i < 100 && SessionManager.getSession(id); i++) {
    await delay(20);
  }
  assertEquals(SessionManager.getSession(id), undefined);
}

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

const admin = async (method: string, path: string): Promise<Response> =>
  await app.fetch(
    new Request(`http://localhost${path}`, { method, headers: adminHeaders }),
  );

/** The track's progress row and the session's markers, as stored. */
async function progressOf(db: NonNullable<typeof sql>, sessionId = 1) {
  const [track] = await db`SELECT open_session, competition_id, competitor_id,
      phase FROM track_progress WHERE track_id = 1`;
  const [run] = await db`SELECT started_at, finished_at FROM session_runs
    WHERE session_id = ${sessionId}`;
  return { track, run };
}

async function openAll(): Promise<SSEStream[]> {
  return [
    await SSEStream.open("dj1"),
    await SSEStream.open("judge2"),
    await SSEStream.open("judge3"),
    await SSEStream.open("sb1"),
  ];
}

Deno.test({
  name: "Full session flow: 1 DJ, 2 judges, 1 scoreboard, 2 competitors",
  ignore: !sql, // needs DATABASE_URL
  fn: async () => {
    const db = sql!;
    await seed(db);
    const streams: SSEStream[] = [];
    // The cloud copy sends the scores when the competition ends, with no timer.
    const pushed: any[] = [];
    cloudCopy.pusher = new CloudPusher({
      url: "https://portal.test/scores",
      token: "t",
      intervalMs: 3_600_000,
      festivalId: () => festival().id,
      bundleDigest: () => festival().digest,
      snapshot: getCloudSnapshot,
      fetch: ((_u: string | URL | Request, init?: RequestInit) => {
        pushed.push(JSON.parse(init!.body as string));
        return Promise.resolve(new Response(null, { status: 204 }));
      }) as typeof fetch,
    });
    try {
      // Track 1 => DJ "dj1" and scoreboard "sb1"; judges by judge id.
      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);

      const start = await admin("POST", "/sessions/1/start");
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
        // The cursor follows: this competitor, performing.
        await eventually(async () => (await progressOf(db)).track, {
          open_session: 1,
          competition_id: 10,
          competitor_id: competitorId,
          phase: "performing",
        });
        assertEquals(
          await respond(dj, { tag: perfTag(10, pos), payload: true }),
          200,
        );

        for (const j of [j2, j3]) {
          const en = await j.next("enable_scoring");
          assertEquals([en.competition_id, en.position], [10, pos]);
        }
        await eventually(
          async () => (await progressOf(db)).track.phase,
          "scoring",
        );

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
      await gone();

      // One push, when the competition ended: all four scores. The session end
      // that followed found nothing new.
      await eventually(() => Promise.resolve(pushed.length), 1);
      assertEquals(pushed[0].scores.length, 4);
      assertEquals(pushed[0].final, false);
      await delay(100);
      assertEquals(pushed.length, 1);

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

      // Track and judges are free again in memory...
      assert(SessionManager.findConflict(2, 1) === undefined);
      assertEquals(judgeClaims.holder("judge2"), undefined);
      // ...and in the database: the track is given back, the session is
      // marked finished with its actual start and end, nothing was skipped.
      const { track, run } = await progressOf(db);
      assertEquals(track, {
        open_session: null,
        competition_id: null,
        competitor_id: null,
        phase: null,
      });
      assert(run.started_at && run.finished_at, "actual times recorded");
      const [{ skips }] = await db`SELECT COUNT(*)::int AS skips FROM skips`;
      assertEquals(skips, 0);

      // A finished session is not run again.
      const again = await admin("POST", "/sessions/1/start");
      assertEquals(again.status, 409);
      assert((await again.json()).error.includes("already finished"));
    } finally {
      cloudCopy.pusher = undefined;
      await Promise.all(streams.map((s) => s.close()));
      await delay(50); // let SSE cleanup clear its ping timers
      await unseed(db);
    }
  },
});

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
      const start = await admin("POST", "/sessions/1/start");
      assertEquals(start.status, 200);
      await start.body?.cancel();
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
      await gone();
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
      const start = await admin("POST", "/sessions/1/start");
      assertEquals(start.status, 200);
      await start.body?.cancel();
      await second.next("competition_start");
      assertEquals(first.queued().includes("competition_start"), false);
    } finally {
      SessionManager.getSession(1)?.abort("test over");
      await Promise.all(open.map((s) => s.close()));
      await delay(100);
      SessionManager.deleteSession(1);
      clearAllResolvers();
      await delay(50);
      await unseed(db);
    }
  },
});

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
      await gone();

      // Every stream is told how it ended, including that scores are missing.
      assertEquals(await dj.next("session_end"), {
        reason: "completed",
        incomplete: 2,
      });
      const rows =
        await db`SELECT DISTINCT judge_id FROM scores WHERE competition_id = 10`;
      assertEquals(rows.map((r: any) => r.judge_id), [2]);
      // The misses are kept for the audit trail.
      const missing = await db`SELECT session_id, competition_id,
          competitor_id, judge_id, reason
        FROM missing_scores ORDER BY competitor_id`;
      assertEquals(missing.map((r: any) => Object.values(r)), [
        [1, 10, 100, 3, "absent"],
        [1, 10, 101, 3, "absent"],
      ]);
    } finally {
      await Promise.all(open.map((s) => s.close()));
      await delay(50);
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Shutdown mid-performance: every page is told; the session keeps its track and resumes at the cursor",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const open: SSEStream[] = [];
    try {
      const [dj, j2, j3, sb] = await openAll();
      open.push(dj, j2, j3, sb);
      assertEquals((await admin("POST", "/sessions/1/start")).status, 200);
      await dj.next("performance_start"); // stuck: the DJ never answers

      // There is no operator abort; a server shutdown stops it like this.
      const gone404 = await admin("POST", "/admin/sessions/1/abort");
      assertEquals(gone404.status, 404);
      await gone404.body?.cancel();
      SessionManager.getSession(1)!.abort("server shutting down");
      for (const s of [dj, j2, j3, sb]) {
        assertEquals(await s.next("session_end"), {
          reason: "aborted",
          incomplete: 0,
        });
      }
      await gone();
      // the DJ's late answer goes nowhere
      assertEquals(
        await respond(dj, { tag: perfTag(10, 0), payload: true }),
        404,
      );
      // The performance had begun: the session still holds the track, with
      // its cursor where it stopped.
      await delay(50);
      assertEquals((await progressOf(db)).track, {
        open_session: 1,
        competition_id: 10,
        competitor_id: 100,
        phase: "performing",
      });

      // Another session on the track must wait, even after a restart (the
      // lock is in the database, not in this process's memory).
      const other = await admin("POST", "/sessions/2/start");
      assertEquals(other.status, 409);
      assert(
        (await other.json()).error.includes("Track 1 has session 1 open"),
      );

      // Same session, same clients: runs again from the competitor in play.
      const again = await admin("POST", "/sessions/1/start");
      assertEquals(again.status, 200);
      await again.body?.cancel();
      for (const s of [dj, j2, j3, sb]) {
        assertEquals((await s.next("competition_start")).competition.id, 10);
      }
      assertEquals((await dj.next("performance_start")).position, 0);
      SessionManager.getSession(1)?.abort("test over");
      await gone();
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
  name:
    "Track lock: a session stopped before anything ran gives its track back",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const open: SSEStream[] = [];
    try {
      // Nobody is connected: session 1 waits for its DJ and scoreboard.
      assertEquals((await admin("POST", "/sessions/1/start")).status, 200);
      await delay(50);
      assertEquals((await progressOf(db)).track.open_session, 1);
      // Session 2 cannot open while 1 holds the track...
      const blocked = await admin("POST", "/sessions/2/start");
      assertEquals(blocked.status, 409);
      await blocked.body?.cancel();

      // ...until 1 is stopped having done nothing.
      SessionManager.getSession(1)?.abort("test over");
      await gone();
      await delay(50);
      assertEquals((await progressOf(db)).track.open_session, null);
      const next = await admin("POST", "/sessions/2/start");
      assertEquals(next.status, 200);
      await next.body?.cancel();
      await delay(50);
      assertEquals((await progressOf(db, 2)).track.open_session, 2);
      SessionManager.getSession(2)?.abort("test over");
      await gone(2);
    } finally {
      await Promise.all(open.map((s) => s.close()));
      clearAllResolvers();
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Zero scores: nobody scored, so the session waits for the operator; re-open, then skip",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    Deno.env.set("JUDGE_SCORE_TIMEOUT_MS", "100");
    const open: SSEStream[] = [];
    try {
      const [dj, j2, j3, sb] = await openAll();
      open.push(dj, j2, j3, sb);
      assertEquals((await admin("POST", "/sessions/1/start")).status, 200);
      await dj.next("performance_start");
      assertEquals(
        await respond(dj, { tag: perfTag(10, 0), payload: true }),
        200,
      );
      for (const j of [j2, j3]) {
        await j.next("enable_scoring");
        await j.next("scoring_closed"); // nobody scores in time
      }

      // Nothing to re-open until the session is waiting for that.
      await delay(50);
      const list = await (await admin("GET", "/admin/sessions")).json();
      assertEquals(list[0].phase, "unscored");
      assertEquals(list[0].waiting_for, [
        "operator: no scores (skip or reopen)",
      ]);
      assertEquals(dj.queued().includes("performance_start"), false);

      // Re-open: the judges are asked again (and again nobody scores).
      const reopen = await admin("POST", "/admin/sessions/1/reopen");
      assertEquals(reopen.status, 200);
      await reopen.body?.cancel();
      assertEquals((await j3.next("enable_scoring")).position, 0);
      await j3.next("scoring_closed");
      await delay(50);

      // Skip it: recorded as an operator skip at the scoring stage.
      assertEquals(
        (await (await admin("POST", "/admin/sessions/1/skip")).json()).skipped,
        "unscored",
      );
      assertEquals((await dj.next("performance_start")).position, 1);
      await eventually(
        async () =>
          (await db`SELECT competitor_id, stage, actor, reason
            FROM skips WHERE session_id = 1`).map((r: any) => Object.values(r)),
        [[100, "scoring", "operator", "no scores"]],
      );
      const [{ misses }] = await db`SELECT COUNT(*)::int AS misses
        FROM missing_scores WHERE competitor_id = 100 AND reason = 'timeout'`;
      assertEquals(misses, 4); // both judges, both rounds
      const nothing = await admin("POST", "/admin/sessions/1/reopen");
      assertEquals(nothing.status, 409);
      await nothing.body?.cancel();
      SessionManager.getSession(1)?.abort("test over");
      await gone();
    } finally {
      Deno.env.delete("JUDGE_SCORE_TIMEOUT_MS");
      await Promise.all(open.map((s) => s.close()));
      await delay(50);
      clearAllResolvers();
      await unseed(db);
    }
  },
});

Deno.test({
  name: "Issuing a credential checks that the judge or track is in the bundle",
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
  name:
    "Pairing guard: the database keeps its bundle once anything has run, and refuses another",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await unseed(db);
    const dir = await Deno.makeTempDir();
    try {
      const a = { festivalId: 1, digest: "a".repeat(64), dataText: "{}\n" };
      const b = { festivalId: 1, digest: "b".repeat(64), dataText: "{ }\n" };
      assertEquals(await pairBundle(a), undefined); // first use: recorded
      assertEquals(await pairBundle(a), undefined); // same bundle again
      assertEquals(await pairBundle(b), undefined); // nothing ran: replaced
      const [row] = await db`SELECT digest, data_json FROM festival_bundle`;
      assertEquals([row.digest, row.data_json], [b.digest, b.dataText]);

      await saveScore({
        competition_id: 10,
        competitor_id: 100,
        judge_id: 2,
        scores: [{ criteria_id: 1, score: 7 }],
      });
      const refused = await pairBundle(a);
      assert(refused?.includes("the festival has started"), refused);
      assertEquals(await pairBundle(b), undefined); // its own bundle still loads

      // Through the loader: a real bundle on disk, then a different one.
      await db`TRUNCATE festival_bundle, scores`;
      const files = await demoBundle();
      await writeBundle(dir, files);
      const f = await loadFestival(dir, `${dir}/audio`);
      assertEquals([f.id, festival().id], [1000, 1000]);
      const [stored] = await db`SELECT digest, data_json FROM festival_bundle`;
      assertEquals(stored.data_json, files.dataText); // the exact text
      await db`INSERT INTO session_runs (session_id, track_id, started_at)
        VALUES (1000, 1000, NOW())`;
      const other = await buildBundle(seedFestival(), new AudioSet());
      await writeBundle(dir, other);
      const err = await loadFestival(dir, `${dir}/audio`).catch((e) => e);
      assert(err instanceof BundleError, String(err));
      assert(err.message.includes("refusing bundle"), err.message);
      assertEquals(festival().id, 1000); // the festival did not change
    } finally {
      await Deno.remove(dir, { recursive: true });
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Audio: from the bundle, DJ-only playback with ranges, track manifest, start gate",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    const dir = await Deno.makeTempDir();
    Deno.env.set("AUDIO_DIR", dir);
    const bytes = new Uint8Array(1000).map((_, i) => i % 251);
    bytes.set([0x49, 0x44, 0x33]); // "ID3"
    const files = new AudioSet();
    const music = { music: await files.add(bytes, "audio/mpeg") };
    for (const [name, data] of files.files) {
      await Deno.writeFile(`${dir}/${name}`, data);
    }
    const inMinutes = (m: number) =>
      new Date(Date.now() + m * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
    // Session 1 starts in 10 min; the set is offered regardless of the time.
    await seed(db, seedFestival(inMinutes(10), { 100: music }));
    const streams: SSEStream[] = [];
    try {
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

      // There is no upload route on the competition server: the bundle is final.
      const put = await app.fetch(
        new Request("http://localhost/admin/audio/10/100/music", {
          method: "PUT",
          headers: adminHeaders,
          body: bytes,
        }),
      );
      assertEquals(put.status, 404);
      await put.body?.cancel();

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
      // Not in the bundle: announce.
      const none = await app.fetch(
        new Request("http://localhost/audio/10/100/announce", {
          headers: { cookie: await cookieFor("dj1") },
        }),
      );
      assertEquals(none.status, 404);
      await none.body?.cancel();

      // The track's DJ is offered the set from the start (there is no cut-off:
      // the bundle is final), nobody else.
      assertEquals((await manifest("judge2")).status, 403);
      const m1 = await manifest("dj1");
      assertEquals(m1.status, 200);
      assertEquals(m1.json.track_id, 1);
      assertEquals(m1.json.files.length, 1);
      assertEquals(m1.json.files[0].url, "/audio/10/100/music");
      assertEquals(m1.json.files[0].bytes, 1000);
      assert(/^[0-9a-f]{64}$/.test(m1.json.digest));

      // The DJ is told (once) that the set is there.
      const source = {
        competitions: (trackId: number) =>
          festival().trackCompetitions(trackId),
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
        m1.json.digest,
      );

      // Start the session: it reports the audio the bundle does not have...
      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      const start = await admin("POST", "/sessions/1/start");
      const started = await start.json();
      assertEquals(start.status, 200);
      assertEquals(started.missing_audio.length, 3); // 2 announce + 101 music

      // ...and holds the start until the DJ reports holding the set.
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
      assertEquals(await ready("judge2", m1.json.digest), 403);
      assertEquals(await ready("dj1", "not-a-digest"), 400);
      assertEquals(await ready("dj1", "f".repeat(64)), 200); // another set
      await delay(100);
      assertEquals(
        SessionManager.getSession(1)!.status().waiting_for,
        ["audio:dj1"],
      );
      assertEquals(await ready("dj1", m1.json.digest), 200);
      // The audio is in place; now the planned start (10 min ahead) holds it.
      await delay(100);
      assert(
        SessionManager.getSession(1)!.status().waiting_for[0].startsWith(
          "planned start ",
        ),
      );

      SessionManager.getSession(1)?.abort("test over");
      await delay(100);
    } finally {
      await Promise.all(streams.map((s) => s.close()));
      await delay(50);
      await unseed(db);
      Deno.env.delete("AUDIO_DIR");
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "Demo: the demo bundle, the demo page and reset work",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db, JSON.parse((await demoBundle()).dataText));
    try {
      const demo = new Hono();
      let running = false;
      registerDemoRoutes(demo, {
        adminToken: () => Deno.env.get("ADMIN_TOKEN"),
        safeEqual: (a, b) => Promise.resolve(a === b),
        credentials,
        getSessionTrackId: (id) =>
          Promise.resolve(festival().sessionTrackId(id)),
        getSessionCompetitions: (id) =>
          Promise.resolve(festival().sessionCompetitions(id)),
        resetSession: (id) =>
          resetSession(
            id,
            festival().sessionCompetitions(id).map((c) => c.id),
          ),
        isRunning: () => running,
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

      // Every announcement and song is in the bundle.
      assertEquals(
        (await audio.missing(festival().sessionCompetitions(1000), [
          "announce",
          "music",
        ])).length,
        0,
      );

      // Reset clears the day's records for the session; refused while running.
      await db`INSERT INTO session_runs (session_id, track_id, finished_at)
        VALUES (1000, 1000, NOW())`;
      await db`INSERT INTO track_progress (track_id, open_session) VALUES (1000, 1000)`;
      await db`INSERT INTO skips (session_id, competition_id, competitor_id, stage, actor)
        VALUES (1000, 1000, 1002, 'performance', 'dj')`;
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
      const [{ n }] = await db`SELECT
          (SELECT COUNT(*) FROM scores WHERE competition_id >= 1000)
        + (SELECT COUNT(*) FROM session_runs WHERE session_id = 1000)
        + (SELECT COUNT(*) FROM skips WHERE session_id = 1000)
        + (SELECT COUNT(*) FROM track_progress WHERE open_session = 1000)
        AS n`;
      assertEquals(Number(n), 0);

      // A session with no competitions says how to get demo data.
      const empty = await demo.request(
        `http://lvh.me:8000/demo?token=${token}&session=424242`,
      );
      assertEquals(empty.status, 404);
      assert((await empty.text()).includes("demo:bundle"));
    } finally {
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Admin overview: the festival tree comes from the bundle, statuses from the cursor",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db, JSON.parse((await demoBundle()).dataText));
    try {
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
      const fest = o.festivals[0];
      assertEquals([fest.id, fest.name], [1000, "Demo Festival"]);
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
      // Every entry has its audio in the bundle; judges carry no email.
      assertEquals(session.competitions[0].competitors[1].audio, {
        announce: true,
        music: true,
      });
      assertEquals(o.judges.map((j: any) => [j.id, j.email]), [
        [1001, null],
        [1002, null],
      ]);

      // Progress shows up as colours: the cursor on Sam, performing; Alex
      // scored by both judges.
      await db`INSERT INTO track_progress
          (track_id, open_session, competition_id, competitor_id, phase)
        VALUES (1000, 1000, 1000, 1002, 'performing')`;
      await db`INSERT INTO session_runs (session_id, track_id) VALUES (1000, 1000)`;
      await db`INSERT INTO scores (competition_id, competitor_id, judge_id, criteria_id, score)
        VALUES (1000, 1001, 1001, 1000, 8), (1000, 1001, 1002, 1000, 7)`;
      o = await overview();
      const s = o.festivals[0].tracks[0].sessions[0];
      assertEquals(s.status, "in_progress");
      const jive = s.competitions[0];
      assertEquals(jive.status, "in_progress");
      assertEquals(
        jive.competitors.map((c: any) => [c.name, c.status, c.scored_by]),
        [["Alex Rivera", "finished", 2], ["Sam Okafor", "in_progress", 0], [
          "Jordan Lee",
          "upcoming",
          0,
        ]],
      );
      assertEquals(s.competitions[1].status, "upcoming");

      // Issued links appear too.
      const linksOf = (x: any) =>
        x.judges.find((j: any) => j.id === 1001).device.links.length;
      const before = linksOf(o);
      await credentials.issue("judge1001", "test");
      o = await overview();
      assertEquals(linksOf(o), before + 1);
    } finally {
      await unseed(db);
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
      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      const start = await admin("POST", "/sessions/1/start");
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

      // The skip is recorded (by whom, at which stage); the rest is derived.
      const skips = await db`SELECT session_id, competition_id, competitor_id,
          stage, actor, reason FROM skips`;
      assertEquals(skips.map((r: any) => Object.values(r)), [
        [1, 10, 100, "performance", "dj", ""],
      ]);

      // The admin overview shows it, in its own state.
      const res = await app.fetch(
        new Request("http://localhost/admin/overview", {
          headers: { cookie: await adminCookie() },
        }),
      );
      const overview = await res.json();
      const sessions = overview.festivals[0].tracks[0].sessions;
      assertEquals(sessions.map((s: any) => [s.id, s.status]), [
        [1, "finished"],
        [2, "upcoming"],
      ]);
      assertEquals(
        sessions[0].competitions[0].competitors.map((
          c: any,
        ) => [c.id, c.status]),
        [[100, "skipped"], [101, "finished"]],
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
    "Crash mid-scoring: at boot the open session resumes with the competitor that was being scored",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const streams: SSEStream[] = [];
    try {
      // The database as a crash left it: session 1 holds the track, 100 is
      // done, 101 was performed and judge 2 had scored it.
      await db`INSERT INTO session_runs (session_id, track_id, started_at)
        VALUES (1, 1, NOW())`;
      await db`INSERT INTO track_progress
          (track_id, open_session, competition_id, competitor_id, phase)
        VALUES (1, 1, 10, 101, 'scoring')`;
      await db`INSERT INTO scores (competition_id, competitor_id, judge_id, criteria_id, score)
        VALUES (10, 100, 2, 1, 6), (10, 100, 3, 1, 6), (10, 101, 2, 1, 7)`;
      const rows = await getResumeRows(1);
      assertEquals(rows?.cursorScores.map((r) => [r.judge_id, r.score]), [
        [2, 7],
      ]);

      sequencer.enabled = true; // as at boot
      await sequencer.armAll();
      const session = SessionManager.getSession(1);
      assert(session?.isRunning(), "the session is running again");

      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);

      // No new performance; only judge 3 is asked, for the same competitor.
      assertEquals((await j3.next("enable_scoring")).position, 1);
      assertEquals(j2.queued().includes("enable_scoring"), false);
      assertEquals(dj.queued().includes("performance_start"), false);
      // The scoreboard is shown the score saved before the crash.
      assertEquals((await sb.next("score_update")).judge_id, 2);
      assertEquals(
        await respond(j3, {
          tag: scoreTag(10, 101, 3),
          payload: [{ criteria_id: 1, score: 8 }],
        }),
        200,
      );
      assertEquals((await dj.next("session_end")).reason, "completed");
      await delay(100);
      const { run } = await progressOf(db);
      assert(run.finished_at, "finished");
      // The track moved on: the sequencer armed session 2.
      await eventually(
        async () => (await progressOf(db, 2)).track.open_session,
        2,
      );
    } finally {
      SessionManager.getSession(1)?.abort("test over");
      await Promise.all(streams.map((s) => s.close()));
      await delay(100);
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Crash mid-performance: at boot the competitor in play runs again from its performance",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    Deno.env.set("DJ_GATES", "1");
    const streams: SSEStream[] = [];
    try {
      await db`INSERT INTO session_runs (session_id, track_id, started_at)
        VALUES (1, 1, NOW())`;
      await db`INSERT INTO track_progress
          (track_id, open_session, competition_id, competitor_id, phase)
        VALUES (1, 1, 10, 101, 'performing')`;
      sequencer.enabled = true; // as at boot
      await sequencer.armAll();

      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      // The competition was under way: no "start competition" button again.
      assertEquals((await dj.next("performance_start")).position, 1);
      assertEquals(dj.queued().includes("competition_ready"), false);
    } finally {
      Deno.env.set("DJ_GATES", "0");
      SessionManager.getSession(1)?.abort("test over");
      await Promise.all(streams.map((s) => s.close()));
      await delay(100);
      await unseed(db);
    }
  },
});

Deno.test({
  name: "DJ gates: the DJ starts the competition and ends the session",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    Deno.env.set("DJ_GATES", "1");
    const streams: SSEStream[] = [];
    try {
      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      const start = await admin("POST", "/sessions/1/start");
      assertEquals(start.status, 200);
      await start.body?.cancel();

      // Everyone is told what is about to begin; nothing has started.
      const ready = await sb.next("competition_ready");
      assertEquals(ready.competition_id, 10);
      assertEquals((await dj.next("competition_ready")).name, ready.name);
      assertEquals(sb.queued().includes("competition_start"), false);

      // Only the session's DJ may start it.
      assertEquals(
        await respond(j2, { tag: beginTag(10), payload: true }),
        403,
      );
      assertEquals(
        await respond(dj, { tag: beginTag(10), payload: true }),
        200,
      );
      assertEquals((await dj.next("performance_start")).position, 0);

      // Skip both competitors: nothing left to score.
      assertEquals(
        await respond(dj, { tag: perfTag(10, 0), payload: false }),
        200,
      );
      assertEquals((await dj.next("performance_start")).position, 1);
      assertEquals(
        await respond(dj, { tag: perfTag(10, 1), payload: false }),
        200,
      );

      // Finished, but the session stays open for the DJ; judges are still held.
      // The scoreboard is told what comes next on the track.
      const finished = await sb.next("session_finished");
      assertEquals(finished.session_id, 1);
      assertEquals(finished.next_session_name, "Second Session");
      assertEquals(finished.next_session_start, "2030-01-01T14:00:00.000Z");
      assertEquals(j2.queued().includes("session_end"), false);
      assert(SessionManager.getSession(1)?.isRunning());
      // Every competitor is done: the cursor is empty, the track still held.
      await delay(50);
      assertEquals((await progressOf(db)).track, {
        open_session: 1,
        competition_id: null,
        competitor_id: null,
        phase: null,
      });
      // Judges are given back when their competition ends (per-competition
      // claims), but are told the session ended only when it does.
      assertEquals(judgeClaims.holder("judge2"), undefined);
      assertEquals(
        await respond(j2, { tag: closeTag(1), payload: true }),
        403,
      );

      assertEquals(
        await respond(dj, { tag: closeTag(1), payload: true }),
        200,
      );
      assertEquals((await dj.next("session_end")).reason, "completed");
      assertEquals((await j2.next("session_end")).reason, "completed");
      await delay(100);
      assertEquals(SessionManager.findConflict(2, 1), undefined);
    } finally {
      Deno.env.set("DJ_GATES", "0");
      SessionManager.getSession(1)?.abort("test over");
      await Promise.all(streams.map((s) => s.close()));
      await delay(100);
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Sequencer: arms the first session, and after End session the next one on the track",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const streams: SSEStream[] = [];
    try {
      sequencer.enabled = true;
      await sequencer.armAll(); // what the server does at boot
      assert(SessionManager.getSession(1)?.isRunning(), "session 1 armed");
      await eventually(
        async () => (await progressOf(db)).track.open_session,
        1,
      );

      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      for (const pos of [0, 1]) {
        assertEquals((await dj.next("performance_start")).position, pos);
        assertEquals(
          await respond(dj, { tag: perfTag(10, pos), payload: false }),
          200,
        );
      }
      assertEquals((await dj.next("session_end")).reason, "completed");

      // Session 2 is armed by itself; its planned start (2030) is ahead.
      await eventually(
        () =>
          Promise.resolve(SessionManager.getSession(2)?.isRunning() ?? false),
        true,
      );
      await eventually(
        () =>
          Promise.resolve(SessionManager.getSession(2)!.status().waiting_for),
        ["planned start 2030-01-01T14:00:00.000Z"],
      );
    } finally {
      await Promise.all(streams.map((s) => s.close()));
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Cancel: a running session is dropped for good and its track moves on; a later one can be cancelled ahead",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const streams: SSEStream[] = [];
    try {
      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      sequencer.enabled = true;
      await sequencer.armAll();
      await dj.next("performance_start");

      const res = await admin("POST", "/admin/sessions/1/cancel");
      assertEquals(res.status, 200);
      await res.body?.cancel();
      for (const s of [dj, j2, sb]) {
        assertEquals((await s.next("session_end")).reason, "cancelled");
      }
      await eventually(async () => {
        const [run] = await db`SELECT cancelled_at IS NOT NULL AS c
          FROM session_runs WHERE session_id = 1`;
        return run?.c;
      }, true);
      // The track moved on: session 2 is armed.
      await eventually(
        () =>
          Promise.resolve(SessionManager.getSession(2)?.isRunning() ?? false),
        true,
      );
      // A cancelled session is not run again.
      sequencer.enabled = false;
      const again = await admin("POST", "/sessions/1/start");
      assertEquals(again.status, 409);
      assert((await again.json()).error.includes("cancelled"));
      SessionManager.getSession(2)!.abort("test over");
      await gone(2);

      // Cancelling a session that is not running: marked, and the track
      // (held by session 2 since it was armed) is given back.
      const ahead = await admin("POST", "/admin/sessions/2/cancel");
      assertEquals(ahead.status, 200);
      await ahead.body?.cancel();
      assertEquals((await progressOf(db)).track.open_session, null);
      const twice = await admin("POST", "/admin/sessions/2/cancel");
      assertEquals(twice.status, 409);
      await twice.body?.cancel();

      // The overview shows both as cancelled (and finished).
      const o = await (await app.fetch(
        new Request("http://localhost/admin/overview", {
          headers: { cookie: await adminCookie() },
        }),
      )).json();
      assertEquals(
        o.festivals[0].tracks[0].sessions.map((
          s: any,
        ) => [s.id, s.status, s.cancelled]),
        [[1, "finished", true], [2, "finished", true]],
      );
    } finally {
      await Promise.all(streams.map((s) => s.close()));
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Hold: pauses the session, survives a restart, and release lets it carry on",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    const streams: SSEStream[] = [];
    try {
      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      assertEquals((await admin("POST", "/sessions/1/start")).status, 200);
      await dj.next("performance_start");

      assertEquals((await admin("POST", "/admin/sessions/1/hold")).status, 200);
      await eventually(async () => {
        const [run] = await db`SELECT held_at IS NOT NULL AS h
          FROM session_runs WHERE session_id = 1`;
        return run.h;
      }, true);
      // The song ends while held: scoring does not open.
      assertEquals(
        await respond(dj, { tag: perfTag(10, 0), payload: true }),
        200,
      );
      await delay(100);
      assertEquals(j2.queued().includes("enable_scoring"), false);

      // A restart (shutdown, then start again): it comes back held.
      SessionManager.getSession(1)!.abort("server shutting down");
      await gone();
      assertEquals((await admin("POST", "/sessions/1/start")).status, 200);
      await delay(100);
      const st = (await (await admin("GET", "/admin/sessions")).json())[0];
      assertEquals([st.held, st.waiting_for], [true, ["held by operator"]]);
      assertEquals(j3.queued().includes("enable_scoring"), false);

      // Released: scoring re-opens for the competitor that was performed.
      const rel = await admin("POST", "/admin/sessions/1/release");
      assertEquals(rel.status, 200);
      await rel.body?.cancel();
      assertEquals((await j3.next("enable_scoring")).position, 0);
      const [run] =
        await db`SELECT held_at FROM session_runs WHERE session_id = 1`;
      assertEquals(run.held_at, null);
    } finally {
      await Promise.all(streams.map((s) => s.close()));
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Planned start: the DJ cannot start a session before its planned time (425), and is told when",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    Deno.env.set("DJ_GATES", "1");
    const streams: SSEStream[] = [];
    try {
      // Session 2 is planned for 2030 (session 1 is cancelled to free the track).
      const c = await admin("POST", "/admin/sessions/1/cancel");
      await c.body?.cancel();
      const [dj, j2, j3, sb] = await openAll();
      streams.push(dj, j2, j3, sb);
      assertEquals((await admin("POST", "/sessions/2/start")).status, 200);
      const ready = await dj.next("competition_ready");
      assertEquals(ready.competition_id, 20);
      assertEquals(ready.starts_at, "2030-01-01T14:00:00.000Z");
      assertEquals(
        await respond(dj, { tag: beginTag(20), payload: true }),
        425,
      );
      assertEquals(sb.queued().includes("competition_start"), false);
    } finally {
      Deno.env.set("DJ_GATES", "0");
      await Promise.all(streams.map((s) => s.close()));
      await unseed(db);
    }
  },
});

Deno.test({
  name:
    "Cloud copy: the snapshot is read from the database and pushed; a new score changes it",
  ignore: !sql,
  fn: async () => {
    const db = sql!;
    await seed(db);
    try {
      assertEquals(await getCloudSnapshot(), { scores: [], skips: [] });
      await db`INSERT INTO scores (competition_id, competitor_id, judge_id, criteria_id, score)
        VALUES (10, 100, 2, 1, 7.5), (10, 100, 3, 1, 8)`;
      await db`INSERT INTO skips (session_id, competition_id, competitor_id, stage, actor, reason)
        VALUES (1, 10, 101, 'performance', 'dj', 'no show')`;
      const snap = await getCloudSnapshot();
      assertEquals(
        snap.scores.map((x) => [x.judge_id, x.score]).toSorted(),
        [[2, 7.5], [3, 8]], // numbers, not strings
      );
      assertEquals(snap.skips[0].reason, "no show");

      const bodies: any[] = [];
      const pusher = new CloudPusher({
        url: "https://portal.test/scores",
        token: "t",
        intervalMs: 1000,
        festivalId: () => festival().id,
        bundleDigest: () => festival().digest,
        snapshot: getCloudSnapshot,
        fetch: ((_u: string | URL | Request, init?: RequestInit) => {
          bodies.push(JSON.parse(init!.body as string));
          return Promise.resolve(new Response(null, { status: 204 }));
        }) as typeof fetch,
      });
      assert((await pusher.push()).sent);
      assertEquals((await pusher.push()).sent, false); // unchanged
      await saveScore({
        competition_id: 10,
        competitor_id: 101,
        judge_id: 2,
        scores: [{ criteria_id: 1, score: 6 }],
      });
      assert((await pusher.push()).sent);
      assertEquals(bodies.map((b) => b.scores.length), [2, 3]);
      assertEquals(bodies[1].bundle_digest, "test");
    } finally {
      await unseed(db);
    }
  },
});
