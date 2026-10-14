/**
 * The score push: what the competition server sends to the registration
 * portal during and after the event (portal.md section 9), and the checks the
 * portal applies on receipt. The server sends the festival's whole set of
 * scores and skips each time; the portal replaces its copy with each one.
 *
 *   POST <portal>/api/scores
 *   Authorization: Bearer <per-festival token>
 *   Content-Type: application/json
 *   body: ScorePush
 */
import { sha256Hex } from "./canonical.ts";
import type { FestivalData } from "./types.ts";

/** One judge's score for one criterion of one competitor. */
export interface ScoreRow {
  competition_id: number;
  competitor_id: number;
  judge_id: number;
  criteria_id: number;
  /** 1 to 10, at most one decimal. */
  score: number;
}

export type SkipStage = "performance" | "scoring";
export type SkipActor = "dj" | "operator";
export const SKIP_STAGES: readonly SkipStage[] = ["performance", "scoring"];
export const SKIP_ACTORS: readonly SkipActor[] = ["dj", "operator"];

/** A competitor skipped by an explicit action on the day. */
export interface SkipRow {
  session_id: number;
  competition_id: number;
  competitor_id: number;
  stage: SkipStage;
  actor: SkipActor;
  reason: string;
}

/** Everything that is pushed: all the festival's scores and skips. */
export interface ScoreSnapshot {
  scores: ScoreRow[];
  skips: SkipRow[];
}

/** The request body. */
export interface ScorePush extends ScoreSnapshot {
  festival_id: number;
  /** The bundle the scores belong to: the receiver rejects a different one. */
  bundle_digest: string;
  /** `snapshotDigest` of the festival id, bundle digest, scores and skips. */
  digest: string;
  /** The authoritative upload after the event. */
  final: boolean;
  /** When the server sent it (UTC ISO); an older push never replaces a newer one. */
  sent_at: string;
}

