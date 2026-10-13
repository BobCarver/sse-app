import type { BundleSession } from "../../shared/festival-bundle/mod.ts";
import type { Cursor } from "./progress.ts";

/**
 * When will a track's sessions start? Delays cascade: a session starts at the
 * later of its planned time and the end of the one before it on its track.
 * The open session's remaining work is its remaining entries' durations plus a
 * per-competitor allowance (announcement, scoring, changeover).
 */

/** Seconds added to each competitor's duration. */
export interface Allowances {
  announce: number;
  scoring: number;
  changeover: number;
}

export const DEFAULT_ALLOWANCES: Allowances = {
  announce: 20,
  scoring: 30,
  changeover: 45,
};

/** ALLOWANCE_ANNOUNCE_S, ALLOWANCE_SCORING_S, ALLOWANCE_CHANGEOVER_S (seconds). */
export function allowances(): Allowances {
  const read = (name: string, dflt: number) => {
    const raw = Deno.env.get(name);
    const n = Number(raw);
    return raw && Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    announce: read("ALLOWANCE_ANNOUNCE_S", DEFAULT_ALLOWANCES.announce),
    scoring: read("ALLOWANCE_SCORING_S", DEFAULT_ALLOWANCES.scoring),
    changeover: read("ALLOWANCE_CHANGEOVER_S", DEFAULT_ALLOWANCES.changeover),
  };
}

export interface PlannedSession {
  id: number;
  plannedStart: Date;
  /** Entries in running order. Durations in SECONDS. */
  entries: { competitionId: number; competitorId: number; duration: number }[];
}

/** A bundle session as the estimate needs it (entries in running order). */
export function planFromBundle(s: BundleSession): PlannedSession {
  const byOrder = <T extends { order_number: number }>(a: T, b: T) =>
    a.order_number - b.order_number;
  return {
    id: s.id,
    plannedStart: new Date(s.start_time),
    entries: s.competitions.toSorted(byOrder).flatMap((c) =>
      c.competitors.toSorted(byOrder).map((p) => ({
        competitionId: c.id,
        competitorId: p.id,
        duration: p.duration,
      }))
    ),
  };
}

/** A start this much after the planned time counts as late. */
export const LATE_AFTER_MS = 60_000;

export function isLate(estimate: Date, planned: Date): boolean {
  return estimate.getTime() - planned.getTime() > LATE_AFTER_MS;
}

/**
 * Expected start of each session in `sessions` (a track's sessions not done,
 * in running order). `open`: the session holding the track and its cursor
 * (null = every entry done); its own start is not estimated (it has one).
 */
export function estimateStarts(
  sessions: PlannedSession[],
  open: { sessionId: number; cursor: Cursor | null } | undefined,
  now: Date,
  a: Allowances = DEFAULT_ALLOWANCES,
): Map<number, Date> {
  const full = (duration: number) =>
    duration + a.announce + a.scoring + a.changeover;
  const out = new Map<number, Date>();
  let t = now.getTime();
  for (const s of sessions) {
    if (s.id === open?.sessionId) {
      const cursor = open.cursor;
      const at = cursor
        ? s.entries.findIndex((e) =>
          e.competitionId === cursor.competitionId &&
          e.competitorId === cursor.competitorId
        )
        : -1;
      let left = 0;
      if (at >= 0) {
        // The one on now: scoring has only scoring and changeover left.
        left += cursor!.phase === "scoring"
          ? a.scoring + a.changeover
          : full(s.entries[at].duration);
        for (const e of s.entries.slice(at + 1)) left += full(e.duration);
      }
      t += left * 1000;
      continue;
    }
    const start = Math.max(s.plannedStart.getTime(), t);
    out.set(s.id, new Date(start));
    t = start + s.entries.reduce((sum, e) => sum + full(e.duration), 0) * 1000;
  }
  return out;
}
