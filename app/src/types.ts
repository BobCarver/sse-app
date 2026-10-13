export type CompetitorId = number;
export type CompetitionId = number;
export type JudgeId = number;
export type CriteriaId = number;
export type RubricId = number;

export type Competitor = {
  id: CompetitorId;
  name: string;
  /** Length of the performance in seconds (competition_competitors.duration). */
  duration: number;
};
export type Competitors = Competitor[];

export type Rubric = {
  id: RubricId;
  // criteria now include optional weight from rubric_criteria table
  criteria: { id: CriteriaId; name: string; weight?: number }[];
  judges: { id: JudgeId; name: string; criteria: CriteriaId[] }[];
};

export type Competition = {
  competitors: Competitor[];
  rubric: Rubric;
  id: CompetitionId;
  name: string;
};

export type Scores = Array<{ criteria_id: number; score: number }>;

// ClientType describes the kind of SSE client (DJ, judge, scoreboard)
export type ClientType = "dj" | "judge" | "sb";

export type ScoreSubmission = {
  competition_id: number;
  competitor_id: number;
  judge_id: number; // the numeric part of JudgeId
  scores: Scores;
};

/** The competitor after the current one in running order (null = none left). */
export type NextEntry = { competitionId: number; competitorId: number } | null;

/**
 * Session progress, persisted so the database shows where a session is (the
 * track's cursor, see db.ts) and what happened (skips, missing scores).
 */
export type ProgressEvent =
  | { kind: "session_started"; resume?: boolean }
  | { kind: "competition_started"; competitionId: number }
  | {
    /** The cursor moves to this competitor; its performance begins. */
    kind: "competitor_started";
    competitionId: number;
    competitorId: number;
  }
  | {
    /** The performance is over: the cursor's phase becomes scoring. */
    kind: "competitor_performed";
    competitionId: number;
    competitorId: number;
  }
  | {
    /** Skipped (recorded as a skip); the cursor moves on to `next`. */
    kind: "competitor_skipped";
    competitionId: number;
    competitorId: number;
    stage: "performance" | "scoring";
    actor: "dj" | "operator";
    reason?: string;
    next: NextEntry;
  }
  | {
    /** Scoring closed normally: the competitor is done; the cursor moves on. */
    kind: "competitor_finalized";
    competitionId: number;
    competitorId: number;
    next: NextEntry;
  }
  | {
    /** A judge's score never arrived (audit record). */
    kind: "score_missing";
    competitionId: number;
    competitorId: number;
    judgeId: number;
    reason: "timeout" | "closed" | "absent";
  }
  | {
    /** An operator hold was put on or lifted (it survives a restart). */
    kind: "held";
    held: boolean;
  }
  | {
    kind: "session_ended";
    reason: "completed" | "aborted" | "cancelled" | "error";
    /**
     * Nothing ran in this session (no performance began, nothing was
     * finished): an abort gives the track back instead of keeping it.
     */
    untouched?: boolean;
  };

interface EnqueueController {
  enqueue(chunk: string): void;
}

export interface SSEClient {
  id: string;
  controller: EnqueueController;
}
