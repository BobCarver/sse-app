import type { AudioRef } from "./audioLibrary.ts";
import type { openSession } from "./db.ts";
import { planResume, type ResumeRows } from "./resume.ts";
import type { Session, SessionDependencies } from "./session.ts";
import type { Competition } from "./types.ts";

/**
 * Start (arm) a session: load it from the festival, check it can run, reserve
 * its track and run it from wherever it stopped. Rules: one open session per
 * track (the database's progress row is the lock); the track's DJ
 * (dj<trackId>) and scoreboard (sb<trackId>) are permanent clients; judges are
 * claimed per competition (see JudgeClaims). Everything it touches comes in
 * through `StarterDeps`, so it runs without a database in tests.
 */

export type StartResult = { status: 200 | 400 | 404 | 409 | 500; body: object };

const reply = (
  body: object,
  status: StartResult["status"] = 200,
): StartResult => ({ status, body });

/** What a start needs once the session is known to be startable. */
export interface StartPlan {
  competitions: Competition[];
  trackId: number;
  resume: ReturnType<typeof planResume>;
  /** An operator hold survived a restart: start held. */
  held: boolean;
}

type Rejected = { rejected: StartResult };

/** The running sessions (SessionManager). */
export interface SessionRegistry {
  getSession(sessionId: number): Session | undefined;
  /** Why a running session of the track stops this one from starting. */
  findConflict(sessionId: number, trackId: number): string | undefined;
  deleteSession(sessionId: number): void;
  createSession(sessionId: number, deps: SessionDependencies): Session;
}

export interface StarterDeps {
  /** What the festival says about a session (a function: it is replaceable). */
  festival(): {
    sessionCompetitions(sessionId: number): Competition[];
    sessionTrackId(sessionId: number): number | undefined;
  };
  sessions: SessionRegistry;
  progress: {
    getResumeRows(sessionId: number): Promise<ResumeRows | undefined>;
    openSession: typeof openSession;
    releaseSession(sessionId: number): Promise<void>;
  };
  /** Audio the bundle does not have (those performances would be skipped). */
  missingAudio(competitions: Competition[]): Promise<AudioRef[]>;
  /** The session's wiring: clients, claims, database, audio gate, cloud copy. */
  wire(
    sessionId: number,
    plan: StartPlan,
    resumed: boolean,
  ): SessionDependencies;
  /** A session ended (it has been dropped from the registry). */
  ended(trackId: number, reason: Session["endReason"]): void;
}

export class SessionStarter {
  constructor(private d: StarterDeps) {}

  /**
   * Load a session from the bundle and run (arm) it from wherever it stopped.
   * `resumed`: it had begun before (a restart), so the audio start gate is
   * skipped (the DJ's ready report is memory only).
   */
  async start(sessionId: number, resumed = false): Promise<StartResult> {
    // Idempotent start: already running is success.
    const existing = this.d.sessions.getSession(sessionId);
    if (existing?.isRunning()) {
      return reply({
        success: true,
        message: "Session already running",
        sessionId,
      });
    }

    const planned = await this.plan(sessionId);
    if ("rejected" in planned) return planned.rejected;
    const { plan } = planned;

    const track = await this.takeTrack(sessionId, plan);
    if ("rejected" in track) return track.rejected;

    // No await from here to run() (see register).
    const registered = this.register(
      sessionId,
      plan.trackId,
      track.fresh,
      existing,
      this.d.wire(sessionId, plan, resumed),
    );
    if ("rejected" in registered) {
      if (registered.release) await this.d.progress.releaseSession(sessionId);
      return registered.rejected;
    }
    this.run(registered.session, plan);

    const missingAudio = (await this.d.missingAudio(plan.competitions)).map(
      (m) => ({
        competition_id: m.competitionId,
        competitor_id: m.competitorId,
        kind: m.kind,
      }),
    );
    if (missingAudio.length > 0) {
      console.warn(
        `Session ${sessionId}: ${missingAudio.length} audio file(s) missing`,
      );
    }

    const judges = new Set(
      plan.competitions.flatMap((comp) =>
        comp.rubric.judges.map((j) => `judge${j.id}`)
      ),
    );
    return reply({
      success: true,
      message: "Session started",
      sessionId,
      trackId: plan.trackId,
      missing_audio: missingAudio,
      already_finished: plan.resume.finished.size,
      reopened_scoring: plan.resume.reopen ? true : false,
      clients: {
        permanent: [`dj${plan.trackId}`, `sb${plan.trackId}`],
        judges: [...judges],
      },
    });
  }

