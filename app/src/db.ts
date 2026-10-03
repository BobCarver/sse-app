// db.ts
import postgres from "postgres";
import type {
  AudioMetadataStore,
  AudioRecord,
  AudioRef,
} from "./audioLibrary.ts";
import type { OverviewRows } from "./adminOverview.ts";
import type { ResumeRows } from "./resume.ts";
import {
  Competition,
  Competitor,
  ProgressEvent,
  Rubric,
  ScoreSubmission,
} from "./types.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL") || "";

/** Hide the password in a connection URL before logging it. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "<unparseable DATABASE_URL>";
  }
}

export const sql = DATABASE_URL ? postgres(DATABASE_URL) : undefined;
if (!sql) {
  console.warn(
    "DB not configured - DATABASE_URL not set; running in memory/disabled DB mode",
  );
} else {
  console.log("DB configured, connecting to", redactUrl(DATABASE_URL));
}

export const db = {
  /**
   * Insert a judge's scores for one competitor. Idempotent: re-saving the same
   * (competition, judge, competitor, criteria) updates the score, so retries and
   * re-runs never fail on the unique constraint. All rows go in one statement.
   */
  async saveScore({ scores, ...rest }: ScoreSubmission): Promise<void> {
    if (!sql || scores.length === 0) return;
    const values = scores.map((s) => ({ ...rest, ...s }));
    await sql`
      INSERT INTO scores ${sql(values)}
      ON CONFLICT (competition_id, judge_id, competitor_id, criteria_id)
      DO UPDATE SET score = EXCLUDED.score, created_at = NOW()`;
  },
};

export const saveScore = (rec: ScoreSubmission): Promise<void> =>
  db.saveScore(rec);

export async function getSessionCompetitionsWithRubrics(
  sessionId: number,
): Promise<Competition[]> {
  if (!sql) return [];

  // Get all competitions with competitors
  type CompetitionRow = {
    id: number;
    name: string;
    rubric_id: number;
    competitors: Competitor[];
  };

  console.log(
    `getSessionCompetitionsWithRubrics: sessionId=${sessionId} sqlDefined=${!!sql}`,
  );
  const competitions = await sql<CompetitionRow[]>`
    SELECT comp.id, comp.name, comp.rubric_id,
      json_agg(
        json_build_object('id', c.id, 'name', c.name, 'duration', cc.duration)
        ORDER BY cc.order_number
      ) AS competitors
    FROM competitions comp
    LEFT JOIN competition_competitors cc ON cc.competition_id = comp.id
    LEFT JOIN competitors c ON c.id = cc.competitor_id
    WHERE comp.session_id = ${sessionId}
    GROUP BY comp.id
    HAVING COUNT(cc.competitor_id) > 0
    ORDER BY comp.order_number;
`;

  console.log(
    `getSessionCompetitionsWithRubrics: sessionId=${sessionId} => competitions=${competitions.length}`,
  );
  if (competitions.length === 0) return [];

  // Extract unique rubric IDs
  const rubricIds = [
    ...new Set(competitions.map((c: CompetitionRow) => c.rubric_id)),
  ];

  // Get rubric definition

  const rubrics = await sql<Rubric[]>`
    SELECT r.id,
      ( SELECT COALESCE(json_agg( json_build_object( 'id', cr.id, 'name', cr.name, 'weight', rc.weight)), '[]'::json)
        FROM rubric_criteria rc
        JOIN criteria cr ON rc.criteria_id = cr.id
        WHERE rc.rubric_id = r.id
      ) AS criteria,
      ( SELECT COALESCE(json_agg(
          json_build_object( 'id', j.id, 'name', u.name, 'criteria', (
              SELECT COALESCE(array_agg(rjc.criteria_id ORDER BY rjc.criteria_id), ARRAY[]::int[])
              FROM rubric_judge_criteria rjc
              WHERE rjc.rubric_id = r.id AND rjc.judge_id = j.id
            )
          )
        ), '[]'::json)
        FROM rubric_judges rj
        JOIN judges j ON rj.judge_id = j.id
        JOIN users u ON j.user_id = u.id
        WHERE rj.rubric_id = r.id
      ) AS judges
    FROM rubrics r
    WHERE r.id IN ${sql(rubricIds)}
  `;

  // Create rubric lookup map
  const rubricMap = new Map<number, Rubric>(
    rubrics.map((r: Rubric) => [r.id, r]),
  );
  // Post-process: add rubrics to competitions and format to match TypeScript types
  return competitions.map((row: CompetitionRow) => ({
    ...row,
    rubric: rubricMap.get(row.rubric_id)!,
  }));
}

