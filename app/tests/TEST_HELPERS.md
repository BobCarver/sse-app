Testing helpers for SSE/session tests

This project includes a set of small test helpers in `app/tests/test-utils.ts`
to make SSE/session tests clearer and less brittle by mirroring the real
connection flow (the global _unassigned_ pool → session delivery) and
centralizing timing logic.

## Key helpers

- `connectAsUnassigned(deps, session, client)` — Add `client` to
  `deps.unassignedClients` and call `session.connectClient(client)`.
- `createMockClient(id)` — Return a minimal mock SSE client whose
  `controller.enqueue` records messages (useful for asserting emitted events).
- `createDependencies()` — Returns default deps: `unassignedClients` (Map),
  `scores` (array), and `saveScore` (async function that pushes to `scores`).
  Override `saveScore` in tests to capture or assert submissions.
- `startSession(session, competitions, permanentClientIds = ['dj0'], waitMs = 50)`
  — Starts `session.runSession(...)`, waits `waitMs` ms for registration, and
  returns the `runSession` promise.
- `delay(ms)` — Simple promise-based sleep helper used by `startSession`.
- `schedulePerf(competitionId, position = 0, delay = 100)` — Schedule a `perf:`
  resolver. After `delay` ms this resolves `perf:<competitionId>:<position>` to
  `true` via `resolveTag`.
- `scheduleScore(competitionId, competitorId, judgeId, payload, delay = 150)` —
  Schedule a `score:` resolver. After `delay` ms this resolves
  `score:<competitionId>:<competitorId>:<judgeId>` with the provided `payload`.

---

## Details & examples

### `connectAsUnassigned(deps, session, client)`

Adds the client to the global unassigned pool and immediately connects it to
`session` so the session logic behaves like a real delivery from the global
pool.

```ts
const client = createMockClient("judge1");
connectAsUnassigned(deps, session, client);
```

### `createMockClient(id)`

Returns an object matching the minimal `SSEClient` interface used in tests:

```ts
const c = createMockClient("dj0");
// c.id
// c.controller.enqueue(msg) -> records to an internal array
```

Use the returned client's `controller.enqueue` to assert emitted messages.

### `createDependencies()`

Returns a deps object ready for use with `Session`:

```ts
const deps = createDependencies();
// deps.unassignedClients: Map<string, SSEClient>
// deps.scores: ScoreSubmission[]
// deps.saveScore: async (submission) => { deps.scores.push(submission) }
```

Override `saveScore` in tests when you need to inspect or assert submissions.

### `startSession(session, competitions, permanentClientIds = ['dj0'], waitMs = 50)`

Starts `runSession` and waits `waitMs` milliseconds to allow clients to be
registered and for the session to reach a stable state before tests continue. It
returns the `runSession` promise so tests can await completion.

```ts
const sessionPromise = await startSession(session, competitions, ["dj0"]);
// schedule events and await sessionPromise
```

### `schedulePerf(competitionId, position = 0, delay = 100)`

Schedules a resolver that will call
`resolveTag(`perf:${competitionId}:${position}`, true)` after `delay` ms. This
is useful to simulate the DJ reporting a performance ready event.

```ts
schedulePerf(10); // resolves 'perf:10:0' to true after 100ms
```

### `scheduleScore(competitionId, competitorId, judgeId, payload, delay = 150)`

Schedules a resolver that will call
`resolveTag(`score:${competitionId}:${competitorId}:${judgeId}`, payload)` after
`delay` ms. The `payload` matches the `Scores` type used by the implementation
(e.g., an object containing `competition_id`, `competitor_id`, `judge_id`, and
`scores`).

```ts
scheduleScore(10, 100, 2, {
  competition_id: 10,
  competitor_id: 100,
  judge_id: 2,
  scores: [{ criteria_id: 1, score: 8.5 }],
});
```

This mirrors the resolver key format used in `app/tests/test-utils.ts`:
`score:<competitionId>:<competitorId>:<judgeId>` and the default delay is 150ms.

---

Use these helpers across tests to reduce duplication and make test intent
explicit and easier to maintain.
