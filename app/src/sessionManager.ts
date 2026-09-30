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
   * Get an existing session or create a new one
   * @param sessionId - Session identifier
   * @param dependencies - Session dependencies (required if creating)
   * @returns Session instance
   */
  static getOrCreateSession(
    sessionId: number,
    dependencies: SessionDependencies,
  ): Session {
    let session = sessions.get(sessionId);
    if (!session) {
      session = this.createSession(sessionId, dependencies);
    }
    return session;
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

  /**
   * Check whether a new session can start without stealing another session's
   * track or clients. Returns a human-readable reason, or undefined if clear.
   * Rules: one running session per track; a judge stays in their session until
   * it completes; DJ/scoreboard ids are per-track so they cannot overlap.
   */
  static findConflict(
    sessionId: number,
    trackId: number,
    requiredClients: string[],
  ): string | undefined {
    for (const s of sessions.values()) {
      if (s.id === sessionId || !s.isRunning()) continue;
      if (s.trackId === trackId) {
        return `Track ${trackId} already has running session ${s.id}`;
      }
      const claimed = s.claimedClients;
      const taken = requiredClients.filter((id) => claimed.has(id));
      if (taken.length > 0) {
        return `${taken.join(", ")} already in running session ${s.id}`;
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

  /**
   * Clear all sessions (useful for testing)
   */
  static clearAll(): void {
    console.log("SessionManager: clearAll", { count: sessions.size });
    sessions.clear();
  }
}
