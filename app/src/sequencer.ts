/**
 * Sessions run themselves, per track: each track always has its open session
 * armed (loaded and waiting for its clients, its audio and its planned start,
 * then the DJ's start button). The open session is the one holding the track,
 * else the first in running order that has not finished or been cancelled.
 * Arming happens at boot (which also resumes a session a crash cut off), after
 * a session ends (the DJ's End session) and after a cancel. The administrator
 * handles exceptions only (skip, hold, cancel).
 *
 * Off unless `enabled` (the server turns it on at boot unless ARMING=0 or
 * DEMO=1; tests and the demo start sessions by hand).
 */

export interface SequencerDeps {
  tracks(): number[];
  /** The session the track should run now, and whether it already started. */
  nextFor(
    trackId: number,
  ): Promise<{ sessionId: number; started: boolean } | undefined>;
  /** Is a session of this track running in this process? */
  busy(trackId: number): boolean;
  /** Start (arm) a session; `resumed`: it had started before (no audio gate). */
  start(
    sessionId: number,
    resumed: boolean,
  ): Promise<{ status: number; body: object }>;
}

export class Sequencer {
  enabled = false;
  /** Tracks being armed right now (one at a time per track). */
  private arming = new Set<number>();

  constructor(private deps: SequencerDeps) {}

  async armAll(): Promise<void> {
    for (const trackId of this.deps.tracks()) await this.armTrack(trackId);
  }

  /** Arm the track's open session, unless something already runs there. */
  async armTrack(trackId: number): Promise<number | undefined> {
    if (!this.enabled || this.arming.has(trackId)) return undefined;
    if (this.deps.busy(trackId)) return undefined;
    this.arming.add(trackId);
    try {
      const next = await this.deps.nextFor(trackId);
      if (!next) {
        console.log(`Sequencer: track ${trackId} has no more sessions`);
        return undefined;
      }
      const r = await this.deps.start(next.sessionId, next.started);
      console.log(
        `Sequencer: track ${trackId} armed session ${next.sessionId} -> ${r.status}`,
        r.status === 200 ? "" : r.body,
      );
      return r.status === 200 ? next.sessionId : undefined;
    } catch (err) {
      console.error(`Sequencer: could not arm track ${trackId}:`, err);
      return undefined;
    } finally {
      this.arming.delete(trackId);
    }
  }

  /**
   * A session ended. Completed or cancelled: the track moves on to its next
   * session. Anything else (an error, a shutdown) is left for the operator, so
   * a persistent failure does not restart in a loop.
   */
  sessionEnded(trackId: number, reason: string | null): void {
    if (!this.enabled) return;
    if (reason !== "completed" && reason !== "cancelled") {
      console.warn(
        `Sequencer: session on track ${trackId} ended (${reason}); not re-armed`,
      );
      return;
    }
    // After the caller has dropped the finished session.
    setTimeout(() => void this.armTrack(trackId), 0);
  }
}
