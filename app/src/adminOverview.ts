import type { AudioRecord } from "./audioLibrary.ts";
import { uploadCutoff } from "./audioLibrary.ts";
import type { Credential } from "./credentials.ts";
import type {
  AdminOverview,
  OverviewCompetition,
  OverviewDevice,
  OverviewLive,
  OverviewSession,
  Status,
} from "./adminTypes.ts";

/** Rows as they come out of the database (see getOverviewRows in db.ts). */
export interface OverviewRows {
  festivals: { id: number; name: string }[];
  tracks: {
    id: number;
    festival_id: number;
    name: string;
    location: string;
  }[];
  sessions: {
    id: number;
    track_id: number;
    name: string;
    status: string;
    start_time: Date;
    current_competition: number | null;
    current_competitor: number | null;
  }[];
  competitions: {
    id: number;
    session_id: number;
    order_number: number;
    name: string;
    status: string;
    rubric_id: number;
  }[];
  competitors: {
    competition_id: number;
    id: number;
    name: string | null;
    type: string;
    duration: number | null;
    order_number: number;
  }[];
  rubricJudges: {
    rubric_id: number;
    judge_id: number;
    name: string;
    email: string | null;
  }[];
  judges: { id: number; name: string; email: string | null }[];
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

/** Database status -> the three states the page colours. */
export function statusOf(db: string): Status {
  return db === "completed"
    ? "finished"
    : db === "active"
    ? "in_progress"
    : "upcoming";
}

/**
 * The whole festival tree in one object: tracks, sessions, competitions,
 * competitors, and the devices (with their links) that run them.
 */
export function buildOverview(
  rows: OverviewRows,
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
    ) => [`${s.competition_id}:${s.competitor_id}`, s.judges]),
  );

  const judgesByRubric = new Map<number, { id: number; name: string }[]>();
  for (const rj of rows.rubricJudges) {
    const list = judgesByRubric.get(rj.rubric_id) ?? [];
    list.push({ id: rj.judge_id, name: rj.name });
    judgesByRubric.set(rj.rubric_id, list);
  }
  const competitorsByCompetition = new Map<
    number,
    OverviewRows["competitors"]
  >();
  for (const c of rows.competitors) {
    const list = competitorsByCompetition.get(c.competition_id) ?? [];
    list.push(c);
    competitorsByCompetition.set(c.competition_id, list);
  }

  const buildCompetition = (
    comp: OverviewRows["competitions"][number],
    session: OverviewRows["sessions"][number],
  ): OverviewCompetition => {
    const judges = judgesByRubric.get(comp.rubric_id) ?? [];
    const compStatus = statusOf(comp.status);
    return {
      id: comp.id,
      name: comp.name,
      order: comp.order_number,
      status: compStatus,
      judges,
      competitors: (competitorsByCompetition.get(comp.id) ?? [])
        .toSorted((a, b) => a.order_number - b.order_number)
        .map((c) => {
          const scored = scoredBy.get(`${comp.id}:${c.id}`) ?? 0;
          // Finished once everyone scored (or the whole competition is over);
          // in progress while it is the one being performed.
          const status: Status = compStatus === "finished" ||
              (judges.length > 0 && scored >= judges.length)
            ? "finished"
            : compStatus === "in_progress" &&
                session.current_competition === comp.id &&
                session.current_competitor === c.id
            ? "in_progress"
            : "upcoming";
          return {
            id: c.id,
            name: c.name ?? `Competitor ${c.id}`,
            type: c.type,
            order: c.order_number,
            duration: c.duration,
            status,
            scored_by: scored,
            audio: {
              announce: audioByKey.has(`${comp.id}:${c.id}:announce`),
              music: audioByKey.has(`${comp.id}:${c.id}:music`),
            },
          };
        }),
    };
  };

  const buildSession = (
    s: OverviewRows["sessions"][number],
  ): OverviewSession => {
    const live = ctx.live(s.id);
    return {
      id: s.id,
      name: s.name,
      status: statusOf(s.status),
      start_time: s.start_time.toISOString(),
      audio_cutoff: uploadCutoff(s.start_time, ctx.cutoffMinutes).toISOString(),
      running: live !== null,
      live,
      competitions: rows.competitions
        .filter((c) => c.session_id === s.id)
        .toSorted((a, b) => a.order_number - b.order_number)
        .map((c) => buildCompetition(c, s)),
    };
  };

  const judgedBy = new Map<number, { id: number; name: string }[]>();
  for (const comp of rows.competitions) {
    for (const j of judgesByRubric.get(comp.rubric_id) ?? []) {
      const list = judgedBy.get(j.id) ?? [];
      if (!list.some((c) => c.id === comp.id)) {
        list.push({ id: comp.id, name: comp.name });
      }
      judgedBy.set(j.id, list);
    }
  }

  return {
    festivals: rows.festivals.map((f) => ({
      id: f.id,
      name: f.name,
      tracks: rows.tracks
        .filter((t) => t.festival_id === f.id)
        .map((t) => ({
          id: t.id,
          name: t.name,
          location: t.location,
          devices: [
            device("dj", `dj${t.id}`, "DJ"),
            device("sb", `sb${t.id}`, "Scoreboard"),
          ],
          sessions: rows.sessions
            .filter((s) => s.track_id === t.id)
            .toSorted((a, b) =>
              a.start_time.getTime() - b.start_time.getTime() || a.id - b.id
            )
            .map(buildSession),
        })),
    })),
    judges: rows.judges.map((j) => ({
      id: j.id,
      name: j.name,
      email: j.email,
      device: device("judge", `judge${j.id}`, j.name),
      competitions: judgedBy.get(j.id) ?? [],
    })),
  };
}
