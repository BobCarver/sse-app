import { type Context, Hono, type Next } from "@hono/hono";
import { deleteCookie, getCookie, setCookie } from "@hono/hono/cookie";
import { streamSSE } from "@hono/hono/streaming";

// ============================================================================
// TYPES
// ============================================================================

import { Scores, ScoreSubmission, SSEClient } from "./types.ts";
import { resolvers } from "./resolveTag.ts";
import { parseTag, validatePayload } from "./contract.ts";
import { handleSSEConnection } from "./sse.ts";
import { SessionManager } from "./sessionManager.ts";
import {
  Credentials,
  hashSecret,
  pageFor,
  parseClientId,
} from "./credentials.ts";
import {
  credentialStore,
  getSessionCompetitionsWithRubrics,
  getSessionTrackId,
  saveScore,
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

// Basic root for tests
app.get("/", (c: Ctx) => c.text("Hello Hono"));

// Health/readiness endpoint for e2e harness and external checks
app.get(
  "/_health",
  async (c: Ctx) => {
    // If the app is expected to rely on a database for e2e tests, verify DB is configured
    const dbUrl = Deno.env.get("DATABASE_URL");
    if (!dbUrl) {
      return c.json({ ok: false, error: "DATABASE_URL not set" }, 500);
    }

    try {
      // Quick check: ensure at least one competition exists (seeded in e2e)
      const comps = await getSessionCompetitionsWithRubrics(1);
      if (!comps || comps.length === 0) {
        return c.json({ ok: false, error: "No competitions found" }, 500);
      }
      return c.json({ ok: true });
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

/** Admin bearer token. Fails closed when ADMIN_TOKEN is unset. */
async function requireAdmin(c: Ctx, next: Next) {
  const expected = Deno.env.get("ADMIN_TOKEN");
  if (!expected) return c.json({ error: "admin access is not configured" }, 503);
  const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
  if (!given || !(await safeEqual(given, expected))) {
    return c.json({ error: "admin credentials required" }, 401);
  }
  await next();
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
  const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
  if (!credential || !page) {
    return c.text("This link is invalid or has been revoked. Ask an administrator for a new one.", 401, noStore);
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

// --- admin: issue / list / revoke -------------------------------------------

app.post("/admin/credentials", requireAdmin, async (c: Ctx) => {
  const body = await c.req.json().catch(() => null) as
    | { client_id?: unknown; label?: unknown }
    | null;
  const clientId = body?.client_id;
  if (typeof clientId !== "string" || !parseClientId(clientId)) {
    return c.json({ error: "client_id must look like dj1, judge2 or sb1" }, 400);
  }
  const label = typeof body?.label === "string" ? body.label : undefined;
  try {
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

app.get("/admin/credentials", requireAdmin, (c: Ctx) =>
  c.json(credentials.list().map((x) => ({
    id: x.id,
    client_id: x.clientId,
    label: x.label,
    created_at: x.createdAt,
    revoked_at: x.revokedAt,
  }))));

app.delete("/admin/credentials/:id", requireAdmin, async (c: Ctx) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  if (!(await credentials.revoke(id))) {
    return c.json({ error: "no active credential with that id" }, 404);
  }
  return c.json({ success: true });
});

// --- admin: watch and control running sessions ------------------------------

app.get("/admin/sessions", requireAdmin, (c: Ctx) =>
  c.json(SessionManager.getAllSessions().map((s) => s.status())));

/** Stop waiting for whatever the session is stuck on (see Session.skip). */
app.post("/admin/sessions/:id/skip", requireAdmin, (c: Ctx) => {
  const session = SessionManager.getSession(Number(c.req.param("id")));
  if (!session?.isRunning()) return c.json({ error: "no running session" }, 404);
  const skipped = session.skip();
  if (!skipped) return c.json({ error: "nothing to skip right now" }, 409);
  return c.json({ success: true, skipped });
});

/** End a session now (stuck, or started by mistake) and free its track and judges. */
app.post("/admin/sessions/:id/abort", requireAdmin, (c: Ctx) => {
  const id = Number(c.req.param("id"));
  const session = SessionManager.getSession(id);
  if (!session) return c.json({ error: "no such session" }, 404);
  if (!session.isRunning()) {
    // Left over from an earlier failure: just forget it.
    SessionManager.deleteSession(id);
    return c.json({ success: true, message: "removed a session that was not running" });
  }
  session.abort("aborted by administrator");
  return c.json({ success: true });
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

const bundles = new Set(["dj.js", "jd.js", "sb.js"]);
app.get("/js/:file", (c) => {
  const file = c.req.param("file");
  if (!bundles.has(file)) return c.notFound();
  return serveFile(
    new URL(`../../public/${file}`, import.meta.url),
    "application/javascript",
  );
});

// Start a session - queries DB, builds session, and runs it.
// Rules: one running session per track; the track's DJ (dj<trackId>) and
// scoreboard (sb<trackId>) are permanent clients; judges are held by the
// session until it completes.
app.post(
  "/sessions/:sessionId/start",
  requireAdmin,
  async (c: Ctx) => {
    const sessionId = Number(c.req.param("sessionId"));
    if (!Number.isInteger(sessionId)) {
      return c.json({ error: "Invalid session ID" }, 400);
    }

    // Idempotent start: already running is success.
    const existing = SessionManager.getSession(sessionId);
    if (existing?.isRunning()) {
      return c.json({
        success: true,
        message: "Session already running",
        sessionId,
      });
    }

    let competitions;
    let trackId;
    try {
      competitions = await getSessionCompetitionsWithRubrics(sessionId);
      trackId = await getSessionTrackId(sessionId);
    } catch (err) {
      // A real database failure is not "no competitions": say so.
      console.error(`Session ${sessionId}: database error on start:`, err);
      return c.json({ error: "Database error while loading session" }, 500);
    }
    if (!competitions || competitions.length === 0) {
      return c.json({
        error: `No competitions provided for session ${sessionId}`,
      }, 400);
    }
    if (trackId === undefined) {
      return c.json({ error: `Session ${sessionId} has no track` }, 404);
    }

    const judgeClients = [
      ...new Set(
        competitions.flatMap((comp) =>
          comp.rubric.judges.map((j) => `judge${j.id}`)
        ),
      ),
    ];
    const permanentClientIds = [`dj${trackId}`, `sb${trackId}`];

    // No await between this check and createSession: the claim is atomic.
    const conflict = SessionManager.findConflict(
      sessionId,
      trackId,
      judgeClients,
    );
    if (conflict) return c.json({ error: conflict }, 409);

    if (existing) {
      console.warn(`Session ${sessionId} is stale (not running); replacing`);
      SessionManager.deleteSession(sessionId);
    }

    let session;
    try {
      session = SessionManager.createSession(sessionId, {
        unassignedClients,
        trackId,
        claimedClients: judgeClients,
        saveScore: (scoreData: ScoreSubmission) => {
          dlog("Saving score data:", scoreData);
          return saveScore(scoreData);
        },
      });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }

    // Run asynchronously; the session is removed when it finishes or fails.
    session.runSession(competitions, permanentClientIds)
      .catch((error: unknown) => {
        console.error(`Session ${sessionId} error:`, error);
      })
      .finally(() => {
        // Only delete our own session (a restart may have replaced it).
        if (SessionManager.getSession(sessionId) === session) {
          SessionManager.deleteSession(sessionId);
        }
        console.log(`Session ${sessionId} completed`);
      });

    return c.json({
      success: true,
      message: "Session started",
      sessionId,
      trackId,
      clients: { permanent: permanentClientIds, judges: judgeClients },
    });
  },
);

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
    const parsed = parseTag(body?.tag);
    if (!parsed) return c.json({ error: "missing or malformed tag" }, 400);
    const invalid = validatePayload(parsed, body.payload);
    if (invalid) return c.json({ error: invalid }, 400);

    const resolver = resolvers.get(body.tag as string);
    if (!resolver) return c.json({ error: "no resolver for tag" }, 404);

    const session = SessionManager.findSessionForCompetition(
      parsed.competitionId,
    );
    if (!session) return c.json({ error: "no active session" }, 404);

    // Ownership: a device may only answer for itself.
    //  - perf:*  -> a DJ that belongs to this session
    //  - score:* -> exactly judge<N> for score:...:N
    const sender = c.get("client").sub;
    const owner = parsed.kind === "perf"
      ? parseClientId(sender)?.kind === "dj" && session.clients.has(sender)
      : sender === `judge${parsed.judgeId}`;
    if (!owner) {
      console.warn(`403: ${sender} tried to answer ${body.tag}`);
      return c.json({ error: "not allowed to answer this request" }, 403);
    }

    let payload = body.payload;
    if (parsed.kind === "score") {
      const scores = body.payload as Scores;
      const rejected = session.validateScoreSubmission(
        parsed.competitionId,
        parsed.competitorId,
        parsed.judgeId,
        scores,
      );
      if (rejected) {
        const status = { closed: 404, forbidden: 403, invalid: 400 }[
          rejected.kind
        ] as 404 | 403 | 400;
        return c.json({ error: rejected.message }, status);
      }
      // Stored as NUMERIC(3,1): round to one decimal so what is saved is what
      // the scoreboard shows.
      payload = scores.map((s) => ({
        criteria_id: s.criteria_id,
        score: Math.round(s.score * 10) / 10,
      }));
    }

    resolvers.delete(body.tag as string); // first response wins
    resolver(payload);
    return c.json({ success: true });
  },
);
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

// When run directly, start an HTTP listener to allow real network e2e tests.
if (import.meta.main) {
  (async () => {
    console.log(`Server running on http://localhost:${port}`);
    await Deno.serve({ port }, app.fetch);
  })();
}
