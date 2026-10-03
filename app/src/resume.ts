import type { Competition, ScoreSubmission } from "./types.ts";

/** One saved score row (a judge's score for one criterion). */
export type SavedScore = {
  competition_id: number;
  competitor_id: number;
  judge_id: number;
  criteria_id: number;
  score: number;
};

/** What the database knows about how far a session got before it stopped. */
export type ResumeRows = {
  sessionStatus: string;
  competitors: {
    competition_id: number;
    competitor_id: number;
    status: string;
  }[];
  /** Saved scores of competitors that are `performed` (not yet finalized). */
  performedScores: SavedScore[];
};

/** Where a restarted session picks up. */
export type ResumePlan = {
  /** "competitionId:competitorId" keys that are not run again. */
  finished: ReadonlySet<string>;
  /** The competitor that was performed but not finalized: scoring is re-opened. */
  reopen?: {
    competitionId: number;
    competitorId: number;
    /** Scores judges had already saved (those judges are not asked again). */
    scores: ScoreSubmission[];
  };
};

export const NO_RESUME: ResumePlan = { finished: new Set() };

export const finishedKey = (competitionId: number, competitorId: number) =>
  `${competitionId}:${competitorId}`;

/**
 * "start" resumes where the session left off. Competitors are taken in running
 * order; every `finalized` or `skipped` one at the front is finished and never
 * revisited. The first one that is not:
 *  - `performed`: the performance happened but scoring was cut off, so only
 *    scoring is re-opened (judges with saved scores keep them);
 *  - anything else: it is run from its performance.
 * A completed session starts from scratch.
 */
export function planResume(
  competitions: Competition[],
  rows: ResumeRows | undefined,
): ResumePlan {
  if (!rows || rows.sessionStatus === "completed") return NO_RESUME;
  const status = new Map(
    rows.competitors.map((
      r,
    ) => [finishedKey(r.competition_id, r.competitor_id), r.status]),
  );
  const finished = new Set<string>();
  for (const comp of competitions) {
    for (const competitor of comp.competitors) {
      const key = finishedKey(comp.id, competitor.id);
      const s = status.get(key);
      if (s === "finalized" || s === "skipped") {
        finished.add(key);
        continue;
      }
      if (s !== "performed") return { finished };
      const byJudge = new Map<number, ScoreSubmission>();
      for (const r of rows.performedScores) {
        if (r.competition_id !== comp.id || r.competitor_id !== competitor.id) {
          continue;
        }
        const sub = byJudge.get(r.judge_id) ?? {
          competition_id: comp.id,
          competitor_id: competitor.id,
          judge_id: r.judge_id,
          scores: [],
        };
        sub.scores.push({ criteria_id: r.criteria_id, score: r.score });
        byJudge.set(r.judge_id, sub);
      }
      return {
        finished,
        reopen: {
          competitionId: comp.id,
          competitorId: competitor.id,
          scores: [...byJudge.values()],
        },
      };
    }
  }
  return { finished };
}
