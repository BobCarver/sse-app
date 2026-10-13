import { type Context, Hono, type Next } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { streamSSE } from "@hono/hono/streaming";

// ============================================================================
// TYPES
// ============================================================================

import { ProgressEvent, ScoreSubmission, SSEClient } from "./types.ts";
import { AudioLibrary, type AudioMetadataStore } from "./audioLibrary.ts";
import { BundleError, loadBundle } from "./bundle.ts";
import { Festival, festival, setFestival } from "./festival.ts";
import { DiskAudioStorage } from "./audioStorage.ts";
import {
  buildManifest,
  type ManifestSource,
  trackAudioDigest,
} from "./audioManifest.ts";
import { type AnnouncerDeps, startAudioAnnouncer } from "./audioAnnouncer.ts";
import { AUDIO_KINDS, type AudioKind } from "./contract.ts";
import { DEFAULT_DEMO_SESSION, registerDemoRoutes } from "./demo.ts";
import { ADMIN_COOKIE, AdminSessions } from "./adminAuth.ts";
import { buildOverview } from "./adminOverview.ts";
import { planResume } from "./resume.ts";
import { handleResponse } from "./responseService.ts";
import { handleSSEConnection } from "./sse.ts";
import { judgeClaims, SessionManager } from "./sessionManager.ts";
import { Sequencer } from "./sequencer.ts";
import {
  allowances,
  estimateStarts,
  isLate,
  planFromBundle,
} from "./estimate.ts";
import { sessionsInOrder } from "../../shared/festival-bundle/mod.ts";
import {
  Credentials,
  hashSecret,
  pageFor,
  parseClientId,
} from "./credentials.ts";
import {
  cancelSession,
  credentialStore,
  getProgressRows,
  getResumeRows,
  getSessionMarks,
  openSession,
  pairBundle,
  recordProgress,
  releaseSession,
  resetSession,
  saveScore,
  setHeld,
  sql,
} from "./db.ts";

/** Who is making the request, set by the `requireClient` middleware. */
type Variables = { client: { sub: string; credentialId: number } };
type Ctx = Context<{ Variables: Variables }>;

// ============================================================================
// CONFIGURATION
// ============================================================================

// Debug logging gate (enabled when DEBUG=1 or DEBUG=true)
const DEBUG_LOGS = Deno.env.get("DEBUG") === "1" ||
  Deno.env.get("DEBUG") === "true";
export function dlog(...args: unknown[]) {
  if (DEBUG_LOGS) console.debug(...args);
}

// ============================================================================
// HONO APP
// ============================================================================

export const app = new Hono<{ Variables: Variables }>();

// Debug: log incoming requests to help trace 404s
app.use("*", async (c, next) => {
  try {
    // Never log credentials: /join/<secret> carries one in the path.
    console.log(
      "REQ",
      c.req.method,
      new URL(c.req.url).pathname.replace(/^\/join\/.*/, "/join/***"),
    );
  } catch (_e) {
    /* ignore logging errors */
  }
  await next();
});

// Health/readiness endpoint for e2e harness and external checks: the festival
// bundle is loaded and, when one is configured, the database answers.
app.get(
  "/_health",
  async (c: Ctx) => {
    if (!festival().loaded) {
      return c.json({ ok: false, error: "no festival bundle loaded" }, 500);
    }
    try {
      if (sql) await sql`SELECT 1`;
      return c.json({ ok: true, festival: festival().id });
    } catch (err) {
      console.error("health check failed:", err);
      return c.json({ ok: false, error: "database unavailable" }, 500);
    }
  },
);

// ============================================================================
// AUTH
// ============================================================================
//
// Devices authenticate with an admin-issued credential (see credentials.ts):
// the admin creates one per DJ / judge / scoreboard, and hands it out as a
// link. GET /join/<secret> stores it in an HttpOnly cookie; every request is
// checked against the stored hash, so revoking locks a device out at once.
// Admin operations use a separate bearer token (ADMIN_TOKEN).

export const credentials = new Credentials(credentialStore);
/** Competitors' music and announcements: listed in the bundle, files in AUDIO_DIR. */
const bundleAudio: AudioMetadataStore = {
  get: (ref) => Promise.resolve(festival().audioFile(ref)),
  listForCompetitions: (ids) => Promise.resolve(festival().audioFor(ids)),
};
export const audio = new AudioLibrary(
  new DiskAudioStorage(() => Deno.env.get("AUDIO_DIR") ?? "./audio"),
  bundleAudio,
);
/** What each DJ last reported holding (see POST /audio-ready). */
const audioReports = new Map<string, string>();

