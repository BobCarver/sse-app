import type { Competition, ScoreSubmission } from "./types.ts";
import type { Cursor } from "./progress.ts";

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
  /** The session ended normally (it is not run again). */
  finished: boolean;
  /** Cancelled by the operator (never run again). */
  cancelled?: boolean;
  /** Its first competition began at some point. */
  started?: boolean;
  /** An operator hold is on. */
  held?: boolean;
  /** The session holds its track: it was started and has not finished. */
  open: boolean;
  /** Where it is (open sessions only); null = every competitor is done. */
  cursor: Cursor | null;
  /** Saved scores of the competitor at the cursor. */
  cursorScores: SavedScore[];
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
  /** A competition already under way (its DJ start button is not shown again). */
  underway?: number;
};

export const NO_RESUME: ResumePlan = { finished: new Set() };

export const finishedKey = (competitionId: number, competitorId: number) =>
  `${competitionId}:${competitorId}`;

/**
 * "start" resumes at the cursor. Everything before it in running order is
 * finished and never revisited. At the cursor:
 *  - `scoring`: the performance happened but scoring was cut off, so only
 *    scoring is re-opened (judges with saved scores keep them);
 *  - `performing` or not begun: it is run from its performance.
 * No cursor in an open session: every competitor is done (only the end of the
 * session is left). A session that is not open starts from the top.
 */
export function planResume(
  competitions: Competition[],
  rows: ResumeRows | undefined,
): ResumePlan {
  if (!rows?.open) return NO_RESUME;
  const finished = new Set<string>();
  const cursor = rows.cursor;
  for (const comp of competitions) {
    for (const competitor of comp.competitors) {
      const key = finishedKey(comp.id, competitor.id);
      if (
        !cursor || cursor.competitionId !== comp.id ||
        cursor.competitorId !== competitor.id
      ) {
        finished.add(key);
        continue;
      }
      const underway = cursor.phase ? comp.id : undefined;
      if (cursor.phase !== "scoring") return { finished, underway };
      const byJudge = new Map<number, ScoreSubmission>();
      for (const r of rows.cursorScores) {
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
        underway,
        reopen: {
          competitionId: comp.id,
          competitorId: competitor.id,
          scores: [...byJudge.values()],
        },
      };
    }
  }
  if (cursor) {
    throw new Error(
      `the cursor (competition ${cursor.competitionId}, competitor ${cursor.competitorId}) is not in this session`,
    );
  }
  return { finished };
}

/** The competitor after (competitionId, position) in running order, if any. */
export function nextInOrder(
  competitions: Competition[],
  competitionId: number,
  position: number,
): { competitionId: number; competitorId: number } | null {
  let found = false;
  for (const comp of competitions) {
    for (const [i, competitor] of comp.competitors.entries()) {
      if (found) return { competitionId: comp.id, competitorId: competitor.id };
      if (comp.id === competitionId && i === position) found = true;
    }
  }
  return null;
}
