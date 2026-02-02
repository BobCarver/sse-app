import { dlog } from "./main.ts";
import type { ClientStatusMessage, ServerToClientMessage } from "./protocol.ts";
import { resolveTag, waitForTag } from "./resolveTag.ts";
import { type Competition, type ScoreSubmission, SSEClient } from "./types.ts";

// ============================================================================
// SESSION
// ============================================================================

const timeOut = Number(Deno.env.get("JUDGE_SCORE_TIMEOUT_MS") || 30000);

/**
 * Dependencies for Session
 */
export interface SessionDependencies {
  unassignedClients: Map<string, SSEClient>;
  saveScore: (submission: ScoreSubmission) => Promise<void>;
}

export class Session {
  clients: Map<string, SSEClient | undefined> = new Map();
  running: boolean = false;

  // Track current state for recovery
  currentCompetition: Competition | null = null;
  currentPosition: number = -1;
  currentPhase: "idle" | "performing" | "scoring" = "idle";
  submittedScores: Set<string> = new Set(); // "competitionId:position:judgeId"

  constructor(
    public id: number,
    private deps: SessionDependencies,
  ) {
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Connect a client to this session
   * This is called when an SSE connection is established
   */
  connectClient(client: SSEClient): void {
    dlog("Session: connectClient", {
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

    // Update the client slot with the SSE connection
    this.clients.set(client.id, client);

    // Wake up any code waiting for this client
    resolveTag(`required:${client.id}`, undefined);

    // Tell all clients about updated roster
    this.broadcastClientStatus();

    // Handle state recovery if session is running
    this.handleClientReconnect(client).catch((err) =>
      console.error(`Reconnect recovery failed for client ${client.id}:`, err)
    );
  }

  /**
   * Handle client reconnection during an active session
   * Sends appropriate recovery messages based on current phase
   */
  // deno-lint-ignore require-await
  async handleClientReconnect(client: SSEClient): Promise<void> {
    if (this.currentPhase === "idle") {
      return;
    }

    console.log(
      `Client ${client.id} reconnected during phase: ${this.currentPhase}`,
    );

    // DJ reconnecting during performance - send recovery message
    if (client.id[0] === "d" && this.currentPhase === "performing") {
      this.sendToClient(client, {
        event: "performance_recovery",
        competition_id: this.currentCompetition!.id,
        position: this.currentPosition,
      });
    }

    // Judge reconnecting during scoring - resend enable_scoring if not submitted
    if (client.id[0] === "j" && this.currentPhase === "scoring") {
      const scoreKey = `${
        this.currentCompetition!.id
      }:${this.currentPosition}:${client.id}`;

      if (!this.submittedScores.has(scoreKey)) {
        console.log(`Resending enable_scoring to judge ${client.id}`);
        this.sendToClient(client, {
          event: "enable_scoring",
          competition_id: this.currentCompetition!.id,
          position: this.currentPosition,
        });
      } else {
        console.log(`Judge ${client.id} already submitted, no recovery needed`);
      }
    }
  }

  /**
   * Mark client as disconnected (but keep the slot)
   * This is called when SSE connection is closed
   */
  disconnectClient(clientId: string): void {
    dlog("Session: disconnectClient", { sessionId: this.id, clientId });

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
    dlog("Session: removeClient", { sessionId: this.id, clientId });
    this.clients.delete(clientId);
    this.broadcastClientStatus();
  }

  /**
   * Register permanent clients (DJ, scoreboards) that stay for entire session
   */
  registerPermanentClients(clientIds: string[]): void {
    dlog("Session: registerPermanentClients", {
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
          resolveTag(`required:${clientId}`, undefined);
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
    dlog("Session: registerRequiredClients", {
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
          resolveTag(`required:${clientKey}`, undefined);
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
      dlog("Session: waiting for clients", { disconnectedClients });
      await Promise.all(
        disconnectedClients.map((id) => waitForTag(`required:${id}`)),
      );
      dlog("Session: all clients connected", { disconnectedClients });
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
      dlog("Session: waiting for required clients", { missing });
      await Promise.all(
        missing.map((id) => waitForTag(`required:${id}`)),
      );
      dlog("Session: required clients connected", { missing });
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
    dlog("broadcastClientStatus", message);
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
  broadcast(message: ServerToClientMessage): void {
    const { event, ...payload } = message;
    const data = JSON.stringify(payload);

    console.log("broadcast ->", JSON.stringify(message));

    for (const [clientId, client] of this.clients.entries()) {
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

    // Send performance start to DJ and all clients
    this.broadcast({
      event: "performance_start",
      competition_id: competition.id,
      position,
    });

    // Wait for DJ to signal completion (tag: perf:competitionId:position)
    const result = await waitForTag(
      `perf:${competition.id}:${position}`,
    ) as boolean;

    this.currentPhase = "idle";
    return result;
  }

  /**
   * Scoring phase - judges submit scores for competitor
   */
  private async scorePhase(competition: Competition): Promise<void> {
    this.currentPhase = "scoring";

    // Enable scoring for all judges
    this.broadcast({
      event: "enable_scoring",
      competition_id: competition.id,
      position: this.currentPosition,
    });

    // Wait for all judges to submit scores (with timeout)
    const scorePromises = competition.rubric.judges.map(async ({ id }) => {
      try {
        const competitor = competition.competitors[this.currentPosition];
        const scores = await waitForTag(
          `score:${competition.id}:${competitor.id}:${id}`,
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
        await this.deps.saveScore(submission);

        // Broadcast to scoreboards
        this.broadcast({
          event: "score_update",
          ...submission,
        });

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