/**
 * When the track's sessions that have not run are expected to start: delays
 * cascade from the open session's remaining entries (see estimate.ts).
 */
async function trackEstimates(trackId: number): Promise<Map<number, Date>> {
  const track = festival().tracks.find((t) => t.id === trackId);
  if (!track) return new Map();
  const [marks, rows] = await Promise.all([
    getSessionMarks(),
    getProgressRows(),
  ]);
  const open = marks.openByTrack.get(trackId);
  const c = rows.cursors.find((x) => x.track_id === trackId);
  return estimateStarts(
    sessionsInOrder(track).filter((s) => !marks.done.has(s.id)).map(
      planFromBundle,
    ),
    open === undefined ? undefined : {
      sessionId: open,
      cursor: c && c.competition_id !== null && c.competitor_id !== null
        ? {
          competitionId: c.competition_id,
          competitorId: c.competitor_id,
          phase: c.phase,
        }
        : null,
    },
    new Date(),
    allowances(),
  );
}

/**
 * The session after this one on its track that has not run yet, if any, with
 * an estimate of its start when the track runs late.
 */
async function followingSession(sessionId: number) {
  const s = festival().followingSession(
    sessionId,
    (await getSessionMarks()).done,
  );
  if (!s) return undefined;
  const estimate = (await trackEstimates(s.trackId)).get(s.id);
  return {
    name: s.name,
    startTime: s.startTime,
    estimate: estimate && isLate(estimate, s.startTime) ? estimate : undefined,
  };
}

const manifestSource: ManifestSource = {
  competitions: (trackId) => festival().trackCompetitions(trackId),
};
/** Whether the judge/track behind a client id is in the festival bundle. */
export const clientCheck = {
  exists: (kind: "dj" | "judge" | "sb", num: number) =>
    Promise.resolve(
      kind === "judge" ? festival().hasJudge(num) : festival().hasTrack(num),
    ),
};

const COOKIE = "session_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // credentials are revoked server-side, not by expiry

/** Constant-time string comparison (on digests, so lengths never leak). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([hashSecret(a), hashSecret(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

if (!Deno.env.get("ADMIN_TOKEN")) {
  console.warn(
    "ADMIN_TOKEN is not set: admin endpoints (issuing links, starting sessions) are disabled",
  );
}

/** Browser sign-ins for the admin pages (the CLI uses the bearer token). */
const adminSessions = new AdminSessions();
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Administrator: the admin bearer token, or the cookie set by POST /admin/login.
 * A cookie-authenticated change must also carry `x-admin-request: 1`, which a
 * cross-site page cannot send (on top of the SameSite=Strict cookie). Fails
 * closed when ADMIN_TOKEN is unset.
 */
async function requireAdmin(c: Ctx, next: Next) {
  const expected = Deno.env.get("ADMIN_TOKEN");
  if (!expected) {
    return c.json({ error: "admin access is not configured" }, 503);
  }
  const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  if (given) {
    if (!(await safeEqual(given, expected))) {
      return c.json({ error: "admin credentials required" }, 401);
    }
    return await next();
  }
  if (adminSessions.valid(getCookie(c, ADMIN_COOKIE))) {
    if (
      !SAFE_METHODS.has(c.req.method) &&
      c.req.header("x-admin-request") !== "1"
    ) {
      return c.json({ error: "missing x-admin-request header" }, 403);
    }
    return await next();
  }
  return c.json({ error: "admin credentials required" }, 401);
}

/** A device with a valid, unrevoked credential cookie. */
async function requireClient(c: Ctx, next: Next) {
  let credential;
  try {
    credential = await credentials.authenticate(getCookie(c, COOKIE) ?? "");
  } catch (err) {
    console.error("credential lookup failed:", err);
    return c.json({ error: "authentication unavailable" }, 503);
  }
  if (!credential) return c.json({ error: "unauthorized" }, 401);
  c.set("client", { sub: credential.clientId, credentialId: credential.id });
  await next();
}

