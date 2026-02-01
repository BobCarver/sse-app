/*
 * Test utilities for simulating SSE behavior and common session test patterns.
 */
// deno-lint-ignore-file require-await

import { resolveTag } from "../src/resolveTag.ts";
import { Session } from "../src/session.ts";
import type {
  Competition,
  Scores,
  ScoreSubmission,
  SSEClient,
} from "../src/types.ts";

export function connectAsUnassigned(
// deno-lint-ignore no-explicit-any
  deps: any,
  session: Session,
  client: SSEClient,
) {
  deps.unassignedClients.set(client.id, client);
  session.connectClient(client);
}

export function createMockClient(id: string) {
  const messages: string[] = [];
  return {
    id,
    controller: {
      enqueue: (msg: string) => {
        messages.push(msg);
      },
    },
    // Expose captured messages for tests
    __messages: messages,
  } as unknown as SSEClient & { __messages: string[] };
}

export function createDependencies() {
  const deps = {
    unassignedClients: new Map<string, SSEClient>(),
    scores: [] as ScoreSubmission[],
    saveScore: async (submission: ScoreSubmission) => {
      deps.scores.push(submission);
    },
  };

  return deps;
}

export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

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

export function schedulePerf(competitionId: number, position = 0, delay = 100) {
  setTimeout(() => {
    resolveTag(`perf:${competitionId}:${position}`, true);
  }, delay);
}

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
