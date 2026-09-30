import type { ClientStatusMessage, ServerToClientMessage } from "./protocol.ts";
import { resolveTag, waitForTag } from "./resolveTag.ts";
import { perfTag, requiredTag, scoreTag } from "./contract.ts";
import {
  type Competition,
  type Scores,
  type ScoreSubmission,
  SSEClient,
} from "./types.ts";

// ============================================================================
// SESSION
// ============================================================================

const timeOut = 30000;

const isJudge = (clientId: string) => clientId.startsWith("judge");
const isScoreboard = (clientId: string) => clientId.startsWith("sb");

// saveScore is retried before giving up (delays in ms between attempts).
const SAVE_RETRY_DELAYS = [100, 300];

export const MIN_SCORE = 1;
export const MAX_SCORE = 10;

/** Why a score submission was refused. `closed` = not accepting right now. */
export type ScoreRejection = {
  kind: "closed" | "forbidden" | "invalid";
  message: string;
};

/**
 * Dependencies for Session
 */
export interface SessionDependencies {
  unassignedClients: Map<string, SSEClient>;
  saveScore: (submission: ScoreSubmission) => Promise<void>;
  /** Track this session runs on (one running session per track). */
  trackId?: number;
  /** Client ids held by this session until it ends (judges for every competition). */
  claimedClients?: string[];
}

export class Session {
  clients: Map<string, SSEClient | undefined> = new Map();
  running: boolean = false;

  // Track current state for recovery
  currentCompetition: Competition | null = null;
  currentPosition: number = -1;
  currentPhase: "idle" | "performing" | "scoring" = "idle";
  submittedScores: Set<string> = new Set(); // "competitionId:position:judgeId"
  /** Submissions that could not be saved after retries (kept for recovery/audit). */
  unsavedScores: ScoreSubmission[] = [];
  /** Scores accepted for the current competitor (replayed to scoreboards that connect late). */
  currentScores: ScoreSubmission[] = [];