// Open a link: exchange the secret for a cookie, then go to the right page.
app.get("/join/:secret", async (c: Ctx) => {
  const credential = await credentials.authenticate(c.req.param("secret"));
  const page = credential && pageFor(credential.clientId);
  const noStore = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
  };
  if (!credential || !page) {
    return c.text(
      "This link is invalid or has been revoked. Ask an administrator for a new one.",
      401,
      noStore,
    );
  }
  setCookie(c, COOKIE, c.req.param("secret"), {
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:" ||
      c.req.header("x-forwarded-proto") === "https",
  });
  for (const [k, v] of Object.entries(noStore)) c.header(k, v);
  return c.redirect(page);
});

// Who am I? Pages learn their identity from the server, not from the URL.
app.get("/session", requireClient, (c: Ctx) => {
  c.header("cache-control", "no-store");
  return c.json({ client_id: c.get("client").sub });
});

app.post("/logout", (c: Ctx) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.json({ success: true });
});

// --- admin: browser sign-in and the festival overview -----------------------

app.post("/admin/login", async (c: Ctx) => {
  const expected = Deno.env.get("ADMIN_TOKEN");
  if (!expected) {
    return c.json({ error: "admin access is not configured" }, 503);
  }
  if (!(c.req.header("content-type") ?? "").includes("application/json")) {
    return c.json({ error: "content-type must be application/json" }, 415);
  }
  const body = await c.req.json().catch(() => null) as
    | { token?: unknown }
    | null;
  if (
    typeof body?.token !== "string" || !(await safeEqual(body.token, expected))
  ) {
    await new Promise((r) => setTimeout(r, 400)); // slow down guessing
    return c.json({ error: "wrong token" }, 401);
  }
  setCookie(c, ADMIN_COOKIE, adminSessions.create(), {
    path: "/",
    maxAge: 12 * 60 * 60,
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:" ||
      c.req.header("x-forwarded-proto") === "https",
  });
  c.header("cache-control", "no-store");
  return c.json({ success: true });
});

app.post("/admin/logout", (c: Ctx) => {
  adminSessions.destroy(getCookie(c, ADMIN_COOKIE));
  deleteCookie(c, ADMIN_COOKIE, { path: "/" });
  return c.json({ success: true });
});

/** 200 when signed in; the page uses it to decide between the form and the tree. */
app.get("/admin/me", requireAdmin, (c: Ctx) => c.json({ admin: true }));

/** Connected devices: waiting in the pool, or inside a session. */
function connectedClientIds(): Set<string> {
  return new Set([
    ...unassignedClients.keys(),
    ...SessionManager.getAllSessions().flatMap((sess) =>
      [...sess.clients].filter(([, client]) => client).map(([id]) => id)
    ),
  ]);
}

/** The whole festival at once: tracks, sessions, competitions, competitors, links. */
app.get("/admin/overview", requireAdmin, async (c: Ctx) => {
  try {
    const f = festival();
    const overview = buildOverview(f.data, await getProgressRows(), {
      audio: f.audioFor(
        f.tracks.flatMap((t) =>
          t.sessions.flatMap((s) => s.competitions.map((x) => x.id))
        ),
      ),
      credentials: await credentials.all(),
      connected: connectedClientIds(),
      live: (id: number) => {
        const sess = SessionManager.getSession(id);
        if (!sess?.isRunning()) return null;
        const st = sess.status();
        return {
          held: st.held,
          phase: st.phase,
          competition_name: st.competition_name,
          position: st.position,
          waiting_for: st.waiting_for,
        };
      },
    });
    c.header("cache-control", "no-store");
    return c.json(overview);
  } catch (err) {
    console.error("admin overview failed:", err);
    return c.json({ error: "could not load the overview" }, 500);
  }
});

// --- admin: issue / list / revoke -------------------------------------------

app.post("/admin/credentials", requireAdmin, async (c: Ctx) => {
  const body = await c.req.json().catch(() => null) as
    | { client_id?: unknown; label?: unknown }
    | null;
  const clientId = body?.client_id;
  if (typeof clientId !== "string" || !parseClientId(clientId)) {
    return c.json(
      { error: "client_id must look like dj1, judge2 or sb1" },
      400,
    );
  }
  const label = typeof body?.label === "string" ? body.label : undefined;
  try {
    const parsedId = parseClientId(clientId)!;
    if (!(await clientCheck.exists(parsedId.kind, parsedId.num))) {
      const what = parsedId.kind === "judge" ? "judge" : "track";
      return c.json({ error: `no ${what} ${parsedId.num}` }, 404);
    }
    const { credential, secret } = await credentials.issue(clientId, label);
    const origin = Deno.env.get("PUBLIC_URL") ?? new URL(c.req.url).origin;
    return c.json({
      id: credential.id,
      client_id: credential.clientId,
      label: credential.label,
      link: `${origin}/join/${secret}`, // shown once; only its hash is stored
    }, 201);
  } catch (err) {
    console.error("issue credential failed:", err);
    return c.json({ error: "could not create credential" }, 500);
  }
});

