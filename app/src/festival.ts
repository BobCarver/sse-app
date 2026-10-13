import {
  AUDIO_KINDS,
  audioFileName,
  type BundleCompetitor,
  type BundleRubric,
  type BundleTrack,
  type FestivalData,
  resolveSession,
  sessionsInOrder,
} from "../../shared/festival-bundle/mod.ts";
import type { AudioRecord, AudioRef } from "./audioLibrary.ts";
import type { Competition } from "./types.ts";

/**
 * The festival structure, from the loaded bundle: static and read-only for the
 * whole event. Replaces what used to be read from the structure tables.
 */

export interface SessionInfo {
  id: number;
  name: string;
  trackId: number;
  /** Planned start. */
  startTime: Date;
  orderNumber: number;
}

const audioKey = (competitionId: number, competitorId: number, kind: string) =>
  `${competitionId}:${competitorId}:${kind}`;

export class Festival {
  private sessions = new Map<number, SessionInfo>();
  private competitions = new Map<
    number,
    { sessionId: number; trackId: number; competitors: BundleCompetitor[] }
  >();
  private judges = new Map<number, string>();
  private audio = new Map<string, AudioRecord>();

  constructor(readonly data: FestivalData, readonly digest = "") {
    for (const r of data.festival.rubrics) {
      for (const j of r.judges) {
        if (!this.judges.has(j.id)) this.judges.set(j.id, j.name);
      }
    }
    for (const track of data.festival.tracks) {
      for (const s of track.sessions) {
        this.sessions.set(s.id, {
          id: s.id,
          name: s.name,
          trackId: track.id,
          startTime: new Date(s.start_time),
          orderNumber: s.order_number,
        });
        for (const c of s.competitions) {
          this.competitions.set(c.id, {
            sessionId: s.id,
            trackId: track.id,
            competitors: c.competitors,
          });
          for (const p of c.competitors) {
            for (const kind of AUDIO_KINDS) {
              const ref = p.audio?.[kind];
              if (!ref) continue;
              this.audio.set(audioKey(c.id, p.id, kind), {
                competitionId: c.id,
                competitorId: p.id,
                kind,
                storageKey: audioFileName(ref),
                contentType: ref.content_type,
                bytes: ref.bytes,
                sha256: ref.sha256,
              });
            }
          }
        }
      }
    }
  }

  /** No bundle loaded (tests that do not need one, before boot). */
  static empty(): Festival {
    return new Festival({
      festival: { id: 0, name: "", rubrics: [], tracks: [] },
    });
  }

  get loaded(): boolean {
    return this.data.festival.id !== 0;
  }

  get id(): number {
    return this.data.festival.id;
  }

  get name(): string {
    return this.data.festival.name;
  }

  get tracks(): BundleTrack[] {
    return this.data.festival.tracks;
  }

  get rubrics(): BundleRubric[] {
    return this.data.festival.rubrics;
  }

  /** What a session runs, in running order, with each competition's rubric. */
  sessionCompetitions(sessionId: number): Competition[] {
    return (resolveSession(this.data, sessionId) ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      competitors: c.competitors.map((p) => ({
        id: p.id,
        name: p.name,
        duration: p.duration,
      })),
      rubric: {
        id: c.rubric.id,
        criteria: c.rubric.criteria.map((x) => ({
          id: x.id,
          name: x.name,
          weight: x.weight,
        })),
        judges: c.rubric.judges.map((j) => ({
          id: j.id,
          name: j.name,
          criteria: [...j.criteria],
        })),
      },
    }));
  }

  /** The competitions of all of a track's sessions, in running order. */
  trackCompetitions(trackId: number): Competition[] {
    return this.trackSessions(trackId).flatMap((s) =>
      this.sessionCompetitions(s.id)
    );
  }

  session(sessionId: number): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  sessionTrackId(sessionId: number): number | undefined {
    return this.sessions.get(sessionId)?.trackId;
  }

  /** A track's sessions in running order (planned start, then order_number). */
  trackSessions(trackId: number): SessionInfo[] {
    const track = this.tracks.find((t) => t.id === trackId);
    return track
      ? sessionsInOrder(track).map((s) => this.sessions.get(s.id)!)
      : [];
  }

  /** The session and track a competition belongs to. */
  competition(
    competitionId: number,
  ): { sessionId: number; trackId: number } | undefined {
    const c = this.competitions.get(competitionId);
    return c && { sessionId: c.sessionId, trackId: c.trackId };
  }

  hasTrack(trackId: number): boolean {
    return this.tracks.some((t) => t.id === trackId);
  }

  /** A judge exists if some rubric names them. */
  hasJudge(judgeId: number): boolean {
    return this.judges.has(judgeId);
  }

  /** Every judge in some rubric, by id. */
  allJudges(): { id: number; name: string }[] {
    return [...this.judges].map(([id, name]) => ({ id, name }))
      .toSorted((a, b) => a.id - b.id);
  }

  audioFile(ref: AudioRef): AudioRecord | undefined {
    return this.audio.get(
      audioKey(ref.competitionId, ref.competitorId, ref.kind),
    );
  }

  audioFor(competitionIds: number[]): AudioRecord[] {
    const ids = new Set(competitionIds);
    return [...this.audio.values()].filter((a) => ids.has(a.competitionId));
  }

  /**
   * The session a track should run next: `open` (the one holding the track)
   * if any, else the first in running order not in `done`.
   */
  nextSession(
    trackId: number,
    done: ReadonlySet<number>,
    open?: number,
  ): SessionInfo | undefined {
    if (open !== undefined) {
      const s = this.sessions.get(open);
      if (s?.trackId === trackId) return s;
    }
    return this.trackSessions(trackId).find((s) => !done.has(s.id));
  }

  /** The session after `sessionId` on its track that has not run (or none). */
  followingSession(
    sessionId: number,
    done: ReadonlySet<number>,
  ): SessionInfo | undefined {
    const trackId = this.sessionTrackId(sessionId);
    if (trackId === undefined) return undefined;
    const order = this.trackSessions(trackId);
    const at = order.findIndex((s) => s.id === sessionId);
    return order.slice(at + 1).find((s) => !done.has(s.id));
  }
}

let current = Festival.empty();

/** The loaded festival (an empty one until the bundle is loaded). */
export function festival(): Festival {
  return current;
}

export function setFestival(f: Festival): void {
  current = f;
}
