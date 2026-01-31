# Dance Festival Competition System

This document describes the actual architecture and runtime behavior of the
Dance Festival Competition System (server + role-based frontends) and clarifies
how the implementation currently works. It highlights message shapes, APIs,
startup/seed flows, and gaps between the design notes and the running app.

---

## Key points (short)

- Transport: **SSE (server → client)** and **HTTP POST (client → server)** are
  used; WebSocket is not used by the server as implemented.
- Authentication: endpoints and SSE connections are protected by **JWT**. Tokens
  must include at least: `id` (numeric), and `type` ("dj" | "judge" | "sb")
- Persistence: PostgreSQL is used when `DATABASE_URL` is set; otherwise DB
  operations are no-ops and tests can use the in-memory seed endpoint.

---

## Message and API reference (actual behavior)

- **SSE (Server → Clients)**
  - `client_status` — payload:
    `{ event: "client_status", connected_clients: number[] }`
    - `connected_clients` is a list of numeric client IDs currently connected.
  - `competition_start` — payload: `{ event: "competition_start", competition:
    Competition }
    - Full competition object is broadcast to clients.
  - `performance_start` — payload:
    `{ event: "performance_start", position: number }`
    - `position` is the ordinal index of the competitor in the competition.
  - `enable_scoring` — payload: `{ event: "enable_scoring" }`
  - `score_update` — payload: score update object (broadcast to scoreboards)

  - `ping` — heartbeat payload: `{ event: "ping" }`

- **HTTP (Client → Server)**
  - `POST /performance-complete` — body: `{ played: boolean }` (JWT used for
    session/identity)
  - `POST /session/:sessionId/:competitionId/:competitorId` — body: an array of
    `{ criteria_id, score }`. The server constructs the full score submission
    using the path params and the authenticated `judge_id` from the JWT; it
    resolves the judge scoring promise and (if DB enabled) saves the scores.
  - `POST /session/:sessionId/start` — starts a session asynchronously (server
    queries DB / uses in-memory seed and runs session)
  - `POST /_test/session/:sessionId/seed` — **test-only**; seeds a session
    in-memory (used by harness when no DB available)
  - `GET /_health` — health/readiness probe

- **JWT requirements**
  - Tokens must include numeric `id`, `type` ("dj", "judge", "sb")
  - Server reads `jwtPayload` from middleware to identify client and session.

---

## Data & persistence notes

- The app uses `src/db.ts` to query competitions and save scores. If
  `DATABASE_URL` is unset, DB client is not created and `saveScore` is a no-op
  (no persistence).
- For reproducible e2e tests you can seed the DB using `test/seed_db.sql` or by
  calling `seedDbSession(sessionId)` from `test/test-helpers.ts` (requires
  `DATABASE_URL`). There is also a `tools/init-test-db.sh` script and a `deno`
  task (`init-test-db`) that create the DB (if needed) and apply schema + seed.

---

## Differences from prior design notes / TODOs

- `score_submit` transport: The original design suggested submitting scores over
  SSE; current implementation accepts scores via **HTTP POST
  `/session/:sessionId/:competitionId/:competitorId`** (body: array of criteria
  scores). (If desired, SSE-based judge → server submissions can be
  implemented.)

- **Server-side validation is incomplete**: the server does not currently
  validate that a judge is allowed to score a particular `criteria_id` for a
  competition. Recommend adding validation in
  `/session/:sessionId/:competitionId/:competitorId`.

- **No server-enforced judge timeout**: the design mentions a 30s judge timeout
  — currently `scorePhase` waits indefinitely for judge submissions. Consider
  adding a configurable timeout or a default fallback behavior.

- **DJ start/skip & audio playback**: the document mentions start/skip and audio
  playback; the server currently emits `performance_start` and expects the DJ to
  call `POST /performance-complete`. Server-side audio orchestration is not
  implemented.

- **ClientStatus shape**: design notes had a richer `client_status` with
  separate dj/judges/scoreboards fields; code uses a simple array of connected
  client IDs.

- **Message shapes**: update docs to match the schema in `src/protocol.ts` and
  the score update payload definitions in `src/types.ts`.

---

## Testing & CI notes

- Unit/integration tests live under `test/` and include an in-process
  `integration_test.ts` that exercises `SessionState` without a network.

---

## Recommended immediate actions

1. Add server-side score validation and return 400 for invalid submissions.
2. Optionally add a configurable judge timeout in `scorePhase`.
3. Keep `/_test/session/:id/seed` for harness convenience, but prefer DB seeding
   in CI for more realistic tests.
4. Update any external docs or frontends to use the actual endpoints and JSON
   shapes described above.

---

If you'd like, I can prepare a PR that:

- updates `test/system.md` and the .vscode copy to the corrected text above,
- adds server-side validation tests for `/submit-score`, and
- implements a configurable judge timeout. Which would you like first? (docs,
  validation, or timeout)