app.get(
  "/admin/credentials",
  requireAdmin,
  async (c: Ctx) =>
    c.json(
      (await credentials.all()).map((x) => ({
        id: x.id,
        client_id: x.clientId,
        label: x.label,
        created_at: x.createdAt,
        revoked_at: x.revokedAt,
      })),
    ),
);

app.delete("/admin/credentials/:id", requireAdmin, async (c: Ctx) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  if (!(await credentials.revoke(id))) {
    return c.json({ error: "no active credential with that id" }, 404);
  }
  return c.json({ success: true });
});

// --- admin: watch and control running sessions ------------------------------

app.get(
  "/admin/sessions",
  requireAdmin,
  (c: Ctx) => c.json(SessionManager.getAllSessions().map((s) => s.status())),
);

/** Stop waiting for whatever the session is stuck on (see Session.skip). */
app.post("/admin/sessions/:id/skip", requireAdmin, (c: Ctx) => {
  const session = SessionManager.getSession(Number(c.req.param("id")));
  if (!session?.isRunning()) {
    return c.json({ error: "no running session" }, 404);
  }
  const skipped = session.skip();
  if (!skipped) return c.json({ error: "nothing to skip right now" }, 409);
  return c.json({ success: true, skipped });
});

/**
 * Re-open scoring for a competitor nobody scored: the session is waiting for
 * the operator to skip it or do this.
 */
app.post("/admin/sessions/:id/reopen", requireAdmin, (c: Ctx) => {
  const session = SessionManager.getSession(Number(c.req.param("id")));
  if (!session?.isRunning()) {
    return c.json({ error: "no running session" }, 404);
  }
  if (!session.reopen()) {
    return c.json({
      error: "nothing to re-open: scoring has not closed without scores",
    }, 409);
  }
  return c.json({ success: true });
});

/** The running session the route names, if any. */
function runningSession(c: Ctx) {
  const s = SessionManager.getSession(Number(c.req.param("id")));
  return s?.isRunning() ? s : undefined;
}

/** A session of the festival that is not running (404 if unknown). */
function idleTarget(c: Ctx) {
  const id = Number(c.req.param("id"));
  const trackId = Number.isInteger(id)
    ? festival().sessionTrackId(id)
    : undefined;
  return trackId === undefined ? undefined : { id, trackId };
}

/** Is the session finished or cancelled (nothing left to hold or cancel)? */
async function isDone(id: number): Promise<boolean> {
  return (await getSessionMarks()).done.has(id);
}

/**
 * Hold a session: nothing new starts (competition, performance, scoring, end)
 * until it is released. Kept across restarts; a session not running yet starts
 * held.
 */
app.post("/admin/sessions/:id/hold", requireAdmin, async (c: Ctx) => {
  const session = runningSession(c);
  if (session) {
    if (!session.hold()) return c.json({ error: "already held" }, 409);
    return c.json({ success: true });
  }
  const t = idleTarget(c);
  if (!t) return c.json({ error: "no such session" }, 404);
  if (await isDone(t.id)) {
    return c.json({ error: "the session is finished or cancelled" }, 409);
  }
  await setHeld(t.id, t.trackId, true);
  return c.json({ success: true, message: "held (not running yet)" });
});

app.post("/admin/sessions/:id/release", requireAdmin, async (c: Ctx) => {
  const session = runningSession(c);
  if (session) {
    if (!session.release()) return c.json({ error: "not held" }, 409);
    return c.json({ success: true });
  }
  const t = idleTarget(c);
  if (!t) return c.json({ error: "no such session" }, 404);
  await setHeld(t.id, t.trackId, false);
  return c.json({ success: true, message: "released (not running)" });
});

/**
 * Drop a session for good: it stops now if running (every page is told),
 * is marked cancelled, is never run, and its track moves on to the next one.
 */
