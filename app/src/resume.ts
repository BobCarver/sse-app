import type { Competition } from "./types.ts";

/** What the database knows about how far a session got before it stopped. */
export type ResumeRows = {
  sessionStatus: string;
  competitors: {
    competition_id: number;
    competitor_id: number;
    status: string;
  }[];
  /** Competitors that have at least one saved score. */
  scored: { competition_id: number; competitor_id: number }[];
};

export const finishedKey = (competitionId: number, competitorId: number) =>
  `${competitionId}:${competitorId}`;

/**
 * Competitors a restarted session does not run again.
 *
 * "start" resumes where the session left off: a competitor is finished if it was
 * skipped, or performed and at least one judge's score was saved. A performance
 * with no score at all (the server died while judges were scoring) is done again;
 * a judge who had not scored by then counts as missing, as after a timeout.
 * A completed session starts from scratch, so nothing is finished.
 */
export function finishedCompetitors(
  competitions: Competition[],
  rows: ResumeRows | undefined,
): Set<string> {
  const finished = new Set<string>();
  if (!rows || rows.sessionStatus === "completed") return finished;
  const inSession = new Set(
    competitions.flatMap((c) =>
      c.competitors.map((p) => finishedKey(c.id, p.id))
    ),
  );
  const scored = new Set(
    rows.scored.map((s) => finishedKey(s.competition_id, s.competitor_id)),
  );
  for (const r of rows.competitors) {
    const key = finishedKey(r.competition_id, r.competitor_id);
    if (!inSession.has(key)) continue;
    if (
      r.status === "skipped" || (r.status === "performed" && scored.has(key))
    ) {
      finished.add(key);
    }
  }
  return finished;
}
