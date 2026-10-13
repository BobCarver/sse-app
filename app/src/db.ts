// db.ts
import postgres from "postgres";
import type { ProgressRows } from "./adminOverview.ts";
import type { Cursor, Phase } from "./progress.ts";
import type { ResumeRows } from "./resume.ts";
import type { NextEntry, ProgressEvent, ScoreSubmission } from "./types.ts";

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

// --- the festival bundle (pairing guard) -----------------------------------

/**
 * Pair this database with a festival bundle. The first bundle is recorded
 * (digest and the exact data.json text); a different one is refused once
 * anything has run (scores, a session opened, skips, missing scores), so
 * results from two bundles never mix. Before that it simply replaces the
 * record. Returns why it was refused, or undefined.
 */
export async function pairBundle(
  b: { festivalId: number; digest: string; dataText: string },
): Promise<string | undefined> {
  if (!sql) return undefined;
  return await sql.begin(async (tx: typeof sql) => {
    await tx`LOCK TABLE festival_bundle IN EXCLUSIVE MODE`;
    const [row] = await tx<
      { festival_id: number; digest: string; loaded_at: Date }[]
    >`SELECT festival_id, digest, loaded_at FROM festival_bundle`;
    if (row?.digest === b.digest) return undefined;
    if (row) {
      const [{ used }] = await tx<{ used: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM scores)
          OR EXISTS (SELECT 1 FROM session_runs)
          OR EXISTS (SELECT 1 FROM skips)
          OR EXISTS (SELECT 1 FROM missing_scores)
          OR EXISTS (SELECT 1 FROM track_progress WHERE open_session IS NOT NULL)
          AS used`;
      if (used) {
        return `this database belongs to festival ${row.festival_id}, bundle ${
          row.digest.slice(0, 12)
        } (loaded ${row.loaded_at.toISOString()}), and the festival has started; ` +
          `refusing bundle ${
            b.digest.slice(0, 12)
          } (festival ${b.festivalId}). ` +
          `Run a different bundle against a fresh database.`;
      }
      console.warn(
        `Replacing bundle ${row.digest.slice(0, 12)} with ${
          b.digest.slice(0, 12)
        } (nothing has run yet)`,
      );
    }
    await tx`
      INSERT INTO festival_bundle (singleton, festival_id, digest, data_json)
      VALUES (TRUE, ${b.festivalId}, ${b.digest}, ${b.dataText})
      ON CONFLICT (singleton) DO UPDATE SET festival_id = EXCLUDED.festival_id,
        digest = EXCLUDED.digest, data_json = EXCLUDED.data_json,
        loaded_at = NOW()`;
    return undefined;
  });
}

// --- progress: the cursor per track -----------------------------------------

type CursorRow = {
  track_id: number;
  open_session: number | null;
  competition_id: number | null;
  competitor_id: number | null;
  phase: Phase | null;
};

const cursorOf = (r: CursorRow | undefined): Cursor | null =>
  r && r.competition_id !== null && r.competitor_id !== null
    ? {
      competitionId: r.competition_id,
      competitorId: r.competitor_id,
      phase: r.phase,
    }
    : null;

/**
 * Take the track for a session: the progress row is the lock (one open
 * session per track). Free track: it becomes this session's, with the cursor on
 * `first`, not begun. Already this session's: kept as it is (resume). Held by
 * another session: refused with that session's id.
 */
export async function openSession(
  sessionId: number,
  trackId: number,
  first: NextEntry,
): Promise<{ ok: true; fresh: boolean } | { ok: false; heldBy: number }> {
  if (!sql) return { ok: true, fresh: true };
  return await sql.begin(async (tx: typeof sql) => {
    const taken = await tx<{ track_id: number }[]>`
      INSERT INTO track_progress
        (track_id, open_session, competition_id, competitor_id, phase)
      VALUES (${trackId}, ${sessionId}, ${first?.competitionId ?? null},
        ${first?.competitorId ?? null}, NULL)
      ON CONFLICT (track_id) DO UPDATE SET
        open_session = EXCLUDED.open_session,
        competition_id = EXCLUDED.competition_id,
        competitor_id = EXCLUDED.competitor_id,
        phase = NULL, updated_at = NOW()
      WHERE track_progress.open_session IS NULL
      RETURNING track_id`;
    if (taken.length === 0) {
      const [row] = await tx<{ open_session: number }[]>`
        SELECT open_session FROM track_progress WHERE track_id = ${trackId}`;
      if (row?.open_session !== sessionId) {
        return { ok: false as const, heldBy: row?.open_session ?? -1 };
      }
    }
    await tx`INSERT INTO session_runs (session_id, track_id)
      VALUES (${sessionId}, ${trackId}) ON CONFLICT (session_id) DO NOTHING`;
    return { ok: true as const, fresh: taken.length > 0 };
  });
}

/** Give the track back (the session is no longer open; its cursor is cleared). */
export async function releaseSession(sessionId: number): Promise<void> {
  if (!sql) return;
  await sql`UPDATE track_progress SET open_session = NULL,
      competition_id = NULL, competitor_id = NULL, phase = NULL,
      updated_at = NOW()
    WHERE open_session = ${sessionId}`;
}

/**
 * Persist a step. The cursor writes are one row each (the track's progress
 * row, found by the session holding it); skips and missing scores are
 * appended; start and end times go to session_runs.
 */
export async function recordProgress(
  sessionId: number,
  event: ProgressEvent,
): Promise<void> {
  if (!sql) return;
  const moveTo = (tx: typeof sql, next: NextEntry) =>
    tx`UPDATE track_progress
      SET competition_id = ${next?.competitionId ?? null},
          competitor_id = ${next?.competitorId ?? null},
          phase = NULL, updated_at = NOW()
      WHERE open_session = ${sessionId}`;
  switch (event.kind) {
    case "session_started":
      break; // the track was taken by openSession
    case "competition_started":
      await sql`UPDATE session_runs SET started_at = COALESCE(started_at, NOW())
        WHERE session_id = ${sessionId}`;
      break;
    case "competitor_started":
      await sql`UPDATE track_progress
        SET competition_id = ${event.competitionId},
            competitor_id = ${event.competitorId},
            phase = 'performing', updated_at = NOW()
        WHERE open_session = ${sessionId}`;
      break;
    case "competitor_performed":
      await sql`UPDATE track_progress SET phase = 'scoring', updated_at = NOW()
        WHERE open_session = ${sessionId}
          AND competition_id = ${event.competitionId}
          AND competitor_id = ${event.competitorId}`;
      break;
    case "competitor_skipped":
      await sql.begin(async (tx: typeof sql) => {
        await tx`INSERT INTO skips
            (session_id, competition_id, competitor_id, stage, actor, reason)
          VALUES (${sessionId}, ${event.competitionId}, ${event.competitorId},
            ${event.stage}, ${event.actor}, ${event.reason ?? ""})
          ON CONFLICT DO NOTHING`;
        await moveTo(tx, event.next);
      });
      break;
    case "competitor_finalized":
      await moveTo(sql, event.next);
      break;
    case "score_missing":
      await sql`INSERT INTO missing_scores
          (session_id, competition_id, competitor_id, judge_id, reason)
        VALUES (${sessionId}, ${event.competitionId}, ${event.competitorId},
          ${event.judgeId}, ${event.reason})`;
      break;
    case "session_ended":
      if (event.reason === "completed") {
        await sql.begin(async (tx: typeof sql) => {
          await tx`UPDATE session_runs SET finished_at = NOW()
            WHERE session_id = ${sessionId}`;
          await tx`UPDATE track_progress SET open_session = NULL,
              competition_id = NULL, competitor_id = NULL, phase = NULL,
              updated_at = NOW()
            WHERE open_session = ${sessionId}`;
        });
      } else if (event.untouched) {
        // Stopped before anything ran: the track is free again. Otherwise it
        // stays this session's, to be resumed and completed first.
        await releaseSession(sessionId);
      }
      break;
  }
}

/** How far a session got, for resuming it (undefined without a database). */
export async function getResumeRows(
  sessionId: number,
): Promise<ResumeRows | undefined> {
  if (!sql) return undefined;
  const [run] = await sql<{ finished_at: Date | null }[]>`
    SELECT finished_at FROM session_runs WHERE session_id = ${sessionId}`;
  const [row] = await sql<CursorRow[]>`
    SELECT * FROM track_progress WHERE open_session = ${sessionId}`;
  const cursor = cursorOf(row);
  const cursorScores = cursor?.phase === "scoring"
    ? await sql<ResumeRows["cursorScores"]>`
      SELECT competition_id, competitor_id, judge_id, criteria_id,
             score::float AS score
      FROM scores
      WHERE competition_id = ${cursor.competitionId}
        AND competitor_id = ${cursor.competitorId}
      ORDER BY judge_id, criteria_id`
    : [];
  return {
    finished: !!run?.finished_at,
    open: !!row,
    cursor,
    cursorScores: [...cursorScores],
  };
}

/** The session holding a track, if any. */
export async function getTrackHolder(
  trackId: number,
): Promise<number | undefined> {
  if (!sql) return undefined;
  const [row] = await sql<{ open_session: number | null }[]>`
    SELECT open_session FROM track_progress WHERE track_id = ${trackId}`;
  return row?.open_session ?? undefined;
}

/**
 * Open sessions (each holds its track). At boot these are the sessions a crash
 * or a shutdown cut off: they are resumed and must be completed first.
 */
export async function getActiveSessionIds(): Promise<number[]> {
  if (!sql) return [];
  const rows = await sql<{ open_session: number }[]>`
    SELECT open_session FROM track_progress
    WHERE open_session IS NOT NULL ORDER BY open_session`;
  return rows.map((r: { open_session: number }) => r.open_session);
}

/** Sessions that ran to the end or were cancelled, and who holds each track. */
export async function getSessionMarks(): Promise<
  { done: Set<number>; openByTrack: Map<number, number> }
> {
  if (!sql) return { done: new Set(), openByTrack: new Map() };
  const [runs, holders] = await Promise.all([
    sql<{ session_id: number }[]>`SELECT session_id FROM session_runs
      WHERE finished_at IS NOT NULL OR cancelled_at IS NOT NULL`,
    sql<{ track_id: number; open_session: number }[]>`
      SELECT track_id, open_session FROM track_progress
      WHERE open_session IS NOT NULL`,
  ]);
  return {
    done: new Set(runs.map((r: { session_id: number }) => r.session_id)),
    openByTrack: new Map(
      holders.map((
        h: { track_id: number; open_session: number },
      ) => [h.track_id, h.open_session]),
    ),
  };
}

/** Everything the admin overview needs from the database. */
export async function getProgressRows(): Promise<ProgressRows> {
  if (!sql) return { runs: [], cursors: [], skips: [], scores: [] };
  const [runs, cursors, skips, scores] = await Promise.all([
    sql`SELECT session_id, started_at, finished_at, cancelled_at
        FROM session_runs`,
    sql`SELECT * FROM track_progress`,
    sql`SELECT session_id, competition_id, competitor_id FROM skips`,
    sql`SELECT competition_id, competitor_id, COUNT(DISTINCT judge_id)::int AS judges
        FROM scores GROUP BY competition_id, competitor_id`,
  ]);
  return { runs, cursors, skips, scores } as unknown as ProgressRows;
}

/**
 * Put a session back to its starting state so a demo can be run again: its
 * scores, skips, missing-score records and markers are removed and its track
 * is given back. `competitionIds`: the session's competitions (scores are
 * stored by competition).
 */
export async function resetSession(
  sessionId: number,
  competitionIds: number[],
): Promise<void> {
  if (!sql) return;
  await sql.begin(async (tx: typeof sql) => {
    if (competitionIds.length > 0) {
      await tx`DELETE FROM scores WHERE competition_id IN ${
        tx(competitionIds)
      }`;
    }
    await tx`DELETE FROM skips WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM missing_scores WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM session_runs WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM track_progress WHERE open_session = ${sessionId}`;
  });
}