app.post("/admin/sessions/:id/cancel", requireAdmin, async (c: Ctx) => {
  const session = runningSession(c);
  if (session) {
    session.cancel(); // its end writes the marker; the track is re-armed then
    return c.json({ success: true });
  }
  const leftover = SessionManager.getSession(Number(c.req.param("id")));
  if (leftover) SessionManager.deleteSession(leftover.id);
  const t = idleTarget(c);
  if (!t) return c.json({ error: "no such session" }, 404);
  if (await isDone(t.id)) {
    return c.json({ error: "the session is finished or cancelled" }, 409);
  }
  await cancelSession(t.id, t.trackId);
  void sequencer.armTrack(t.trackId);
  return c.json({ success: true, message: "cancelled (was not running)" });
});

// ============================================================================
// SSE ENDPOINT
// ============================================================================

// Store of unassigned clients (connected but not yet assigned to a session)
const unassignedClients: Map<string, SSEClient> = new Map();

// SSE connection; identity comes from the credential.
app.get("/events", requireClient, (c: Ctx) => {
  const clientId = c.get("client").sub;
  const clientType = parseClientId(clientId)!.kind;

  return streamSSE(c, async (stream) => {
    await handleSSEConnection(
      stream,
      c.req.raw.signal,
      clientId,
      clientType,
      { SessionManager, unassignedClients },
    );
  });
});

// ============================================================================
// SESSION ENDPOINTS
// ============================================================================
// Frontend pages and their bundles (build with `deno task build`).
async function serveFile(path: URL, contentType: string): Promise<Response> {
  try {
    return new Response(await Deno.readFile(path), {
      headers: { "content-type": contentType, "cache-control": "no-cache" },
    });
  } catch (_err) {
    return new Response("Not found", { status: 404 });
  }
}

const pages: Record<string, string> = {
  "/dj": "dj.html",
  "/judge": "jd.html",
  "/scoreboard": "sb.html",
  "/admin": "admin.html",
};
for (const [route, file] of Object.entries(pages)) {
  app.get(
    route,
    () =>
      serveFile(
        new URL(`../frontend-src/${file}`, import.meta.url),
        "text/html; charset=utf-8",
      ),
  );
}

const bundles = new Set(["dj.js", "jd.js", "sb.js", "admin.js"]);
app.get("/js/:file", (c) => {
  const file = c.req.param("file");
  if (!bundles.has(file)) return c.notFound();
  return serveFile(
    new URL(`../../public/${file}`, import.meta.url),
    "application/javascript",
  );
});

// Start a session - loads it from the festival bundle and runs it.
// Rules: one open session per track (the database's progress row is the lock);
// the track's DJ (dj<trackId>) and scoreboard (sb<trackId>) are permanent
// clients; judges are held by the session until it completes.
type StartResult = { status: 200 | 400 | 404 | 409 | 500; body: object };
const reply = (
  body: object,
  status: StartResult["status"] = 200,
): StartResult => ({ status, body });

/**
 * Load a session from the bundle and run (arm) it from wherever it stopped.
 * `resumed`: it had begun before (a restart), so the audio start gate is
 * skipped (the DJ's ready report is memory only).
 */
