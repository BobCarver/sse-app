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

/** Session progress, persisted so the database shows where a session is. */
export type ProgressEvent =
  | { kind: "session_started" }
  | { kind: "competition_started"; competitionId: number }
  | {
    kind: "competitor_started";
    competitionId: number;
    competitorId: number;
  }
  | {
    kind: "competitor_performed";
    competitionId: number;
    competitorId: number;
  }
  | { kind: "competitor_skipped"; competitionId: number; competitorId: number }
  | { kind: "competition_completed"; competitionId: number }
  | { kind: "session_ended"; reason: "completed" | "aborted" | "error" };

interface EnqueueController {
  enqueue(chunk: string): void;
}

export interface SSEClient {
  id: string;
  controller: EnqueueController;
}
