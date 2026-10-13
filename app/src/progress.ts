import type { Status } from "./adminTypes.ts";

/**
 * Progress is a cursor per track (see track_progress in 01_schema.sql), not
 * statuses spread over tables: everything before the cursor in running order
 * is finished, everything after it is upcoming. Statuses are derived here.
 */

export type Phase = "performing" | "scoring";

/** Where an open session is: the competitor in play, or next to play. */
export interface Cursor {
  competitionId: number;
  competitorId: number;
  /** null = not started yet. */
  phase: Phase | null;
}

/** What the database knows about one session. */
export interface SessionProgress {
  finished: boolean;
  cancelled: boolean;
  /** The session holds its track (armed or started, not finished). */
  open: boolean;
  /** Its first competition has begun (an armed session may not have). */
  started?: boolean;
  /** Only for an open session; null = every competitor is done. */
  cursor: Cursor | null;
}

export const NOT_STARTED: SessionProgress = {
  finished: false,
  cancelled: false,
  open: false,
  cursor: null,
};

/** A session's running order as the derivation needs it. */
export interface OrderedCompetition {
  id: number;
  competitorIds: number[];
  /** How many judges score this competition. */
  judges: number;
}

export interface DerivedStatus {
  session: Status;
  competitions: Map<number, Status>;
  /** Keyed by `competitionId:competitorId`. */
  competitors: Map<string, Status>;
}

export const entryKey = (competitionId: number, competitorId: number) =>
  `${competitionId}:${competitorId}`;

/**
 * Per-competitor, per-competition and session status:
 *  - open session: before the cursor finished (or skipped if there is a skip
 *    record); the cursor in progress once its performance has begun (finished
 *    as soon as every judge has scored), upcoming before that; after it
 *    upcoming. No cursor = every competitor is done.
 *  - finished session: finished (or skipped) throughout.
 *  - cancelled session: what was scored is finished, skips are skipped, the
 *    rest stays upcoming (the cursor is gone with the track's lock).
 *  - otherwise: upcoming.
 * A competition is finished when all its entries are, upcoming when none has
 * begun, in progress otherwise.
 */
export function deriveStatus(
  order: OrderedCompetition[],
  progress: SessionProgress,
  skipped: ReadonlySet<string>,
  scoredBy: ReadonlyMap<string, number> = new Map(),
): DerivedStatus {
  const keys = order.flatMap((c) =>
    c.competitorIds.map((id) => ({ comp: c, key: entryKey(c.id, id), id }))
  );
  const done = (key: string): Status =>
    skipped.has(key) ? "skipped" : "finished";
  const competitors = new Map<string, Status>();

  const cursor = progress.cursor;
  const at = cursor
    ? keys.findIndex(({ comp, id }) =>
      comp.id === cursor.competitionId && id === cursor.competitorId
    )
    : -1;
  for (const [i, { comp, key }] of keys.entries()) {
    let status: Status;
    if (progress.finished) {
      status = done(key);
    } else if (progress.cancelled) {
      status = skipped.has(key)
        ? "skipped"
        : (scoredBy.get(key) ?? 0) > 0
        ? "finished"
        : "upcoming";
    } else if (!progress.open || (cursor && at === -1)) {
      // Not started, or a cursor outside the running order (should not
      // happen): show upcoming rather than guess.
      status = "upcoming";
    } else if (!cursor || i < at) {
      status = done(key);
    } else if (i > at || cursor.phase === null) {
      status = "upcoming";
    } else {
      const allScored = comp.judges > 0 &&
        (scoredBy.get(key) ?? 0) >= comp.judges;
      status = cursor.phase === "scoring" && allScored
        ? "finished"
        : "in_progress";
    }
    competitors.set(key, status);
  }

  const competitions = new Map<number, Status>();
  for (const comp of order) {
    const states = comp.competitorIds.map((id) =>
      competitors.get(entryKey(comp.id, id))!
    );
    competitions.set(
      comp.id,
      states.length > 0 &&
        states.every((s) => s === "finished" || s === "skipped")
        ? "finished"
        : states.every((s) => s === "upcoming")
        ? "upcoming"
        : "in_progress",
    );
  }

  // An armed session that has not begun is still upcoming.
  const begun = progress.started || progress.cursor === null ||
    progress.cursor.phase !== null;
  return {
    session: progress.finished || progress.cancelled
      ? "finished"
      : progress.open && begun
      ? "in_progress"
      : "upcoming",
    competitions,
    competitors,
  };
}
