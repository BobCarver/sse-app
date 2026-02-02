import { Context, Hono } from "hono";
import { jwt, type JwtVariables, sign } from "hono/jwt";
import { streamSSE } from "hono/streaming";
//import { serveStatic } from "hono/serve-static";

// ============================================================================
// TYPES
// ============================================================================

import { ScoreSubmission, SSEClient } from "./types.ts";
import { resolvers } from "./resolveTag.ts";
import { handleSSEConnection } from "./sse.ts";
import { SessionManager } from "./sessionManager.ts";
import { getSessionCompetitionsWithRubrics } from "./db.ts";

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
      return c.json({ ok: false, error: String(err) }, 500);
    }
  },
);

// ============================================================================
// MIDDLEWARE
// ============================================================================

// JWT middleware for protected routes
const jwtMiddleware = jwt({
  secret: Deno.env.get("JWT_SECRET") || "your-secret-key",
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
  const token = await sign(payload as Record<string, unknown>, secret);

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
// STATIC FILE ROUTES
// ============================================================================

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

// Start a session - queries DB, builds session, and runs it
app.post(
  "/sessions/:sessionId/start",
  // public for tests; in prod you may want to protect this route
  async (c: Context<{ Variables: Variables }>) => {
    const sessionId = Number(c.req.param("sessionId"));

    // Fetch competitions from DB
    let competitions = [];
    try {
      // DB uses numeric sessionId
      competitions = await getSessionCompetitionsWithRubrics(sessionId);
    } catch (_err) {
      return c.json({ error: "No competitions found for session" }, 400);
    }

    if (!competitions || competitions.length === 0) {
      return c.json({
        error: `No competitions provided for session ${sessionId}`,
      }, 400);
    }

    let session;
    try {
      session = SessionManager.createSession(sessionId, {
        unassignedClients,
        saveScore: async (scoreData: ScoreSubmission) => {
          // Implement score saving logic here, e.g., insert into DB
          dlog("Saving score data:", scoreData);
        },
      });
    } catch (err) {
      // If session already exists, try to recover if it's stale (not running)
      const msg = String(err);
      console.warn(`createSession error for ${sessionId}:`, msg);
      const existing = SessionManager.getSession(sessionId);
      if (existing && existing.isRunning()) {
        // Already running: idempotent start
        return c.json({
          success: true,
          message: "Session already running",
          sessionId,
        });
      }

      if (existing && !existing.isRunning()) {
        // Stale session detected: delete and retry creating session
        console.warn(
          `Session ${sessionId} exists but not running; deleting stale session and retrying start`,
        );
        SessionManager.deleteSession(sessionId);
        try {
          session = SessionManager.createSession(sessionId, {
            unassignedClients,
            saveScore: async (scoreData: ScoreSubmission) => {
              dlog("Saving score data:", scoreData);
            },
          });
        } catch (err2) {
          console.error(
            `Retry createSession failed for ${sessionId}:`,
            String(err2),
          );
          return c.json({ error: String(err2) }, 500);
        }
      } else {
        // No existing session info, surface original error
        return c.json({ error: msg }, 500);
      }
    }

    if (session === undefined) {
      return c.json({ error: "Invalid session ID" }, 400);
    }

    // Check if session is already running
    if (session.isRunning()) {
      return c.json({ error: "Session already running" }, 409);
    }

    try {
      // Run session asynchronously (don't wait for completion)
      session.runSession(competitions).catch((error: unknown) => {
        console.error(`Session ${sessionId} error:`, error);
        SessionManager.deleteSession(sessionId);
      }).finally(() => {
        // Ensure the session is removed from the manager when it finishes (success or error)
        SessionManager.deleteSession(sessionId);
        console.log(`Session ${sessionId} completed`);
      });

      return c.json({
        success: true,
        message: "Session started",
        sessionId,
      });
    } catch (error) {
      console.error("Failed to start session:", error);
      return c.json({
        error: error instanceof Error
          ? error.message
          : "Failed to start session",
      }, 500);
    }
  },
);

// Consolidated tag-based responder endpoint: { tag: string, payload?: any }
app.post(
  "/response",
  jwtMiddleware,
  async (c: Context<{ Variables: Variables }>) => {
    const { tag, payload } = await c.req.json();
    resolvers.get(tag)?.(payload);
    if (!tag) return c.json({ error: "missing tag" }, 400);
    if (!resolvers.has(tag)) {
      return c.json({ error: "no resolver for tag" }, 404);
    }
    // perhaps do some validation ?????
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
