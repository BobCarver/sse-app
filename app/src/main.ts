import { Context, Hono } from "@hono/hono";
import { jwt, type JwtVariables, sign } from "@hono/hono/jwt";
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
  getSessionCompetitionsWithRubrics,
  getSessionTrackId,
  saveScore,
} from "./db.ts";

export type JWTPayload = {
  sub: string; // subject representing client (e.g. "dj0" or "judge2")
  exp?: number;
};

export function isJWTPayload(v: unknown): v is JWTPayload {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.sub === "string";
}

type Variables = JwtVariables & JWTPayload;

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
    console.log("REQ", c.req.method, c.req.url);
  } catch (_e) {
    /* ignore logging errors */
  }
  await next();
});

// Basic root for tests
app.get("/", (c: Context<{ Variables: Variables }>) => c.text("Hello Hono"));

// Health/readiness endpoint for e2e harness and external checks
app.get(
  "/_health",
  async (c: Context<{ Variables: Variables }>) => {
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
// MIDDLEWARE
// ============================================================================

// JWT middleware for protected routes
const jwtMiddleware = jwt({
  secret: Deno.env.get("JWT_SECRET") || "your-secret-key",
  alg: "HS256", // Required: specify the JWT algorithm explicitly
  cookie: "session_token", // The name of the cookie containing the JWT
});

// --- /register route ---
// Usage: GET /register?sub=<clientId>
// Returns: { token: "..." } and sets Set-Cookie: session_token=...
app.get("/register", async (c: Context<{ Variables: Variables }>) => {
  const url = new URL(c.req.url);
  const sub = url.searchParams.get("sub");
  if (!sub) {
    return c.json({ error: "missing sub query parameter" }, 400);
  }

  const exp = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour expiry
  const payload: JWTPayload = { sub, exp };
  const secret = Deno.env.get("JWT_SECRET") || "your-secret-key";
  const token = await sign(payload as Record<string, unknown>, secret, "HS256");

  const maxAge = 60 * 60; // 1 hour
  const cookie = `session_token=${
    encodeURIComponent(token)
  }; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`;

  return new Response(JSON.stringify({ token }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": cookie,
    },
  });
});

// ============================================================================
// SSE ENDPOINT
// ============================================================================

// Store of unassigned clients (connected but not yet assigned to a session)
const unassignedClients: Map<string, SSEClient> = new Map();

// SSE connection (production - expects JWT with sub)
app.get("/events", jwtMiddleware, (c) => {
  const { sub } = c.get("jwtPayload") as JWTPayload;
  // Parse subject: expected format like 'dj0', 'judge2', 'sb3'
  const re = (sub || "").match(/^(?<type>(dj|judge|sb))(\d*)$/);
  if (!re) {
    return c.json({ error: " Invalid'sub' claim" }, 400);
  }
  const clientId = sub;
  const clientType = re.groups?.type as "dj" | "judge" | "sb";

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
  // public for tests; in prod you may want to protect this route
  async (c: Context<{ Variables: Variables }>) => {
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
  jwtMiddleware,
  async (c: Context<{ Variables: Variables }>) => {
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

    let payload = body.payload;
    if (parsed.kind === "score") {
      const session = SessionManager.findSessionForCompetition(
        parsed.competitionId,
      );
      if (!session) return c.json({ error: "no active session" }, 404);
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

    // TODO(phase 5): verify the JWT sub is allowed to resolve this tag
    resolvers.delete(body.tag as string); // first response wins
    resolver(payload);
    return c.json({ success: true });
  },
);
// ============================================================================
// CLEANUP
// ============================================================================

// Graceful shutdown
Deno.addSignalListener("SIGINT", () => {
  console.log("Shutting down...");
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", () => {
  console.log("Shutting down...");
  Deno.exit(0);
});

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
