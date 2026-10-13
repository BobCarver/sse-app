// A festival can have multiple sessions
// This class coordinates directing clients to the correct session

import { Session, SessionDependencies } from "./session.ts";

// ============================================================================
// SESSION STATE
// ============================================================================

export const sessions: Map<number, Session> = new Map();

export function getSession(sessionId: number): Session | undefined {
  return sessions.get(sessionId);
}

export class SessionManager {
  /**
   * Create a new session
   * @param sessionId - Unique session identifier
   * @param dependencies - Session dependencies (unassigned clients pool)
   */
  static createSession(
    sessionId: number,
    dependencies: SessionDependencies,
  ): Session {
    console.log("SessionManager: createSession", { sessionId });

    let session = sessions.get(sessionId);
    if (session) {
      throw new Error(`Session ${sessionId} already exists`);
    }

    session = new Session(sessionId, dependencies);
    sessions.set(sessionId, session);
    return session;
  }

  /**
   * Get an existing session
   * @param sessionId - Session identifier
   * @returns Session if found, undefined otherwise
   */
  static getSession(sessionId: number): Session | undefined {
    return sessions.get(sessionId);
  }

  /**
   * Delete a session
   * @param sessionId - Session identifier
   */
  static deleteSession(sessionId: number): void {
    console.log("SessionManager: deleteSession", { sessionId });
    sessions.delete(sessionId);
  }

  /**
   * Find which session a client belongs to
   * @param clientId - Client identifier
   * @returns Session if client is registered, null otherwise
   */
  static findSessionForClient(clientId: string): Session | null {
    for (const s of sessions.values()) {
      if (s.clients.has(clientId)) {
        return s;
      }
    }
    return null;
  }

  /** The running session currently working on this competition, if any. */
  static findSessionForCompetition(competitionId: number): Session | undefined {
    for (const s of sessions.values()) {
      if (s.currentCompetition?.id === competitionId) return s;
    }
    return undefined;
  }

  /** The running session waiting for the DJ to start this competition. */
  static findSessionAwaitingBegin(competitionId: number): Session | undefined {
    for (const s of sessions.values()) {
      if (s.awaitingBegin === competitionId) return s;
    }
    return undefined;
  }

  /**
   * Check whether a new session can start without taking another running
   * session's track. Returns a human-readable reason, or undefined if clear.
   * (Judges are not checked here: they are claimed per competition, see
   * JudgeClaims, and a judge held elsewhere is waited for.)
   */
  static findConflict(
    sessionId: number,
    trackId: number,
  ): string | undefined {
    for (const s of sessions.values()) {
      if (s.id === sessionId || !s.isRunning()) continue;
      if (s.trackId === trackId) {
        return `Track ${trackId} already has running session ${s.id}`;
      }
    }
    return undefined;
  }

  /**
   * Get all active sessions
   * @returns Array of all sessions
   */
  static getAllSessions(): Session[] {
    return Array.from(sessions.values());
  }

  /**
   * Get all running sessions
   * @returns Array of currently running sessions
   */
  static getRunningSessions(): Session[] {
    return Array.from(sessions.values()).filter((s) => s.isRunning());
  }
}

/** Who holds a judge: a session (and its track) running one of their competitions. */
export interface ClaimHolder {
  sessionId: number;
  trackId: number | undefined;
}

/**
 * Judges are claimed per competition: a session claims its competition's
 * judges when that competition's start gate opens and gives them back when the
 * competition ends. A judge claimed by another session is waited for (the
 * session shows `judge<N> (held by track <T>)`), not refused.
 */
export class JudgeClaims {
  private holders = new Map<string, ClaimHolder>();
  private listeners = new Set<() => void>();

  /** Claim every free judge in `ids` for `owner`; returns those held by others. */
  claim(ids: string[], owner: ClaimHolder): string[] {
    const blocked: string[] = [];
    for (const id of ids) {
      const h = this.holders.get(id);
      if (h && h.sessionId !== owner.sessionId) blocked.push(id);
      else this.holders.set(id, owner);
    }
    return blocked;
  }

  /** Give back what `sessionId` holds (all of it, or just `ids`). */
  release(sessionId: number, ids?: string[]): void {
    let changed = false;
    for (const [id, h] of this.holders) {
      if (h.sessionId === sessionId && (!ids || ids.includes(id))) {
        this.holders.delete(id);
        changed = true;
      }
    }
    if (changed) { for (const notify of [...this.listeners]) notify(); }
  }

  holder(id: string): ClaimHolder | undefined {
    return this.holders.get(id);
  }

  /** Resolves at the next release (or when `signal` aborts). */
  changed(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.listeners.delete(done);
        signal.removeEventListener("abort", done);
        resolve();
      };
      if (signal.aborted) return resolve();
      this.listeners.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  clear(): void {
    this.holders.clear();
  }
}

/** The server's one registry of judge claims. */
export const judgeClaims = new JudgeClaims();