/** Track a session runs on, or undefined if the session doesn't exist. */
export async function getSessionTrackId(
  sessionId: number,
): Promise<number | undefined> {
  if (!sql) return undefined;
  const rows = await sql<{ track_id: number }[]>`
    SELECT track_id FROM sessions WHERE id = ${sessionId}`;
  return rows[0]?.track_id;
}

// --- client credentials (admin-issued links) --------------------------------

export type CredentialRow = {
  id: number;
  clientId: string;
  secretHash: string;
  label: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

export const credentialStore = sql
  ? {
    async insert(
      c: { clientId: string; secretHash: string; label?: string },
    ): Promise<{ id: number; createdAt: Date }> {
      const [row] = await sql<{ id: number; created_at: Date }[]>`
        INSERT INTO client_credentials (client_id, secret_hash, label)
        VALUES (${c.clientId}, ${c.secretHash}, ${c.label ?? null})
        RETURNING id, created_at`;
      return { id: row.id, createdAt: row.created_at };
    },
    async revoke(id: number): Promise<boolean> {
      const rows = await sql`
        UPDATE client_credentials SET revoked_at = NOW()
        WHERE id = ${id} AND revoked_at IS NULL RETURNING id`;
      return rows.length > 0;
    },
    async loadAll(): Promise<CredentialRow[]> {
      type Raw = {
        id: number;
        client_id: string;
        secret_hash: string;
        label: string | null;
        created_at: Date;
        revoked_at: Date | null;
      };
      const rows = await sql<
        Raw[]
      >`SELECT * FROM client_credentials ORDER BY id`;
      return rows.map((r: Raw) => ({
        id: r.id,
        clientId: r.client_id,
        secretHash: r.secret_hash,
        label: r.label,
        createdAt: r.created_at,
        revokedAt: r.revoked_at,
      }));
    },
  }
  : undefined;

/**
 * Keep sessions.status, competitions.status and the current_* pointers true.
 * An aborted or failed session goes back to 'upcoming' so it can be started again.
 */
export async function recordProgress(
  sessionId: number,
  event: ProgressEvent,
): Promise<void> {
  if (!sql) return;
  switch (event.kind) {
    case "session_started":
      await sql`UPDATE sessions SET status = 'active' WHERE id = ${sessionId}`;
      // A fresh run forgets earlier outcomes; a resumed one keeps them.
      if (!event.resume) {
        await sql`UPDATE competition_competitors SET status = 'upcoming'
          WHERE competition_id IN
            (SELECT id FROM competitions WHERE session_id = ${sessionId})`;
      }
      await sql`UPDATE tracks SET current_session = ${sessionId}
        WHERE id = (SELECT track_id FROM sessions WHERE id = ${sessionId})`;
      break;
    case "competition_started":
      await sql`UPDATE competitions SET status = 'active'
        WHERE id = ${event.competitionId}`;
      await sql`UPDATE sessions
        SET current_competition = ${event.competitionId}, current_competitor = NULL
        WHERE id = ${sessionId}`;
      break;
    case "competitor_started":
      await sql`UPDATE sessions SET current_competitor = ${event.competitorId}
        WHERE id = ${sessionId}`;
      break;
    case "competitor_performed":
    case "competitor_skipped":
      await sql`UPDATE competition_competitors
        SET status = ${
        event.kind === "competitor_skipped" ? "skipped" : "performed"
      }
        WHERE competition_id = ${event.competitionId}
          AND competitor_id = ${event.competitorId}`;
      break;
    case "competition_completed":
      await sql`UPDATE competitions SET status = 'completed'
        WHERE id = ${event.competitionId}`;
      break;
    case "session_ended":
      await sql`UPDATE sessions
        SET status = ${event.reason === "completed" ? "completed" : "upcoming"},
            current_competition = NULL, current_competitor = NULL
        WHERE id = ${sessionId}`;
      await sql`UPDATE tracks SET current_session = NULL
        WHERE current_session = ${sessionId}`;
      break;
  }
}

/** How far the session got, for resuming it after a stop or a server restart. */
export async function getResumeRows(
  sessionId: number,
): Promise<ResumeRows | undefined> {
  if (!sql) return undefined;
  const [session] = await sql<{ status: string }[]>`
    SELECT status FROM sessions WHERE id = ${sessionId}`;
  if (!session) return undefined;
  const competitors = await sql<ResumeRows["competitors"]>`
    SELECT cc.competition_id, cc.competitor_id, cc.status
    FROM competition_competitors cc
    JOIN competitions c ON c.id = cc.competition_id
    WHERE c.session_id = ${sessionId}`;
  const scored = await sql<ResumeRows["scored"]>`
    SELECT DISTINCT s.competition_id, s.competitor_id
    FROM scores s JOIN competitions c ON c.id = s.competition_id
    WHERE c.session_id = ${sessionId}`;
  return { sessionStatus: session.status, competitors, scored };
}

/** Does the track (dj/sb) or judge behind a client id exist? */
export async function clientExists(
  kind: "dj" | "judge" | "sb",
  num: number,
): Promise<boolean> {
  if (!sql) return true; // memory mode: nothing to check against
  const rows = kind === "judge"
    ? await sql`SELECT 1 FROM judges WHERE id = ${num}`
    : await sql`SELECT 1 FROM tracks WHERE id = ${num}`;
  return rows.length > 0;
}

// --- audio metadata ----------------------------------------------------------

/** The session and track a competition belongs to, and whether it has started. */
export async function getCompetitionSession(
  competitionId: number,
): Promise<
  | { sessionId: number; trackId: number; status: string; startTime: Date }
  | undefined
> {
  if (!sql) return undefined;
  const rows = await sql<
    { session_id: number; track_id: number; status: string; start_time: Date }[]
  >`
    SELECT s.id AS session_id, s.track_id, s.status, s.start_time
    FROM competitions c JOIN sessions s ON s.id = c.session_id
    WHERE c.id = ${competitionId}`;
  const r = rows[0];
  return r && {
    sessionId: r.session_id,
    trackId: r.track_id,
    status: r.status,
    startTime: r.start_time,
  };
}

type AudioRow = {
  competition_id: number;
  competitor_id: number;
  kind: AudioRecord["kind"];
  storage_key: string;
  content_type: string;
  bytes: number;
  sha256: string;
};
const toAudioRecord = (r: AudioRow): AudioRecord => ({
  competitionId: r.competition_id,
  competitorId: r.competitor_id,
  kind: r.kind,
  storageKey: r.storage_key,
  contentType: r.content_type,
  bytes: r.bytes,
  sha256: r.sha256,
});

export const audioStore: AudioMetadataStore | undefined = sql
  ? {
    async upsert(rec: AudioRecord) {
      const old = await sql<AudioRow[]>`
        SELECT * FROM audio_files
        WHERE competition_id = ${rec.competitionId}
          AND competitor_id = ${rec.competitorId} AND kind = ${rec.kind}`;
      await sql`
        INSERT INTO audio_files
          (competition_id, competitor_id, kind, storage_key, content_type, bytes, sha256)
        VALUES (${rec.competitionId}, ${rec.competitorId}, ${rec.kind},
          ${rec.storageKey}, ${rec.contentType}, ${rec.bytes}, ${rec.sha256})
        ON CONFLICT (competition_id, competitor_id, kind) DO UPDATE SET
          storage_key = EXCLUDED.storage_key, content_type = EXCLUDED.content_type,
          bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256, created_at = NOW()`;
      return old[0] && toAudioRecord(old[0]);
    },
    async get(ref: AudioRef) {
      const rows = await sql<AudioRow[]>`
        SELECT * FROM audio_files
        WHERE competition_id = ${ref.competitionId}
          AND competitor_id = ${ref.competitorId} AND kind = ${ref.kind}`;
      return rows[0] && toAudioRecord(rows[0]);
    },
    async listForCompetitions(ids: number[]) {
      if (ids.length === 0) return [];
      const rows = await sql<AudioRow[]>`
        SELECT * FROM audio_files WHERE competition_id IN ${sql(ids)}`;
      return rows.map(toAudioRecord);
    },
  }
  : undefined;

/** The next session (by start time) on a track that has not finished. */
export async function getNextSessionForTrack(
  trackId: number,
): Promise<{ id: number; startTime: Date } | undefined> {
  if (!sql) return undefined;
  const rows = await sql<{ id: number; start_time: Date }[]>`
    SELECT id, start_time FROM sessions
    WHERE track_id = ${trackId} AND status IN ('upcoming', 'active')
    ORDER BY (status = 'active') DESC, start_time, id LIMIT 1`;
  return rows[0] && { id: rows[0].id, startTime: rows[0].start_time };
}

/**
 * Put a session back to its starting state so a demo can be run again: scores
 * removed, statuses and pointers reset, start time moved to now.
 */
export async function resetSession(sessionId: number): Promise<void> {
  if (!sql) return;
  await sql.begin(async (tx: typeof sql) => {
    await tx`DELETE FROM scores WHERE competition_id IN
      (SELECT id FROM competitions WHERE session_id = ${sessionId})`;
    await tx`UPDATE competitions SET status = 'upcoming'
      WHERE session_id = ${sessionId}`;
    await tx`UPDATE competition_competitors SET status = 'upcoming'
      WHERE competition_id IN
        (SELECT id FROM competitions WHERE session_id = ${sessionId})`;
    await tx`UPDATE sessions SET status = 'upcoming', start_time = NOW(),
      current_competition = NULL, current_competitor = NULL
      WHERE id = ${sessionId}`;
    await tx`UPDATE tracks SET current_session = NULL
      WHERE current_session = ${sessionId}`;
  });
}

/** Everything the admin overview needs, in a handful of queries. */
export async function getOverviewRows(): Promise<OverviewRows> {
  if (!sql) {
    return {
      festivals: [],
      tracks: [],
      sessions: [],
      competitions: [],
      competitors: [],
      rubricJudges: [],
      judges: [],
      scores: [],
    };
  }
  const [
    festivals,
    tracks,
    sessions,
    competitions,
    competitors,
    rubricJudges,
    judges,
    scores,
  ] = await Promise.all([
    sql`SELECT id, name FROM festivals ORDER BY id`,
    sql`SELECT id, festival_id, name, location FROM tracks ORDER BY id`,
    sql`SELECT id, track_id, name, status, start_time, current_competition,
          current_competitor FROM sessions ORDER BY start_time, id`,
    sql`SELECT id, session_id, order_number, name, status, rubric_id
        FROM competitions ORDER BY session_id, order_number`,
    sql`SELECT cc.competition_id, c.id, c.name, c.type, cc.duration, cc.order_number,
          cc.status
        FROM competition_competitors cc JOIN competitors c ON c.id = cc.competitor_id
        ORDER BY cc.competition_id, cc.order_number`,
    sql`SELECT rj.rubric_id, j.id AS judge_id, u.name, u.email
        FROM rubric_judges rj JOIN judges j ON j.id = rj.judge_id
        JOIN users u ON u.id = j.user_id ORDER BY j.id`,
    sql`SELECT j.id, u.name, u.email FROM judges j JOIN users u ON u.id = j.user_id
        ORDER BY j.id`,
    sql`SELECT competition_id, competitor_id, COUNT(DISTINCT judge_id)::int AS judges
        FROM scores GROUP BY competition_id, competitor_id`,
  ]);
  return {
    festivals,
    tracks,
    sessions,
    competitions,
    competitors,
    rubricJudges,
    judges,
    scores,
  } as unknown as OverviewRows;
}
