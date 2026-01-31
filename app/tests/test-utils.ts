/*
 * Test utilities for simulating SSE behavior and common session test patterns.
 */

import { resolveTag } from "../../src/resolveTag.ts";
import type { Competition, Scores, ScoreSubmission } from "../../src/types.ts";

export function connectAsUnassigned(deps: any, session: any, client: any) {
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
  } as any;
}

export function createDependencies() {
  const deps: any = {
    unassignedClients: new Map<string, any>(),
    scores: [] as any[],
    saveScore: async (submission: ScoreSubmission) => {
      deps.scores.push(submission);
    },
  } as any;

  return deps;
}

export function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function startSession(
  session: any,
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