async function startSession(
  sessionId: number,
  resumed = false,
): Promise<StartResult> {
  // Idempotent start: already running is success.
  const existing = SessionManager.getSession(sessionId);
  if (existing?.isRunning()) {
    return reply({
      success: true,
      message: "Session already running",
      sessionId,
    });
  }

  const competitions = festival().sessionCompetitions(sessionId);
  const trackId = festival().sessionTrackId(sessionId);
  if (trackId === undefined) {
    return reply({ error: `No session ${sessionId} in the festival` }, 404);
  }
  if (competitions.length === 0) {
    return reply({
      error: `No competitions provided for session ${sessionId}`,
    }, 400);
  }

  let resume: ReturnType<typeof planResume>;
  let held = false;
  try {
    const rows = await getResumeRows(sessionId);
    if (rows?.finished) {
      return reply({ error: `Session ${sessionId} has already finished` }, 409);
    }
    if (rows?.cancelled) {
      return reply({ error: `Session ${sessionId} was cancelled` }, 409);
    }
    held = !!rows?.held;
    // Start where the session left off (after a stop or a server restart).
    resume = planResume(competitions, rows);
  } catch (err) {
    console.error(`Session ${sessionId}: database error on start:`, err);
    return reply({ error: "Database error while loading session" }, 500);
  }

  const judgeClients = [
    ...new Set(
      competitions.flatMap((comp) =>
        comp.rubric.judges.map((j) => `judge${j.id}`)
      ),
    ),
  ];
  const permanentClientIds = [`dj${trackId}`, `sb${trackId}`];

  // Report (don't block on) audio the bundle does not have: those
  // performances would be skipped.
  const missingAudio = (await audio.missing(competitions, AUDIO_KINDS)).map(
    (m) => ({
      competition_id: m.competitionId,
      competitor_id: m.competitorId,
      kind: m.kind,
    }),
  );

  let conflict = SessionManager.findConflict(sessionId, trackId);
  if (conflict) return reply({ error: conflict }, 409);

  // The track's lock in the database: survives a restart, unlike the check
  // above. A fresh session's cursor starts on its first competitor.
  let lock;
  try {
    lock = await openSession(sessionId, trackId, {
      competitionId: competitions[0].id,
      competitorId: competitions[0].competitors[0].id,
    });
  } catch (err) {
    console.error(
      `Session ${sessionId}: could not take track ${trackId}:`,
      err,
    );
    return reply({ error: "Database error while opening the session" }, 500);
  }
  if (!lock.ok) {
    return reply({
      error:
        `Track ${trackId} has session ${lock.heldBy} open: it must finish first`,
    }, 409);
  }

  // No await between this check and createSession: the claim is atomic.
  conflict = SessionManager.findConflict(sessionId, trackId);
  if (conflict) {
    if (lock.fresh) await releaseSession(sessionId);
    return reply({ error: conflict }, 409);
  }

  if (existing) {
    console.warn(`Session ${sessionId} is stale (not running); replacing`);
    SessionManager.deleteSession(sessionId);
  }

  let session;
  try {
    session = SessionManager.createSession(sessionId, {
      unassignedClients,
      trackId,
      claims: judgeClaims,
      plannedStart: festival().session(sessionId)?.startTime,
      held,
      djGates: Deno.env.get("DJ_GATES") !== "0",
      followingSession: () => followingSession(sessionId),
      saveScore: (scoreData: ScoreSubmission) => {
        dlog("Saving score data:", scoreData);
        return saveScore(scoreData);
      },
      recordProgress: (event: ProgressEvent) =>
        recordProgress(sessionId, event),
      // The DJ holds the whole track's audio, reported once for the day (the
      // report outlives the session). After a crash the audio was in place
      // before: don't wait for the DJ page to report it again.
      audioGate: resumed ? undefined : {
        expectedDigest: () =>
          trackAudioDigest(audio, festival().trackCompetitions(trackId)),
        reported: (djId: string) => audioReports.get(djId),
      },
    });
  } catch (err) {
    return reply({ error: String(err) }, 500);
  }

  // Run asynchronously; the session is removed when it finishes or fails.
  session.runSession(competitions, permanentClientIds, resume)
    .catch((error: unknown) => {
      console.error(`Session ${sessionId} error:`, error);
    })
    .finally(() => {
      // Only delete our own session (a restart may have replaced it).
      if (SessionManager.getSession(sessionId) === session) {
        SessionManager.deleteSession(sessionId);
      }
      console.log(`Session ${sessionId} ended (${session.endReason})`);
      // The track moves on to its next session (when the sequencer runs).
      sequencer.sessionEnded(trackId, session.endReason);
    });

  if (missingAudio.length > 0) {
    console.warn(
      `Session ${sessionId}: ${missingAudio.length} audio file(s) missing`,
    );
  }

  return reply({
    success: true,
    message: "Session started",
    sessionId,
    trackId,
    missing_audio: missingAudio,
    already_finished: resume.finished.size,
    reopened_scoring: resume.reopen ? true : false,
    clients: { permanent: permanentClientIds, judges: judgeClients },
  });
}

