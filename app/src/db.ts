// db.ts
import postgres from "postgres";
import { Competition, Competitor, Rubric, ScoreSubmission } from "./types.ts";

const DATABASE_URL = Deno.env.get("DATABASE_URL") || "";

export const sql = DATABASE_URL ? postgres(DATABASE_URL) : undefined;
if (!sql) {
  console.warn(
    "DB not configured - DATABASE_URL not set; running in memory/disabled DB mode",
  );
} else {
  console.log("DB configured, connecting to", DATABASE_URL);
}

export const db = {
  saveScore({ scores, ...rest }: ScoreSubmission): Promise<void> {
    const values = scores.map((s) => ({ ...rest, ...s }));
    if (!sql) return Promise.resolve();
    return (sql as any)`INSERT INTO scores ${
      sql(values)
    }` as unknown as Promise<void>;
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
  const competitions = await (sql as any)<CompetitionRow[]>`
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
    ORDER BY comp.order_number
    HAVING COUNT(cc.competitor_id) > 0;
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

  const rubrics = await (sql as any)<Rubric[]>`
    SELECT r.id,
      ( SELECT json_agg( json_build_object( 'id', cr.id, 'name', cr.name, 'weight', rc.weight))
        FROM rubric_criteria rc
        JOIN criteria cr ON rc.criteria_id = cr.id
        WHERE rc.rubric_id = r.id
      ) AS criteria,
      ( SELECT json_agg(
          json_build_object( 'id', j.id, 'name', u.name, 'criteria', (
              SELECT COALESCE(array_agg(rjc.criteria_id ORDER BY rjc.criteria_id), ARRAY[]::int[])
              FROM rubric_judge_criteria rjc
              WHERE rjc.rubric_id = r.id AND rjc.judge_id = j.id
            )
          )
        )
        FROM rubric_judges rj
        JOIN judges j ON rj.judge_id = j.id
        JOIN users u ON j.user_id = u.id
        WHERE rj.rubric_id = r.id
      ) AS judges
    FROM rubrics r
    WHERE r.id IN ${(sql as any)(rubricIds)}
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
