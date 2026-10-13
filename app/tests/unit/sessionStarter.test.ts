// Starting a session, with fakes for the festival, the registry and the
// database: every way a start is refused, the track lock, and the atomic claim.
import { assert, assertEquals } from "@std/assert";
import type { AudioRef } from "../../src/audioLibrary.ts";
import type { ResumeRows } from "../../src/resume.ts";
import type { Session, SessionDependencies } from "../../src/session.ts";
import {
  type SessionRegistry,
  SessionStarter,
  type StarterDeps,
} from "../../src/sessionStarter.ts";
import type { Competition } from "../../src/types.ts";

const comp = (id: number, ...competitors: number[]): Competition => ({
  id,
  name: `C${id}`,
  competitors: competitors.map((c) => ({ id: c, name: `P${c}`, duration: 60 })),
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

/** A session that runs until the test finishes it. */
class FakeSession {
  running = false;
  endReason: Session["endReason"] = null;
  ran?: { permanent: string[]; resumeFinished: number };
  finish!: (reason: Session["endReason"], fail?: boolean) => void;
  constructor(readonly id: number, readonly trackId: number) {}
  isRunning() {
    return this.running;
  }
  runSession(
    _c: Competition[],
    permanent: string[],
    resume: { finished: ReadonlySet<string> },
  ) {
    this.running = true;
    this.ran = { permanent, resumeFinished: resume.finished.size };
    return new Promise<void>((resolve, reject) => {
      this.finish = (reason, fail) => {
        this.running = false;
        this.endReason = reason;
        fail ? reject(new Error("boom")) : resolve();
      };
    });
  }
}

interface Setup {
  starter: SessionStarter;
  sessions: Map<number, FakeSession>;
  calls: string[];
  ended: [number, Session["endReason"]][];
  wired: { resumed: boolean; held: boolean }[];
  /** Tweak the fakes before a start. */
  rows: Map<number, ResumeRows | Error>;
  lockHeldBy: Map<number, number>;
  onLock: { run?: () => void | Promise<void>; fail?: boolean };
  missing: AudioRef[];
  failCreate: { on: boolean };
}

function setup(): Setup {
  const sessions = new Map<number, FakeSession>();
  const calls: string[] = [];
  const ended: Setup["ended"] = [];
  const wired: Setup["wired"] = [];
  const rows: Setup["rows"] = new Map();
  const lockHeldBy: Setup["lockHeldBy"] = new Map(); // track -> session
  const onLock: Setup["onLock"] = {};
  const failCreate = { on: false };
  const out = { missing: [] as AudioRef[] };
  // Sessions 1, 2, 4 and 5 are on track 1, session 3 on track 2; session 4
  // has nothing to run and session 9 is not in the festival.
  const festival = {
    sessionCompetitions: (id: number) =>
      id === 4 || id === 9 ? [] : [comp(10 + id, 100, 101)],
    sessionTrackId: (id: number) => id === 9 ? undefined : id === 3 ? 2 : 1,
  };
  const registry: SessionRegistry = {
    getSession: (id) => sessions.get(id) as unknown as Session | undefined,
    findConflict: (id, trackId) => {
      for (const s of sessions.values()) {
        if (s.id !== id && s.isRunning() && s.trackId === trackId) {
          return `Track ${trackId} already has running session ${s.id}`;
        }
      }
    },
    deleteSession: (id) => void sessions.delete(id),
    createSession: (id, _deps) => {
      if (failCreate.on) throw new Error("cannot create");
      if (sessions.has(id)) throw new Error(`Session ${id} already exists`);
      const trackId = festival.sessionTrackId(id)!;
      const s = new FakeSession(id, trackId);
      sessions.set(id, s);
      return s as unknown as Session;
    },
  };
  const deps: StarterDeps = {
    festival: () => festival,
    sessions: registry,
    progress: {
      getResumeRows: (id) => {
        calls.push(`rows ${id}`);
        const r = rows.get(id);
        return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
      },
      openSession: async (id, trackId) => {
        calls.push(`lock ${id}`);
        await onLock.run?.();
        if (onLock.fail) throw new Error("db down");
        const holder = lockHeldBy.get(trackId);
        if (holder !== undefined && holder !== id) {
          return { ok: false as const, heldBy: holder };
        }
        const fresh = holder === undefined;
        lockHeldBy.set(trackId, id);
        return { ok: true as const, fresh };
      },
      releaseSession: (id) => {
        calls.push(`release ${id}`);
        for (const [t, s] of lockHeldBy) if (s === id) lockHeldBy.delete(t);
        return Promise.resolve();
      },
    },
    missingAudio: () => Promise.resolve(out.missing),
    wire: (_id, plan, resumed) => {
      wired.push({ resumed, held: plan.held });
      return {} as SessionDependencies;
    },
    ended: (trackId, reason) => ended.push([trackId, reason]),
  };
  return {
    starter: new SessionStarter(deps),
    sessions,
    calls,
    ended,
    wired,
    rows,
    lockHeldBy,
    onLock,
    get missing() {
      return out.missing;
    },
    set missing(v) {
      out.missing = v;
    },
    failCreate,
  };
}

// deno-lint-ignore no-explicit-any
const body = (r: { body: object }) => r.body as Record<string, any>;

Deno.test("start: a session that is already running is a success, and nothing is planned", async () => {
  const t = setup();
  const s = new FakeSession(1, 1);
  s.running = true;
  t.sessions.set(1, s);
  const r = await t.starter.start(1);
  assertEquals([r.status, body(r).message], [200, "Session already running"]);
  assertEquals(t.calls, []);
});

Deno.test("start: a session not in the festival is 404; one with nothing to run is 400", async () => {
  const t = setup();
  assertEquals((await t.starter.start(9)).status, 404);
  assertEquals((await t.starter.start(4)).status, 400);
  assertEquals(t.calls, []);
});

Deno.test("start: a finished or a cancelled session is refused (409) before the track is touched", async () => {
  const t = setup();
  const base = { open: false, cursor: null, cursorScores: [] };
  t.rows.set(1, { ...base, finished: true });
  t.rows.set(2, { ...base, finished: false, cancelled: true });
  const a = await t.starter.start(1);
  const b = await t.starter.start(2);
  assertEquals([a.status, b.status], [409, 409]);
  assert(body(a).error.includes("already finished"));
  assert(body(b).error.includes("was cancelled"));
  assertEquals(t.calls.filter((c) => c.startsWith("lock")), []);
});

Deno.test("start: a database error reading the session's progress is 500 and takes no lock", async () => {
  const t = setup();
  t.rows.set(1, new Error("db down"));
  const r = await t.starter.start(1);
  assertEquals(r.status, 500);
  assertEquals(t.calls, ["rows 1"]);
});

Deno.test("start: a running session on the same track is 409, found before the database lock", async () => {
  const t = setup();
  const other = new FakeSession(2, 1);
  other.running = true;
  t.sessions.set(2, other);
  const r = await t.starter.start(1);
  assertEquals(r.status, 409);
  assert(body(r).error.includes("already has running session 2"));
  assertEquals(t.calls.filter((c) => c.startsWith("lock")), []);
});

Deno.test("start: a track another session holds in the database is 409 with that session's id (also after a restart)", async () => {
  const t = setup();
  t.lockHeldBy.set(1, 5);
  const r = await t.starter.start(1);
  assertEquals(r.status, 409);
  assertEquals(
    body(r).error,
    "Track 1 has session 5 open: it must finish first",
  );
  assertEquals(t.sessions.size, 0);
});

Deno.test("start: a database error taking the lock is 500", async () => {
  const t = setup();
  t.onLock.fail = true;
  const r = await t.starter.start(1);
  assertEquals(r.status, 500);
  assertEquals(t.sessions.size, 0);
});

Deno.test("start: a fresh session starts, runs with the track's permanent clients, and reports missing audio", async () => {
  const t = setup();
  t.missing = [{ competitionId: 11, competitorId: 101, kind: "announce" }];
  const r = await t.starter.start(1);
  assertEquals(r.status, 200);
  assertEquals(body(r), {
    success: true,
    message: "Session started",
    sessionId: 1,
    trackId: 1,
    missing_audio: [{
      competition_id: 11,
      competitor_id: 101,
      kind: "announce",
    }],
    already_finished: 0,
    reopened_scoring: false,
    clients: { permanent: ["dj1", "sb1"], judges: ["judge2", "judge3"] },
  });
  assertEquals(t.sessions.get(1)!.ran, {
    permanent: ["dj1", "sb1"],
    resumeFinished: 0,
  });
  assertEquals(t.wired, [{ resumed: false, held: false }]);
});

Deno.test("start: a session cut off mid-competition resumes at its cursor, held if the operator held it", async () => {
  const t = setup();
  t.lockHeldBy.set(1, 1); // it still holds its track
  t.rows.set(1, {
    finished: false,
    open: true,
    started: true,
    held: true,
    cursor: { competitionId: 11, competitorId: 101, phase: "scoring" },
    cursorScores: [],
  });
  const r = await t.starter.start(1, true);
  assertEquals(r.status, 200);
  assertEquals(
    [body(r).already_finished, body(r).reopened_scoring],
    [1, true],
  );
  assertEquals(t.wired, [{ resumed: true, held: true }]);
  assertEquals(t.calls.includes("release 1"), false);
});

Deno.test("start: a start that loses the race for the track during the lock is refused and gives back the lock it took", async () => {
  const t = setup();
  // While session 1 waits for the database, another session of the track
  // gets going (it was not running when session 1 was checked).
  t.onLock.run = () => {
    const other = new FakeSession(2, 1);
    other.running = true;
    t.sessions.set(2, other);
  };
  const r = await t.starter.start(1);
  assertEquals(r.status, 409);
  assert(body(r).error.includes("already has running session 2"));
  assert(t.calls.includes("release 1"), "the new lock is given back");
  assertEquals(t.sessions.has(1), false);
});

Deno.test("start: a resumed session that loses the race keeps the lock it already held", async () => {
  const t = setup();
  t.lockHeldBy.set(1, 1);
  t.onLock.run = () => {
    const other = new FakeSession(2, 1);
    other.running = true;
    t.sessions.set(2, other);
  };
  const r = await t.starter.start(1);
  assertEquals(r.status, 409);
  assertEquals(t.calls.includes("release 1"), false);
  assertEquals(t.lockHeldBy.get(1), 1);
});

Deno.test("start: two starts for one track at once - exactly one wins", async () => {
  const t = setup();
  const [a, b] = await Promise.all([t.starter.start(1), t.starter.start(2)]);
  assertEquals([a.status, b.status].toSorted(), [200, 409]);
  assertEquals([...t.sessions.keys()].length, 1);
  assertEquals([...t.lockHeldBy.values()].length, 1);
});

Deno.test("start: starts on different tracks do not interfere", async () => {
  const t = setup();
  const [a, b] = await Promise.all([t.starter.start(1), t.starter.start(3)]);
  assertEquals([a.status, b.status], [200, 200]);
  assertEquals([...t.sessions.keys()].toSorted(), [1, 3]);
});

Deno.test("start: a stale session (registered but not running) is replaced", async () => {
  const t = setup();
  t.sessions.set(1, new FakeSession(1, 1)); // not running
  const r = await t.starter.start(1);
  assertEquals(r.status, 200);
  assert(t.sessions.get(1)!.running);
});

Deno.test("start: a failure creating the session is 500 and gives back the lock it took", async () => {
  const t = setup();
  t.failCreate.on = true;
  const r = await t.starter.start(1);
  assertEquals(r.status, 500);
  assert(body(r).error.includes("cannot create"));
  assert(t.calls.includes("release 1"));
  assertEquals(t.lockHeldBy.size, 0); // the track is free for the next try
});

Deno.test("start: a failure creating a resumed session keeps the lock it already held", async () => {
  const t = setup();
  t.lockHeldBy.set(1, 1);
  t.failCreate.on = true;
  const r = await t.starter.start(1);
  assertEquals(r.status, 500);
  assertEquals(t.calls.includes("release 1"), false);
  assertEquals(t.lockHeldBy.get(1), 1);
});

Deno.test("run: when the session ends it is dropped and the track is told why; a replaced session is left alone", async () => {
  const t = setup();
  await t.starter.start(1);
  const first = t.sessions.get(1)!;
  first.finish("completed");
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(t.sessions.has(1), false);
  assertEquals(t.ended, [[1, "completed"]]);

  // A new run of the same session id replaces the old one in the registry;
  // the old run ending must not remove the new one.
  t.lockHeldBy.clear();
  await t.starter.start(1);
  const second = t.sessions.get(1)!;
  t.sessions.set(1, new FakeSession(1, 1)); // something else took the slot
  const taker = t.sessions.get(1)!;
  second.finish("aborted");
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(t.sessions.get(1), taker);
  assertEquals(t.ended.at(-1), [1, "aborted"]);
});

Deno.test("run: a session that throws is still dropped and reported", async () => {
  const t = setup();
  await t.starter.start(1);
  t.sessions.get(1)!.finish("error", true);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(t.sessions.has(1), false);
  assertEquals(t.ended, [[1, "error"]]);
});
