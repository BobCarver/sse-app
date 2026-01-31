/**
 * Test utilities for simulating SSE behavior and common session test patterns.
 *
 * Rationale:
 * - Tests should mirror the real server flow: clients first appear in a global unassigned pool,
 *   and then are assigned/delivered to sessions. These helpers encapsulate that flow so tests
 *   are less brittle and easier to read.
 * - Scheduling helpers (`schedulePerf`, `scheduleScore`) centralize timing logic for performance
 *   completions and score submissions, avoiding duplicated `setTimeout` code across tests.
 *
 * Usage examples:
 *   import { connectAsUnassigned, createMockClient, createDependencies, startSession, schedulePerf, scheduleScore } from "./test-utils.ts";
 *
 *   const deps = createDependencies();
 *   const session = new Session(1, deps);
 *   const dj = createMockClient("dj0");
 *   connectAsUnassigned(deps, session, dj);
 *   const promise = startSession(session, competitions, ["dj0"]);
 *   schedulePerf(10, 0);
 *   scheduleScore(10, 0, 2, { competition_id: 10, competitor_id: 100, judge_id: 2, scores: [...] });
 */

import { resolveTag } from "../src/resolveTag.ts";
import { Session } from "../src/session.ts";
import type { Competition, Scores, ScoreSubmission } from "../src/types.ts";

/**
 * Simulate the global SSE handler delivering a client into the system.
 *
 * Steps performed:
 * 1. Place `client` into `deps.unassignedClients` to simulate a global connection.
 * 2. Call `session.connectClient(client)` to let the session pick up the connection
 *    if it has a pre-registered slot for the client.
 *
 * Rationale: Tests should reflect the real connection flow (global pool -> session). Using
 * this helper avoids order/timing issues where tests add clients before sessions register slots.
 *
 * Example:
 *   connectAsUnassigned(deps, session, createMockClient("judge2"));
 */
export function connectAsUnassigned(deps: any, session: Session, client: any) {
  deps.unassignedClients.set(client.id, client);
  session.connectClient(client);
}

/**
 * Create a minimal mock SSE client.
 *
 * The returned object mimics an `SSEClient` with a `controller.enqueue` that
 * records any messages sent to it. Tests can inspect the produced messages array
 * (if needed) by reading the `messages` variable scoped to the test or by
 * extending this helper to expose them.
 *
 * Example:
 *   const client = createMockClient("dj0");
 *   // client.controller.enqueue will collect messages silently in tests
 */
export function createMockClient(id: string) {
  const messages: string[] = [];
  return {
    id,
    controller: {
      enqueue: (msg: string) => {
        messages.push(msg);
      },
    },
  } as any;
}

/**
 * Create default dependencies for a session used in tests.
 *
 * - `unassignedClients` is a fresh Map to simulate the global client pool.
 * - `scores` is an array tests can inspect (tests may override `saveScore` to push into `scores`).
 * - `saveScore` is a noop by default; tests that want to capture submissions should replace
 *   `deps.saveScore` with an async function that collects the passed submissions.
 *
 * Example:
 *   const deps = createDependencies();
 *   deps.saveScore = async (sub) => { deps.scores.push(sub); };
 */
export function createDependencies() {
  // Provide a deps object where `saveScore` records submissions into `scores` by default.
  // Tests that need custom behavior can still override `deps.saveScore` as needed.
  const deps: any = {
    // deno-lint-ignore no-explicit-any
    unassignedClients: new Map<string, any>(),
    // deno-lint-ignore no-explicit-any
    scores: [] as any[],
    saveScore: async (submission: ScoreSubmission) => {
      deps.scores.push(submission);
    },
  } as any;

  return deps;
}

/**
 * Delay helper: awaitable sleep used by tests instead of raw setTimeout callbacks.
 *
 * Example:
 *   await delay(50);
 *   delay(10).then(() => session.connectClient(mockClient));
 */
export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start `session.runSession(...)` and wait a short period to allow the session to
 * register permanent client slots and do initial setup.
 *
 * Returns the `sessionPromise` (the result of `runSession`) so callers can await
 * completion later in the test while performing other actions in the meantime.
 *
 * Example:
 *   const sessionPromise = await startSession(session, competitions, ["dj0"]);
 *   // do other actions, then await sessionPromise when ready
 */
export async function startSession(
  session: Session,
  competitions: Competition[],
  permanentClientIds: string[] = ["dj0"],
  waitMs = 50,
) {
  const sessionPromise = session.runSession(competitions, permanentClientIds);
  await delay(waitMs);
  return sessionPromise;
}

/**
 * Schedule a performance completion event by resolving the `perf:competition:position` tag
 * after `delay` milliseconds. This avoids repeating `setTimeout(resolveTag(...))` blocks
 * in tests and centralizes timing behavior.
 */
export function schedulePerf(competitionId: number, position = 0, delay = 100) {
  setTimeout(() => {
    resolveTag(`perf:${competitionId}:${position}`, true);
  }, delay);
}

/**
 * Schedule a judge score submission by resolving the `score:competition:position:judgeId` tag
 * with `payload` after `delay` milliseconds.
 */
export function scheduleScore(
  competitionId: number,
  competitorId: number,
  judgeId: number,
  payload: Scores,
  delay = 150,
) {
  setTimeout(() => {
    resolveTag(`score:${competitionId}:${competitorId}:${judgeId}`, payload);
  }, delay);
}
