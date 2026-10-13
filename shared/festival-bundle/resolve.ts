import type {
  BundleCompetition,
  BundleRubric,
  BundleSession,
  BundleTrack,
  FestivalData,
} from "./types.ts";

/** A competition with its `rubric_id` replaced by the rubric itself. */
export interface ResolvedCompetition
  extends Omit<BundleCompetition, "rubric_id"> {
  rubric: BundleRubric;
}

const byOrder = <T extends { order_number: number }>(a: T, b: T) =>
  a.order_number - b.order_number;

/** A track's sessions in running order: planned start, then order_number. */
export function sessionsInOrder(track: BundleTrack): BundleSession[] {
  return track.sessions.toSorted((a, b) =>
    Date.parse(a.start_time) - Date.parse(b.start_time) || byOrder(a, b)
  );
}

/**
 * What a session runs, in running order, each competition with its rubric.
 * Competitions with no entries are left out. Undefined if there is no such
 * session. Assumes `data` passed `validateData` (every rubric_id resolves).
 */
export function resolveSession(
  data: FestivalData,
  sessionId: number,
): ResolvedCompetition[] | undefined {
  const rubrics = new Map(data.festival.rubrics.map((r) => [r.id, r]));
  for (const track of data.festival.tracks) {
    const session = track.sessions.find((s) => s.id === sessionId);
    if (!session) continue;
    return session.competitions
      .filter((c) => c.competitors.length > 0)
      .toSorted(byOrder)
      .map(({ rubric_id, ...c }) => {
        const rubric = rubrics.get(rubric_id);
        if (!rubric) {
          throw new Error(`competition ${c.id}: no rubric ${rubric_id}`);
        }
        return { ...c, competitors: c.competitors.toSorted(byOrder), rubric };
      });
  }
  return undefined;
}