  constructor(
    public id: number,
    private deps: SessionDependencies,
  ) {
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Check a judge's scores against the live state and rubric. Returns why it is
   * refused, or undefined if acceptable. Called by /response before resolving.
   */
  validateScoreSubmission(
    competitionId: number,
    competitorId: number,
    judgeId: number,
    scores: Scores,
  ): ScoreRejection | undefined {
    const comp = this.currentCompetition;
    if (
      this.currentPhase !== "scoring" || !comp || comp.id !== competitionId ||
      comp.competitors[this.currentPosition]?.id !== competitorId
    ) {
      return { kind: "closed", message: "not accepting scores for this competitor" };
    }
    const judge = comp.rubric.judges.find((j) => j.id === judgeId);
    if (!judge) {
      return { kind: "forbidden", message: "judge is not part of this competition" };
    }
    const expected = [...judge.criteria].sort((a, b) => a - b);
    const got = scores.map((s) => s.criteria_id).sort((a, b) => a - b);
    if (
      expected.length !== got.length || expected.some((id, i) => id !== got[i])
    ) {
      return {
        kind: "invalid",
        message: `expected exactly one score for each of criteria [${expected}]`,
      };
    }
    if (scores.some((s) => s.score < MIN_SCORE || s.score > MAX_SCORE)) {
      return {
        kind: "invalid",
        message: `scores must be between ${MIN_SCORE} and ${MAX_SCORE}`,
      };
    }
    return undefined;
  }

  get trackId(): number | undefined {
    return this.deps.trackId;
  }

  /** Clients this session holds until it finishes (a judge can't leave mid-session). */
  get claimedClients(): ReadonlySet<string> {
    return new Set(this.deps.claimedClients ?? []);
  }

  /**
   * Connect a client to this session
   * This is called when an SSE connection is established
   */
  connectClient(client: SSEClient): void {
    console.log("Session: connectClient", {
      sessionId: this.id,
      clientId: client.id,
    });

    // Check if this client has a registered slot
    if (!this.clients.has(client.id)) {
      console.warn(
        `Client ${client.id} connected but has no registered slot in session ${this.id}`,
      );
      // Don't add it - they're not part of any competition rubric
      return;
    }

    // A different live connection already holds this slot (second tab, or a
    // reconnect that beat the old stream's abort): tell the old one to stop.
    const previous = this.clients.get(client.id);
    if (previous && previous !== client) {
      this.sendToClient(previous, { event: "superseded" });
    }

    // Update the client slot with the SSE connection
    this.clients.set(client.id, client);

    // Wake up any code waiting for this client
    resolveTag(requiredTag(client.id), undefined);

    // Tell all clients about updated roster
    this.broadcastClientStatus();

    // Handle state recovery if session is running
    this.handleClientReconnect(client).catch((err) =>
      console.error(`Reconnect recovery failed for client ${client.id}:`, err)
    );
  }

  /**
   * Bring a (re)connecting client up to date by replaying the current state as
   * the same events it would have received live. Handlers on the client are
   * idempotent, so a brief network blip and a full page reload both recover.
   *
   *  - everyone: competition_start (if a competition is underway)
   *  - DJ: performance_recovery while performing (NOT performance_start: that
   *    would replay the announcement)
   *  - judges/scoreboards: performance_start; judges also enable_scoring if
   *    they have not submitted; scoreboards also the scores so far
   */
  // deno-lint-ignore require-await
  async handleClientReconnect(client: SSEClient): Promise<void> {
    const competition = this.currentCompetition;
    if (!competition) return;

    console.log(
      `Client ${client.id} connected during phase: ${this.currentPhase}`,
    );
    this.sendToClient(client, { event: "competition_start", competition });

    const active = this.currentPosition >= 0 &&
      (this.currentPhase === "performing" || this.currentPhase === "scoring");
    if (!active) return;

    const isDj = client.id.startsWith("dj");
    const isJudge = client.id.startsWith("judge");
    const isScoreboard = client.id.startsWith("sb");
    const at = {
      competition_id: competition.id,
      position: this.currentPosition,
    };

    if (isDj) {
      if (this.currentPhase === "performing") {
        this.sendToClient(client, { event: "performance_recovery", ...at });
      }
      return;
    }

    this.sendToClient(client, { event: "performance_start", ...at });

    if (isJudge && this.currentPhase === "scoring") {
      const judgeId = Number(client.id.slice("judge".length));
      const submitted = this.submittedScores.has(
        `${competition.id}:${this.currentPosition}:${judgeId}`,
      );
      if (!submitted) {
        console.log(`Resending enable_scoring to ${client.id}`);
        this.sendToClient(client, { event: "enable_scoring", ...at });
      }
    }

    if (isScoreboard) {
      for (const submission of this.currentScores) {
        this.sendToClient(client, { event: "score_update", ...submission });
      }
    }
  }

  /**
   * Mark client as disconnected (but keep the slot)
   * This is called when SSE connection is closed
   */
  disconnectClient(clientId: string, client?: SSEClient): void {
    console.log("Session: disconnectClient", { sessionId: this.id, clientId });

    // A stale stream closing after its replacement connected must not clear
    // the replacement's slot: only act if this is still the connection held.
    if (client && this.clients.get(clientId) !== client) return;

    // Keep the client slot but mark as disconnected
    if (this.clients.has(clientId)) {
      this.clients.set(clientId, undefined);
      this.broadcastClientStatus();
    }
  }

  /**
   * Remove client slot entirely (only used when competition ends)
   * During a competition, use disconnectClient() instead
   */
  removeClient(clientId: string): void {
    console.log("Session: removeClient", { sessionId: this.id, clientId });
    this.clients.delete(clientId);
    this.broadcastClientStatus();
  }

  /**
   * Register permanent clients (DJ, scoreboards) that stay for entire session
   */
  registerPermanentClients(clientIds: string[]): void {
    console.log("Session: registerPermanentClients", {
      sessionId: this.id,
      clientIds,
    });

    for (const clientId of clientIds) {
      if (!this.clients.has(clientId)) {
        // Check if this client is already connected in unassigned pool
        const unassignedClient = this.deps.unassignedClients.get(clientId);

        if (unassignedClient) {
          // Move from unassigned to this session
          this.clients.set(clientId, unassignedClient);
          this.deps.unassignedClients.delete(clientId);
          console.log(
            `Assigned unassigned permanent client ${clientId} to session ${this.id}`,
          );

          // Resolve any waiters
          resolveTag(requiredTag(clientId), undefined);
        } else {
          // Client not connected yet, add empty slot
          this.clients.set(clientId, undefined);
          console.log(
            `Added permanent client slot ${clientId} to session ${this.id} (not connected yet)`,
          );
        }
      }
    }

    // Broadcast updated client roster
    this.broadcastClientStatus();
  }

  /**
   * Register required clients for a competition
   * Checks unassigned pool for already-connected clients
   */
  registerRequiredClients(competition: Competition): void {
    console.log("Session: registerRequiredClients", {
      sessionId: this.id,
      competitionId: competition.id,
      requiredClients: competition.rubric.judges.map((j) => `judge${j.id}`),
    });

    // Register all judges for this competition
    competition.rubric.judges.forEach((judge) => {
      const clientKey = `judge${judge.id}`;
      if (!this.clients.has(clientKey)) {
        // Check if this client is already connected in unassigned pool
        const unassignedClient = this.deps.unassignedClients.get(clientKey);

        if (unassignedClient) {
          // Move from unassigned to this session
          this.clients.set(clientKey, unassignedClient);
          this.deps.unassignedClients.delete(clientKey);
          console.log(
            `Assigned unassigned client ${clientKey} to session ${this.id}`,
          );

          // Resolve any waiters
          resolveTag(requiredTag(clientKey), undefined);
        } else {
          // Client not connected yet, add empty slot
          this.clients.set(clientKey, undefined);
          console.log(
            `Added client slot ${clientKey} to session ${this.id} (not connected yet)`,
          );
        }
      }
    });

    // Broadcast updated client roster
    this.broadcastClientStatus();
  }

  /**
   * Clear clients that are not needed for the next competition
   * Permanent clients are never removed
   */
  clearUnneededClients(
    nextCompetition: Competition | undefined,
    permanentClientIds: string[],
  ): void {
    const permanentIds = new Set(permanentClientIds);

    if (!nextCompetition) {
      // No next competition, return ALL clients except permanent ones to unassigned pool
      for (const [clientId, client] of this.clients.entries()) {
        if (!permanentIds.has(clientId) && client !== undefined) {
          this.deps.unassignedClients.set(clientId, client);
          console.log(
            `Moved client ${clientId} back to unassigned pool (session ending)`,
          );
        }
      }

      // Keep permanent clients only
      const toKeep = new Map<string, SSEClient | undefined>();
      for (const clientId of permanentClientIds) {
        toKeep.set(clientId, this.clients.get(clientId) || undefined);
      }
      this.clients.clear();
      for (const [clientId, client] of toKeep.entries()) {
        this.clients.set(clientId, client);
      }
      return;
    }

    // Get required client IDs for next competition (permanent + next competition judges)
    const requiredIds = new Set([
      ...permanentIds,
      ...nextCompetition.rubric.judges.map((j) => `judge${j.id}`),
    ]);

    // Remove clients not needed for next competition
    for (const [clientId, client] of this.clients.entries()) {
      if (!requiredIds.has(clientId)) {
        // Move back to unassigned pool if still connected
        if (client !== undefined) {
          this.deps.unassignedClients.set(clientId, client);
          console.log(`Moved client ${clientId} back to unassigned pool`);
        }
        this.clients.delete(clientId);
      }
    }
  }

  /**
   * Wait for all registered clients to connect
   */
  async requireAllClients(): Promise<void> {
    const disconnectedClients = [];
    for (const [id, client] of this.clients.entries()) {
      if (!client) {
        disconnectedClients.push(id);
      }
    }

    if (disconnectedClients.length > 0) {
      console.log("Session: waiting for clients", { disconnectedClients });
      await Promise.all(
        disconnectedClients.map((id) => waitForTag(requiredTag(id))),
      );
      console.log("Session: all clients connected", { disconnectedClients });
    }
  }

  /**
   * Wait for specific clients to connect (by client ID)
   */
  async require(clientIds: string[]): Promise<void> {
    const missing = clientIds.filter((id) =>
      !this.clients.has(id) || !this.clients.get(id)
    );

    if (missing.length > 0) {
      console.log("Session: waiting for required clients", { missing });
      await Promise.all(
        missing.map((id) => waitForTag(requiredTag(id))),
      );
      console.log("Session: required clients connected", { missing });
    }
  }

  /**
   * Broadcast client connection status to all clients
   */
  broadcastClientStatus(): void {
    const message: ClientStatusMessage = {
      event: "client_status",
      connected_clients: Array.from(this.clients.entries())
        .filter(([_, client]) => client !== undefined)
        .map(([id]) => id),
    };
    console.log("broadcastClientStatus", message);
    this.broadcast(message);
  }

  /**
   * Send message to a specific client
   */
  private sendToClient(
    client: SSEClient,
    message: ServerToClientMessage,
  ): void {
    try {
      const { event, ...payload } = message;
      const data = JSON.stringify(payload);
      client.controller.enqueue(`event: ${event}\ndata: ${data}\n\n`);
    } catch (error) {
      console.error(`Failed to send to client ${client.id}:`, error);
      // Mark as disconnected (will be cleaned up by SSE handler)
      this.clients.set(client.id, undefined);
    }
  }

  /**
   * Broadcast message to all connected clients
   */
  broadcast(
    message: ServerToClientMessage,
    only?: (clientId: string) => boolean,
  ): void {
    const { event, ...payload } = message;
    const data = JSON.stringify(payload);

    console.log("broadcast ->", JSON.stringify(message));

    for (const [clientId, client] of this.clients.entries()) {
      if (only && !only(clientId)) continue;
      if (client === undefined) {
        // Client is registered but disconnected, skip
        continue;
      }

      try {
        client.controller.enqueue(`event: ${event}\ndata: ${data}\n\n`);
      } catch (error) {
        console.error(`Failed to send to client ${clientId}:`, error);
        // Mark as disconnected (will be cleaned up by SSE handler)
        this.clients.set(clientId, undefined);
      }
    }
  }

  /**
   * Performance phase - DJ plays audio for competitor
   * Returns true if performance completed, false if skipped
   */
  private async performPhase(
    competition: Competition,
    position: number,
  ): Promise<boolean> {
    this.currentPhase = "performing";
    this.currentCompetition = competition;
    this.currentPosition = position;
    this.currentScores = [];

    // Send performance start to DJ and all clients
    this.broadcast({
      event: "performance_start",
      competition_id: competition.id,
      position,
    });

    // Wait for DJ to signal completion (tag: perf:competitionId:position)
    const result = await waitForTag(
      perfTag(competition.id, position),
    );

    this.currentPhase = "idle";
    return result;
  }

  /**
   * Save a submission, retrying transient failures. If it still fails the
   * submission is kept in `unsavedScores` and logged loudly; scoring continues
   * (the live event must not stop because the database hiccuped).
   */
  private async saveWithRetry(submission: ScoreSubmission): Promise<void> {
    for (let attempt = 0;; attempt++) {
      try {
        await this.deps.saveScore(submission);
        return;
      } catch (err) {
        if (attempt >= SAVE_RETRY_DELAYS.length) {
          this.unsavedScores.push(submission);
          console.error(
            `SCORE NOT SAVED after ${attempt + 1} attempts`,
            JSON.stringify(submission),
            err,
          );
          return;
        }
        await new Promise((r) => setTimeout(r, SAVE_RETRY_DELAYS[attempt]));
      }
    }
  }

  /**
   * Scoring phase - judges submit scores for competitor
   */
  private async scorePhase(competition: Competition): Promise<void> {
    this.currentPhase = "scoring";

    // Enable scoring for all judges
    // Only judges score.
    this.broadcast({
      event: "enable_scoring",
      competition_id: competition.id,
      position: this.currentPosition,
    }, isJudge);

    // Wait for all judges to submit scores (with timeout)
    const scorePromises = competition.rubric.judges.map(async ({ id }) => {
      try {
        const competitor = competition.competitors[this.currentPosition];
        const scores = await waitForTag(
          scoreTag(competition.id, competitor.id, id),
          timeOut,
        );

        // Mark as submitted before saving
        const scoreKey = `${competition.id}:${this.currentPosition}:${id}`;
        this.submittedScores.add(scoreKey);

        // Save to database
        const submission: ScoreSubmission = {
          competition_id: competition.id,
          competitor_id: competition.competitors[this.currentPosition].id,
          judge_id: id,
          scores,
        };
        await this.saveWithRetry(submission);

        // Remember for scoreboards that connect late, then broadcast
        this.currentScores.push(submission);
        // Scores go to scoreboards only: judges must not see each other's
        // scores while judging.
        this.broadcast({
          event: "score_update",
          ...submission,
        }, isScoreboard);

        return { success: true };
      } catch (err) {
        console.warn(`judge${id} timeout or error:`, err);
        return { success: false, error: err };
      }
    });

    const results = await Promise.allSettled(scorePromises);

    // Log any failures
    const failures = results.filter((r) =>
      r.status === "rejected" || (r.status === "fulfilled" && !r.value.success)
    );

    if (failures.length > 0) {
      console.warn(`${failures.length} judges failed to submit scores`);
    }

    this.currentPhase = "idle";
  }

  /**
   * Announce competition start to all clients
   */
  competitionStart(competition: Competition): void {
    this.currentCompetition = competition;
    this.currentPosition = -1;
    this.currentScores = [];
    this.broadcast({
      event: "competition_start",
      competition,
    });
  }

  /**
   * Main session execution loop
   * @param competitions - Array of competitions to run
   * @param permanentClientIds - Client IDs that stay for entire session (DJ, scoreboards)
   */
  async runSession(
    competitions: Competition[],
    permanentClientIds: string[] = ["dj0", "sb10"], // Default: DJ and scoreboard
  ): Promise<void> {
    if (this.running) {
      throw new Error(`Session ${this.id} already running`);
    }

    if (!competitions || competitions.length === 0) {
      throw new Error(`No competitions provided for session ${this.id}`);
    }

    this.running = true;
    this.submittedScores.clear();

    console.log(
      `Starting session ${this.id} (competitions=${competitions.length}, permanent clients=${permanentClientIds})`,
    );

    try {
      // Register permanent clients (DJ, scoreboards, etc.)
      this.registerPermanentClients(permanentClientIds);

      // Wait for all permanent clients to connect
      await this.require(permanentClientIds);
      console.log(`All permanent clients connected for session ${this.id}`);

      // Iterate through competitions in order
      for (const [index, competition] of competitions.entries()) {
        // Register required clients for THIS competition
        this.registerRequiredClients(competition);

        // Wait for all required clients to connect
        await this.requireAllClients();

        // Announce competition start
        this.competitionStart(competition);

        // Process each competitor sequentially
        for (
          const [position, competitor] of competition.competitors.entries()
        ) {
          try {
            const performanceCompleted = await this.performPhase(
              competition,
              position,
            );

            if (performanceCompleted) {
              await this.scorePhase(competition);
            } else {
              console.log(
                `Competitor at position ${position} skipped, no scoring`,
              );
            }
          } catch (err) {
            console.error("Error during competitor", {
              competitionId: competition.id,
              competitorId: competitor.id,
              position,
              err,
            });
          } finally {
            this.submittedScores.clear();
          }
        }

        // Competition over: nothing to replay to clients connecting between
        // competitions
        this.currentCompetition = null;
        this.currentPosition = -1;
        this.currentScores = [];

        // Clean up clients not needed for next competition
        const nextCompetition = competitions[index + 1];
        this.clearUnneededClients(nextCompetition, permanentClientIds);
      }

      console.log(`Session ${this.id} completed successfully`);
    } catch (err) {
      console.error(`Session ${this.id} error:`, err);
      throw err;
    } finally {
      this.reset();
      console.log(`Session ${this.id} reset complete`);
    }
  }

  /**
   * Reset session state after completion
   */
  private reset(): void {
    this.running = false;
    this.currentPhase = "idle";
    this.currentCompetition = null;
    this.currentPosition = -1;
    this.currentScores = [];
    this.submittedScores.clear();

    // Move all connected clients (including DJ) back to unassigned pool
    for (const [clientId, client] of this.clients.entries()) {
      if (client !== undefined) {
        this.deps.unassignedClients.set(clientId, client);
        console.log(`Moved client ${clientId} back to unassigned pool (reset)`);
      }
    }

    this.clients.clear();
  }
}