const byKey = <T>(key: (x: T) => number[]) => (a: T, b: T) => {
  const x = key(a), y = key(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The snapshot in a fixed order, so equal data gives an equal digest. */
export function sortSnapshot(s: ScoreSnapshot): ScoreSnapshot {
  return {
    scores: s.scores.toSorted(byKey((r) => [
      r.competition_id,
      r.competitor_id,
      r.judge_id,
      r.criteria_id,
    ])),
    skips: s.skips.toSorted(byKey((r) => [
      r.session_id,
      r.competition_id,
      r.competitor_id,
    ])),
  };
}

/** Digest of a sorted snapshot: lets the sender skip a push when nothing changed. */
export function snapshotDigest(
  festivalId: number,
  bundleDigest: string,
  s: ScoreSnapshot,
): Promise<string> {
  return sha256Hex(
    JSON.stringify([festivalId, bundleDigest, s.scores, s.skips]),
  );
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0;
const MAX_REPORTED = 20;

/** A score the competition server accepts: 1 to 10 in steps of 0.1. */
export function isValidScore(v: unknown): v is number {
  return typeof v === "number" && v >= 1 && v <= 10 &&
    Math.abs(Math.round(v * 10) - v * 10) < 1e-6;
}

/**
 * The shape of a push: readable problems, at most 20 (empty = valid). Checks
 * nothing that needs the bundle; see `checkScoresAgainstBundle`.
 */
export function validateScorePush(raw: unknown): string[] {
  if (!isObject(raw)) return ["body must be a JSON object"];
  const bad: string[] = [];
  if (!isId(raw.festival_id)) {
    bad.push("festival_id must be a positive integer");
  }
  for (const k of ["bundle_digest", "digest", "sent_at"]) {
    if (typeof raw[k] !== "string" || raw[k] === "") {
      bad.push(`${k} must be text`);
    }
  }
  if (
    typeof raw.sent_at === "string" && Number.isNaN(Date.parse(raw.sent_at))
  ) {
    bad.push("sent_at must be an ISO time");
  }
  if (typeof raw.final !== "boolean") bad.push("final must be true or false");
  if (!Array.isArray(raw.scores)) bad.push("scores must be a list");
  if (!Array.isArray(raw.skips)) bad.push("skips must be a list");
  if (bad.length) return bad;

  const seen = new Set<string>();
  for (const [i, r] of (raw.scores as unknown[]).entries()) {
    if (bad.length >= MAX_REPORTED) return bad;
    if (
      !isObject(r) || !isId(r.competition_id) || !isId(r.competitor_id) ||
      !isId(r.judge_id) || !isId(r.criteria_id)
    ) {
      bad.push(`scores[${i}]: ids must be positive integers`);
      continue;
    }
    if (!isValidScore(r.score)) {
      bad.push(`scores[${i}]: score must be 1-10 with at most one decimal`);
    }
    const key =
      `${r.competition_id}/${r.competitor_id}/${r.judge_id}/${r.criteria_id}`;
    if (seen.has(key)) bad.push(`scores[${i}]: ${key} is listed twice`);
    seen.add(key);
  }
  const skipped = new Set<string>();
  for (const [i, r] of (raw.skips as unknown[]).entries()) {
    if (bad.length >= MAX_REPORTED) return bad;
    if (
      !isObject(r) || !isId(r.session_id) || !isId(r.competition_id) ||
      !isId(r.competitor_id) || typeof r.reason !== "string"
    ) {
      bad.push(
        `skips[${i}]: needs session_id, competition_id, competitor_id and reason`,
      );
      continue;
    }
    if (!SKIP_STAGES.includes(r.stage as SkipStage)) {
      bad.push(`skips[${i}]: stage must be ${SKIP_STAGES.join(" or ")}`);
    }
    if (!SKIP_ACTORS.includes(r.actor as SkipActor)) {
      bad.push(`skips[${i}]: actor must be ${SKIP_ACTORS.join(" or ")}`);
    }
    const key = `${r.session_id}/${r.competition_id}/${r.competitor_id}`;
    if (skipped.has(key)) bad.push(`skips[${i}]: ${key} is listed twice`);
    skipped.add(key);
  }
  return bad;
}

/**
 * Rows that do not belong to the bundle: a competitor not entered in that
 * competition, a judge who does not score that criterion there, a skip in the
 * wrong session. At most 20 (empty = all belong). `push` must already have
 * passed `validateScorePush`.
 */
export function checkScoresAgainstBundle(
  push: ScoreSnapshot,
  data: FestivalData,
): string[] {
  const rubrics = new Map(data.festival.rubrics.map((r) => [r.id, r]));
  const entries = new Set<string>(); // competition/competitor
  const sessionOf = new Map<number, number>(); // competition -> session
  const scorable = new Map<number, Set<string>>(); // competition -> judge/criterion
  for (const t of data.festival.tracks) {
    for (const s of t.sessions) {
      for (const c of s.competitions) {
        sessionOf.set(c.id, s.id);
        for (const p of c.competitors) entries.add(`${c.id}/${p.id}`);
        const pairs = new Set<string>();
        for (const j of rubrics.get(c.rubric_id)?.judges ?? []) {
          for (const k of j.criteria) pairs.add(`${j.id}/${k}`);
        }
        scorable.set(c.id, pairs);
      }
    }
  }
  const bad: string[] = [];
  for (const r of push.scores) {
    if (bad.length >= MAX_REPORTED) return bad;
    const where =
      `score ${r.competition_id}/${r.competitor_id}/${r.judge_id}/${r.criteria_id}`;
    if (!entries.has(`${r.competition_id}/${r.competitor_id}`)) {
      bad.push(
        `${where}: competitor ${r.competitor_id} is not in competition ${r.competition_id}`,
      );
    } else if (
      !scorable.get(r.competition_id)?.has(`${r.judge_id}/${r.criteria_id}`)
    ) {
      bad.push(
        `${where}: judge ${r.judge_id} does not score criterion ${r.criteria_id} there`,
      );
    }
  }
  for (const r of push.skips) {
    if (bad.length >= MAX_REPORTED) return bad;
    const where = `skip ${r.session_id}/${r.competition_id}/${r.competitor_id}`;
    if (!entries.has(`${r.competition_id}/${r.competitor_id}`)) {
      bad.push(
        `${where}: competitor ${r.competitor_id} is not in competition ${r.competition_id}`,
      );
    } else if (sessionOf.get(r.competition_id) !== r.session_id) {
      bad.push(
        `${where}: competition ${r.competition_id} is not in session ${r.session_id}`,
      );
    }
  }
  return bad;
}