app.post(
  "/sessions/:sessionId/start",
  requireAdmin,
  async (c: Ctx) => {
    const sessionId = Number(c.req.param("sessionId"));
    if (!Number.isInteger(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }
    const result = await startSession(sessionId);
    return c.json(result.body, result.status);
  },
);

/**
 * Arms each track's open session (see sequencer.ts): at boot (which resumes a
 * session a crash or a shutdown cut off, at its cursor), after a session ends
 * and after a cancel. Enabled at boot unless ARMING=0 or DEMO=1.
 */
export const sequencer = new Sequencer({
  tracks: () => festival().tracks.map((t) => t.id),
  async nextFor(trackId) {
    const marks = await getSessionMarks();
    const s = festival().nextSession(
      trackId,
      marks.done,
      marks.openByTrack.get(trackId),
    );
    if (!s) return undefined;
    return {
      sessionId: s.id,
      started: !!(await getResumeRows(s.id))?.started,
    };
  },
  busy: (trackId) =>
    SessionManager.getRunningSessions().some((s) => s.trackId === trackId),
  start: (sessionId, resumed) => startSession(sessionId, resumed),
});

// --- audio -------------------------------------------------------------------

function parseAudioParams(c: Ctx) {
  const competitionId = Number(c.req.param("competitionId"));
  const competitorId = Number(c.req.param("competitorId"));
  const kind = c.req.param("kind") as AudioKind;
  if (
    !Number.isInteger(competitionId) || !Number.isInteger(competitorId) ||
    !AUDIO_KINDS.includes(kind)
  ) return undefined;
  return { competitionId, competitorId, kind };
}

// What a DJ should download for the day: the audio of all its track's sessions.
app.get("/audio-manifest", requireClient, async (c: Ctx) => {
  const who = parseClientId(c.get("client").sub);
  if (who?.kind !== "dj") return c.json({ error: "DJs only" }, 403);
  try {
    const manifest = await buildManifest(audio, manifestSource, who.num);
    c.header("cache-control", "no-store");
    return c.json(manifest);
  } catch (err) {
    console.error("audio manifest failed:", err);
    return c.json({ error: "could not build manifest" }, 500);
  }
});

// The DJ page reports the digest of the audio set it holds and has verified.
// Releases the start gate if that is the expected set (the track's whole set).
app.post("/audio-ready", requireClient, async (c: Ctx) => {
  const sender = c.get("client").sub;
  if (parseClientId(sender)?.kind !== "dj") {
    return c.json({ error: "DJs only" }, 403);
  }
  if (!(c.req.header("content-type") ?? "").includes("application/json")) {
    return c.json({ error: "content-type must be application/json" }, 415);
  }
  const body = await c.req.json().catch(() => null) as
    | { digest?: unknown }
    | null;
  if (typeof body?.digest !== "string" || !/^[0-9a-f]{64}$/.test(body.digest)) {
    return c.json({ error: "digest must be a sha256 hex string" }, 400);
  }
  audioReports.set(sender, body.digest);
  await SessionManager.findSessionForClient(sender)?.audioReported(
    sender,
    body.digest,
  );
  return c.json({ success: true });
});

// Playback: only a DJ of the competition's track. Supports Range requests so
// the browser can seek.
app.get(
  "/audio/:competitionId/:competitorId/:kind",
  requireClient,
  async (c: Ctx) => {
    const ref = parseAudioParams(c);
    if (!ref) return c.json({ error: "invalid audio reference" }, 400);

    const who = parseClientId(c.get("client").sub);
    if (who?.kind !== "dj") return c.json({ error: "DJs only" }, 403);
    const info = festival().competition(ref.competitionId);
    if (info && info.trackId !== who.num) {
      return c.json({ error: "not your track" }, 403);
    }

    const rec = await audio.get(ref);
    const opened = rec && await audio.open(rec);
    if (!rec || !opened) return c.json({ error: "no audio" }, 404);
    const { size, file } = opened;

    const headers = new Headers({
      "content-type": rec.contentType,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=0, must-revalidate",
      etag: `"${rec.sha256}"`,
    });
    if (c.req.header("if-none-match") === headers.get("etag")) {
      file.close();
      return new Response(null, { status: 304, headers });
    }

    let start = 0, end = size - 1, status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else {
        start = Math.max(0, size - Number(range[2])); // last N bytes
      }
      if (start > end || start >= size) {
        file.close();
        headers.set("content-range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("content-range", `bytes ${start}-${end}/${size}`);
    }
    const length = end - start + 1;
    headers.set("content-length", String(length));
    await file.seek(start, Deno.SeekMode.Start);
    const body = file.readable.pipeThrough(limitBytes(length));
    return new Response(body, { status, headers });
  },
);

/** Pass through at most `n` bytes, then end the stream (closing the file). */
function limitBytes(n: number): TransformStream<Uint8Array, Uint8Array> {
  let left = n;
  return new TransformStream({
    transform(chunk, controller) {
      if (left <= 0) return controller.terminate();
      controller.enqueue(chunk.length > left ? chunk.subarray(0, left) : chunk);
      left -= chunk.length;
      if (left <= 0) controller.terminate();
    },
  });
}

// Consolidated tag-based responder endpoint. Body shape: see ResponseBody in contract.ts
app.post(
  "/response",
  requireClient,
  async (c: Ctx) => {
    // Cross-site forms cannot send JSON without a preflight (CSRF defence in
    // depth on top of the SameSite=Strict cookie).
    if (!(c.req.header("content-type") ?? "").includes("application/json")) {
      return c.json({ error: "content-type must be application/json" }, 415);
    }
    let body: { tag?: unknown; payload?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const result = handleResponse(c.get("client").sub, body);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ success: true });
  },
);
/** Who is told that their track's audio set is there (see audioAnnouncer.ts). */
const announcerDeps: AnnouncerDeps = {
  audio,
  source: manifestSource,
  connectedClients: () => [
    ...unassignedClients.values(),
    ...SessionManager.getRunningSessions().flatMap((sess) =>
      [...sess.clients.values()].filter((x) => x !== undefined)
    ),
  ],
};

// Development demo page: scoreboard, DJ and two judges in one tab. Off unless
// DEMO=1 (it hands out sign-in links to anyone holding the admin token).
if (Deno.env.get("DEMO") === "1") {
  console.warn(
    `DEMO mode: /demo is enabled (default session ${DEFAULT_DEMO_SESSION}). Do not use in production.`,
  );
  registerDemoRoutes(app, {
    adminToken: () => Deno.env.get("ADMIN_TOKEN"),
    safeEqual,
    credentials,
    getSessionTrackId: (id: number) =>
      Promise.resolve(festival().sessionTrackId(id)),
    getSessionCompetitions: (id: number) =>
      Promise.resolve(festival().sessionCompetitions(id)),
    resetSession: (id: number) =>
      resetSession(id, festival().sessionCompetitions(id).map((c) => c.id)),
    isRunning: (id: number) =>
      SessionManager.getSession(id)?.isRunning() ?? false,
  });
}

// ============================================================================
// CLEANUP
// ============================================================================

// Graceful shutdown: tell clients the sessions are ending, let in-flight score
// saves finish, then close the database pool.
let shuttingDown = false;
export async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down...");
  for (const s of SessionManager.getRunningSessions()) {
    s.abort("server shutting down");
  }
  await new Promise((r) => setTimeout(r, 500)); // let sessions wind down
  try {
    await sql?.end({ timeout: 5 });
  } catch (err) {
    console.error("error closing database:", err);
  }
  Deno.exit(code);
}

