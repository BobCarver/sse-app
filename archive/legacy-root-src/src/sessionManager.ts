// A festival can have multiple sessions
// This class coordinates directing clients to the correct session

import { dlog } from "./main.ts";
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
    dlog("SessionManager: createSession", { sessionId });

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
    dlog("SessionManager: deleteSession", { sessionId });
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
    dlog("SessionManager: clearAll", { count: sessions.size });
    sessions.clear();
  }
}