  /**
   * Is the session in the festival, with something to run, and neither
   * finished nor cancelled? Reads its saved progress to plan where it picks up
   * (after a stop or a server restart).
   */
  private async plan(
    sessionId: number,
  ): Promise<{ plan: StartPlan } | Rejected> {
    const festival = this.d.festival();
    const competitions = festival.sessionCompetitions(sessionId);
    const trackId = festival.sessionTrackId(sessionId);
    if (trackId === undefined) {
      return {
        rejected: reply(
          { error: `No session ${sessionId} in the festival` },
          404,
        ),
      };
    }
    if (competitions.length === 0) {
      return {
        rejected: reply({
          error: `No competitions provided for session ${sessionId}`,
        }, 400),
      };
    }
    try {
      const rows = await this.d.progress.getResumeRows(sessionId);
      if (rows?.finished) {
        return {
          rejected: reply(
            { error: `Session ${sessionId} has already finished` },
            409,
          ),
        };
      }
      if (rows?.cancelled) {
        return {
          rejected: reply({ error: `Session ${sessionId} was cancelled` }, 409),
        };
      }
      return {
        plan: {
          competitions,
          trackId,
          resume: planResume(competitions, rows),
          held: !!rows?.held,
        },
      };
    } catch (err) {
      console.error(`Session ${sessionId}: database error on start:`, err);
      return {
        rejected: reply({ error: "Database error while loading session" }, 500),
      };
    }
  }

  /**
   * Reserve the track: against running sessions in memory, then with the lock
   * in the database, which survives a restart. A fresh session's cursor starts
   * on its first competitor. `fresh`: the lock was newly taken (not a resume).
   */
  private async takeTrack(
    sessionId: number,
    plan: StartPlan,
  ): Promise<{ fresh: boolean } | Rejected> {
    const { trackId, competitions } = plan;
    const conflict = this.d.sessions.findConflict(sessionId, trackId);
    if (conflict) return { rejected: reply({ error: conflict }, 409) };

    let lock;
    try {
      lock = await this.d.progress.openSession(sessionId, trackId, {
        competitionId: competitions[0].id,
        competitorId: competitions[0].competitors[0].id,
      });
    } catch (err) {
      console.error(
        `Session ${sessionId}: could not take track ${trackId}:`,
        err,
      );
      return {
        rejected: reply(
          { error: "Database error while opening the session" },
          500,
        ),
      };
    }
    if (!lock.ok) {
      return {
        rejected: reply({
          error:
            `Track ${trackId} has session ${lock.heldBy} open: it must finish first`,
        }, 409),
      };
    }
    return { fresh: lock.fresh };
  }

  /**
   * Register the session. Synchronous on purpose: the lock was taken before an
   * await, so another start may have got in since, and nothing may interleave
   * between this final conflict check, createSession and the caller starting
   * the run. `release`: the caller must give back the lock it newly took.
   */
  private register(
    sessionId: number,
    trackId: number,
    fresh: boolean,
    stale: Session | undefined,
    deps: SessionDependencies,
  ): { session: Session } | Rejected & { release: boolean } {
    const conflict = this.d.sessions.findConflict(sessionId, trackId);
    if (conflict) {
      return { rejected: reply({ error: conflict }, 409), release: fresh };
    }
    if (stale) {
      console.warn(`Session ${sessionId} is stale (not running); replacing`);
      this.d.sessions.deleteSession(sessionId);
    }
    try {
      return { session: this.d.sessions.createSession(sessionId, deps) };
    } catch (err) {
      return { rejected: reply({ error: String(err) }, 500), release: fresh };
    }
  }

  /** Run the session asynchronously; it is removed when it finishes or fails. */
  private run(session: Session, plan: StartPlan): void {
    const { trackId, competitions, resume } = plan;
    const sessionId = session.id;
    const permanent = [`dj${trackId}`, `sb${trackId}`];
    session.runSession(competitions, permanent, resume)
      .catch((error: unknown) => {
        console.error(`Session ${sessionId} error:`, error);
      })
      .finally(() => {
        // Only delete our own session (a restart may have replaced it).
        if (this.d.sessions.getSession(sessionId) === session) {
          this.d.sessions.deleteSession(sessionId);
        }
        console.log(`Session ${sessionId} ended (${session.endReason})`);
        this.d.ended(trackId, session.endReason);
      });
  }
}
