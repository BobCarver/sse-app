import {
  type BundleCompetition,
  type BundleSession,
  type FestivalData,
  sessionsInOrder,
} from "../../shared/festival-bundle/mod.ts";
import type { AudioRecord } from "./audioLibrary.ts";
import { uploadCutoff } from "./audioLibrary.ts";
import {
  deriveStatus,
  entryKey,
  NOT_STARTED,
  type Phase,
  type SessionProgress,
} from "./progress.ts";
import type { Credential } from "./credentials.ts";
import type {
  AdminOverview,
  OverviewCompetition,
  OverviewDevice,
  OverviewLive,
  OverviewSession,
} from "./adminTypes.ts";

/** What the database knows about progress (see getProgressRows in db.ts). */
export interface ProgressRows {
  runs: {
    session_id: number;
    started_at: Date | null;
    finished_at: Date | null;
    cancelled_at: Date | null;
  }[];
  /** One per track: the open session and its cursor. */
  cursors: {
    track_id: number;
    open_session: number | null;
    competition_id: number | null;
    competitor_id: number | null;
    phase: Phase | null;
  }[];
  skips: {
    session_id: number;
    competition_id: number;
    competitor_id: number;
  }[];
  /** How many distinct judges have scored each competitor in each competition. */
  scores: { competition_id: number; competitor_id: number; judges: number }[];
}

export interface OverviewContext {
  audio: AudioRecord[];
  /** Every credential ever issued (revoked ones are left out of the result). */
  credentials: Credential[];
  /** Client ids with an open SSE connection. */
  connected: Set<string>;
  /** What a running session is doing right now. */
  live(sessionId: number): OverviewLive | null;
  now?: Date;
  cutoffMinutes?: number;
}

/** Where each session is, from the progress rows. */
export function sessionProgress(
  rows: ProgressRows,
): (sessionId: number) => SessionProgress {
  const runs = new Map(rows.runs.map((r) => [r.session_id, r]));
  const open = new Map(
    rows.cursors.filter((c) => c.open_session !== null).map((
      c,
    ) => [c.open_session!, c]),
  );
  return (sessionId) => {
    const run = runs.get(sessionId);
    const c = open.get(sessionId);
    if (!run && !c) return NOT_STARTED;
    return {
      finished: !!run?.finished_at,
      cancelled: !!run?.cancelled_at,
      open: !!c,
      cursor: c && c.competition_id !== null && c.competitor_id !== null
        ? {
          competitionId: c.competition_id,
          competitorId: c.competitor_id,
          phase: c.phase,
        }
        : null,
    };
  };
}

/**
 * The whole festival tree in one object: tracks, sessions, competitions,
 * competitors, and the devices (with their links) that run them. The structure
 * comes from the bundle; statuses are derived from the progress rows.
 */
export function buildOverview(
  data: FestivalData,
  rows: ProgressRows,
  ctx: OverviewContext,
): AdminOverview {
  const activeLinks = new Map<string, OverviewDevice["links"]>();
  for (const c of ctx.credentials) {
    if (c.revokedAt) continue;
    const list = activeLinks.get(c.clientId) ?? [];
    list.push({
      id: c.id,
      label: c.label,
      created_at: c.createdAt.toISOString(),
    });
    activeLinks.set(c.clientId, list);
  }
  const device = (
    kind: OverviewDevice["kind"],
    clientId: string,
    name: string,
  ): OverviewDevice => ({
    client_id: clientId,
    kind,
    name,
    connected: ctx.connected.has(clientId),
    links: activeLinks.get(clientId) ?? [],
  });

  const audioByKey = new Map(
    ctx.audio.map((a) => [`${a.competitionId}:${a.competitorId}:${a.kind}`, a]),
  );
  const scoredBy = new Map(
    rows.scores.map((
      s,
    ) => [entryKey(s.competition_id, s.competitor_id), s.judges]),
  );
  const skipped = new Set(
    rows.skips.map((s) => entryKey(s.competition_id, s.competitor_id)),
  );
  const progressOf = sessionProgress(rows);

  const rubrics = new Map(data.festival.rubrics.map((r) => [r.id, r]));
  const judgesOf = (c: BundleCompetition) =>
    (rubrics.get(c.rubric_id)?.judges ?? []).map((j) => ({
      id: j.id,
      name: j.name,
    }));
  const byOrder = <T extends { order_number: number }>(a: T, b: T) =>
    a.order_number - b.order_number;

  const buildSession = (s: BundleSession): OverviewSession => {
    const live = ctx.live(s.id);
    const competitions = s.competitions.toSorted(byOrder).map((c) => ({
      ...c,
      competitors: c.competitors.toSorted(byOrder),
    }));
    const derived = deriveStatus(
      competitions.map((c) => ({
        id: c.id,
        competitorIds: c.competitors.map((p) => p.id),
        judges: judgesOf(c).length,
      })),
      progressOf(s.id),
      skipped,
      scoredBy,
    );
    const startTime = new Date(s.start_time);
    return {
      id: s.id,
      name: s.name,
      status: derived.session,
      start_time: startTime.toISOString(),
      audio_cutoff: uploadCutoff(startTime, ctx.cutoffMinutes).toISOString(),
      running: live !== null,
      live,
      competitions: competitions.map((comp): OverviewCompetition => ({
        id: comp.id,
        name: comp.name,
        order: comp.order_number,
        status: derived.competitions.get(comp.id)!,
        judges: judgesOf(comp),
        competitors: comp.competitors.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          order: c.order_number,
          duration: c.duration,
          status: derived.competitors.get(entryKey(comp.id, c.id))!,
          scored_by: scoredBy.get(entryKey(comp.id, c.id)) ?? 0,
          audio: {
            announce: audioByKey.has(`${comp.id}:${c.id}:announce`),
            music: audioByKey.has(`${comp.id}:${c.id}:music`),
          },
        })),
      })),
    };
  };

  const judges = new Map<number, string>();
  const judgedBy = new Map<number, { id: number; name: string }[]>();
  for (const t of data.festival.tracks) {
    for (const s of sessionsInOrder(t)) {
      for (const comp of s.competitions.toSorted(byOrder)) {
        for (const j of judgesOf(comp)) {
          const list = judgedBy.get(j.id) ?? [];
          if (!list.some((c) => c.id === comp.id)) {
            list.push({ id: comp.id, name: comp.name });
          }
          judgedBy.set(j.id, list);
        }
      }
    }
  }
  for (const r of data.festival.rubrics) {
    for (const j of r.judges) if (!judges.has(j.id)) judges.set(j.id, j.name);
  }

  const f = data.festival;
  return {
    festivals: f.id === 0 ? [] : [{
      id: f.id,
      name: f.name,
      tracks: f.tracks.toSorted((a, b) => a.id - b.id).map((t) => ({
        id: t.id,
        name: t.name,
        location: t.location,
        devices: [
          device("dj", `dj${t.id}`, "DJ"),
          device("sb", `sb${t.id}`, "Scoreboard"),
        ],
        sessions: sessionsInOrder(t).map(buildSession),
      })),
    }],
    // The bundle carries no emails (privacy boundary).
    judges: [...judges].toSorted(([a], [b]) => a - b).map(([id, name]) => ({
      id,
      name,
      email: null,
      device: device("judge", `judge${id}`, name),
      competitions: judgedBy.get(id) ?? [],
    })),
  };
}
