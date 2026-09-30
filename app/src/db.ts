// db.ts
import postgres from "postgres";
import { Competition, Competitor, Rubric, ScoreSubmission } from "./types.ts";

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
      const rows = await sql<Raw[]>`SELECT * FROM client_credentials ORDER BY id`;
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