Deno.addSignalListener("SIGINT", () => shutdown());
Deno.addSignalListener("SIGTERM", () => shutdown());

// ============================================================================
// START SERVER
// ============================================================================

export const port = parseInt(Deno.env.get("PORT") || "3000");

// Default export is the fetch handler so `deno serve` can use it directly.
export default app.fetch;

/**
 * Load and verify the festival bundle (BUNDLE_DIR, audio in AUDIO_DIR), pair
 * the database with it, and make it the festival. Throws BundleError (with
 * every problem found) if the bundle or the pairing is refused.
 */
export async function loadFestival(
  bundleDir = Deno.env.get("BUNDLE_DIR") ?? "./bundle",
  audioDir = Deno.env.get("AUDIO_DIR") ?? "./audio",
): Promise<Festival> {
  const bundle = await loadBundle(bundleDir, audioDir);
  const refused = await pairBundle({
    festivalId: bundle.data.festival.id,
    digest: bundle.manifest.digest,
    dataText: bundle.dataText,
  });
  if (refused) throw new BundleError([refused]);
  const f = new Festival(bundle.data, bundle.manifest.digest);
  setFestival(f);
  console.log(
    `Festival ${f.id} "${f.name}" loaded from ${bundleDir} (bundle ${
      f.digest.slice(0, 12)
    }, ${bundle.manifest.audio.length} audio files verified)`,
  );
  return f;
}

// When run directly, start an HTTP listener to allow real network e2e tests.
if (import.meta.main) {
  try {
    await loadFestival();
  } catch (err) {
    console.error(err instanceof BundleError ? err.message : err);
    await sql?.end({ timeout: 5 });
    Deno.exit(1);
  }
  startAudioAnnouncer(announcerDeps);
  if (Deno.env.get("DEMO") !== "1" && Deno.env.get("ARMING") !== "0") {
    sequencer.enabled = true;
    await sequencer.armAll();
  }
  (async () => {
    console.log(`Server running on http://localhost:${port}`);
    await Deno.serve({ port }, app.fetch);
  })();
}
