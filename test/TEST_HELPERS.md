Testing helpers for SSE/session tests

This project includes a set of small test helpers in `test/test-utils.ts` to
make SSE/session tests clearer and less brittle by mirroring the real connection
flow (the global _unassigned_ pool -> session delivery) and centralizing timing
logic.

Key helpers:

- `connectAsUnassigned(deps, session, client)` — add `client` to
  `deps.unassignedClients` and call `session.connectClient(client)`.
- `createMockClient(id)` — return a minimal mock SSE client whose
  `controller.enqueue` records messages.
- `createDependencies()` — returns default deps (`unassignedClients`, `scores`,
  `saveScore`). Override `saveScore` in tests to capture submissions.
- `startSession(session, competitions, permanentClientIds?, waitMs?)` — starts
  `runSession` and waits a small period for registration.
- `schedulePerf(competitionId, position?, delay?)` — schedule a `perf:...`
  resolver.
- `scheduleScore(competitionId, position, judgeId, payload, delay?)` — schedule
  a `score:...` resolver.

Example usage:

```ts
import {
  connectAsUnassigned,
  createDependencies,
  createMockClient,
  schedulePerf,
  scheduleScore,
  startSession,
} from "./test-utils.ts";

const deps = createDependencies();
const session = new Session(1, deps);

// Simulate DJ connecting globally and being delivered into the session
const dj = createMockClient("dj0");
connectAsUnassigned(deps, session, dj);

// Start session and schedule events
const sessionPromise = await startSession(session, competitions, ["dj0"]);
schedulePerf(10);
scheduleScore(10, 0, 2, {
  competition_id: 10,
  competitor_id: 100,
  judge_id: 2,
  scores: [{ criteria_id: 1, score: 8.5 }],
});

await sessionPromise;
```

Use these helpers across tests to reduce duplication and make intent explicit.
