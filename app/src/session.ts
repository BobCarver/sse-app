import type { ClientStatusMessage, ServerToClientMessage } from "./protocol.ts";
import { resolveTag, waitForTag } from "./resolveTag.ts";
import { perfTag, requiredTag, scoreTag } from "./contract.ts";
import { finishedKey } from "./resume.ts";
import {
  type Competition,
  type ProgressEvent,
  type Scores,
  type ScoreSubmission,
  SSEClient,
} from "./types.ts";

// ============================================================================
// SESSION
// ============================================================================

// How long judges have to score once scoring opens. Read at use so it can be
// set per environment (JUDGE_SCORE_TIMEOUT_MS); the judge page nudges at 30s.
const DEFAULT_SCORE_TIMEOUT_MS = 60_000;
function scoreTimeout(): number {
  const n = Number(Deno.env.get("JUDGE_SCORE_TIMEOUT_MS"));
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SCORE_TIMEOUT_MS;
}
// Optional cap on a performance (0 = wait for the DJ as long as it takes).
function performanceTimeout(): number {
  const n = Number(Deno.env.get("PERFORMANCE_TIMEOUT_MS"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The session was stopped from outside (administrator, server shutdown). */
export class SessionAbortedError extends Error {
  constructor(reason = "session aborted") {
    super(reason);
    this.name = "SessionAbortedError";
  }
}
/** An administrator chose to stop waiting for clients that have not connected. */
class SkipWaitError extends Error {}
/** Scoring was closed before every judge submitted. */
class ScoringClosedError extends Error {}

/** A judge score that never arrived. */
export interface IncompleteScore {
  competition_id: number;
  competitor_id: number;
  judge_id: number;
  reason: "timeout" | "closed" | "absent";
}

const isJudge = (clientId: string) => clientId.startsWith("judge");
const isDj = (clientId: string) => clientId.startsWith("dj");
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
  /** Persist progress (status, current pointers). Best effort: failures are logged. */
  recordProgress?: (event: ProgressEvent) => Promise<void>;
  /**
   * Before the first competition the session waits until the DJ page reports it
   * holds the session's audio (`expectedDigest`, "" = no audio to wait for).
   * `reported` is the last digest that DJ reported, if any.
   */
  audioGate?: {
    expectedDigest(): Promise<string>;
    reported(djId: string): string | undefined;
  };
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
  /** Judge scores that never arrived (timed out, closed early, or judge absent). */
  incomplete: IncompleteScore[] = [];
  endReason: "completed" | "aborted" | "error" | null = null;
  /** Clients the session is currently waiting to connect. */
  waitingFor: string[] = [];

  private runController: AbortController | null = null;
  private waitController: AbortController | null = null;
  private scoreController: AbortController | null = null;
  /** Judges the operator chose to go on without for the current competition. */
  private excusedJudges = new Set<number>();
  /** Clients the operator chose to stop waiting for (not waited for again). */
  private skippedClients = new Set<string>();

  constructor(
    public id: number,
    private deps: SessionDependencies,
  ) {
  }

  /** Progress writes run in order; a failure never disturbs the session. */
  private progressChain: Promise<void> = Promise.resolve();
  private progress(event: ProgressEvent): void {
    const record = this.deps.recordProgress;
    if (!record) return;
    this.progressChain = this.progressChain
      .then(() => record(event))
      .catch((err) =>
        console.error(`progress write failed (${event.kind}):`, err)
      );
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
      return {
        kind: "closed",
        message: "not accepting scores for this competitor",
      };
    }
    const judge = comp.rubric.judges.find((j) => j.id === judgeId);
    if (!judge) {
      return {
        kind: "forbidden",
        message: "judge is not part of this competition",
      };
    }
    const expected = [...judge.criteria].sort((a, b) => a - b);
    const got = scores.map((s) => s.criteria_id).sort((a, b) => a - b);
    if (
      expected.length !== got.length || expected.some((id, i) => id !== got[i])
    ) {
      return {
        kind: "invalid",
        message:
          `expected exactly one score for each of criteria [${expected}]`,
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

  /** Aborted when the session is stopped; a fresh signal when not running. */
  private get signal(): AbortSignal {
    return this.runController?.signal ?? new AbortController().signal;
  }

  /**
   * Wait for the given clients to connect. An administrator can `skip()` the
   * wait: the session then goes on without whoever is missing (missing judges
   * are excused for this competition). Stopping the session throws.
   */
  private async waitForClients(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    console.log("Session: waiting for clients", { ids });
    const skip = new AbortController();
    this.waitController = skip;
    this.waitingFor = [...ids];
    try {
      const signal = AbortSignal.any([this.signal, skip.signal]);
      await Promise.allSettled(
        ids.map((id) => waitForTag(requiredTag(id), 0, signal)),
      );
    } finally {
      this.waitController = null;
      this.waitingFor = [];
    }
    this.signal.throwIfAborted();
    if (skip.signal.aborted) {
      for (const id of ids) {
        if (this.clients.get(id)) continue;
        console.warn(`Session ${this.id}: going on without ${id}`);
        this.skippedClients.add(id);
        if (isJudge(id)) this.excusedJudges.add(Number(id.slice(5)));
      }
      return;
    }
    console.log("Session: all clients connected", { ids });
  }

  /** Set while the session waits for a DJ to report its audio is in place. */
  private awaitingAudio: string | null = null;

  /**
   * The DJ page says it holds (and has verified) the audio set with `digest`.
   * Releases the start gate if that is the set the session expects.
   */
  async audioReported(djId: string, digest: string): Promise<void> {
    if (this.awaitingAudio !== djId) return;
    const expected = await this.deps.audioGate?.expectedDigest();
    if (expected && digest === expected && this.awaitingAudio === djId) {
      resolveTag(requiredTag(`audio:${djId}`), undefined);
    }
  }

  /** Hold the start until the track's DJ has the audio (operator can skip). */
  private async awaitAudioReady(djIds: string[]): Promise<void> {
    const gate = this.deps.audioGate;
    const dj = djIds.find(isDj);
    if (!gate || !dj) return;
    const expected = await gate.expectedDigest();
    if (!expected || gate.reported(dj) === expected) return;
    console.log(`Session ${this.id}: waiting for ${dj} to hold the audio`);
    this.awaitingAudio = dj;
    try {
      await this.waitForClients([`audio:${dj}`]);
    } finally {
      this.awaitingAudio = null;
    }
  }

  /**
   * Wait for all registered clients to connect
   */
  async requireAllClients(): Promise<void> {
    const disconnected = [...this.clients.entries()]
      .filter(([id, client]) => !client && !this.skippedClients.has(id))
      .map(([id]) => id);
    await this.waitForClients(disconnected);
  }

  /**
   * Wait for specific clients to connect (by client ID)
   */
  async require(clientIds: string[]): Promise<void> {
    await this.waitForClients(
      clientIds.filter((id) =>
        (!this.clients.has(id) || !this.clients.get(id)) &&
        !this.skippedClients.has(id)
      ),
    );
  }

  // --- operator controls ----------------------------------------------------

  /**
   * Stop the session now: pending waits are cancelled, clients are told it
   * ended, and everyone goes back to the unassigned pool. Returns false if it
   * is not running.
   */
  abort(reason = "aborted by administrator"): boolean {
    if (
      !this.running || !this.runController || this.runController.signal.aborted
    ) {
      return false;
    }
    console.warn(`Session ${this.id}: ${reason}`);
    this.endReason = "aborted";
    this.runController.abort(new SessionAbortedError(reason));
    return true;
  }

  /**
   * Stop waiting for whatever the session is stuck on:
   *  - "waiting":     clients that have not connected (their judges are excused)
   *  - "performance": the DJ's performance (treated as skipped; DJ playback stops)
   *  - "scoring":     judges who have not submitted (scoring closes now)
   * Returns what was skipped, or undefined if nothing is pending.
   */
  skip(): "waiting" | "performance" | "scoring" | undefined {
    if (this.waitController && !this.waitController.signal.aborted) {
      this.waitController.abort(new SkipWaitError());
      return "waiting";
    }
    const competition = this.currentCompetition;
    if (this.currentPhase === "performing" && competition) {
      const at = {
        competition_id: competition.id,
        position: this.currentPosition,
      };
      this.broadcast({ event: "performance_skipped", ...at }, isDj);
      resolveTag(perfTag(at.competition_id, at.position), false);
      return "performance";
    }
    if (
      this.currentPhase === "scoring" && this.scoreController &&
      !this.scoreController.signal.aborted
    ) {
      this.scoreController.abort(new ScoringClosedError());
      return "scoring";
    }
    return undefined;
  }

  /** What the operator needs to see: where the session is and what it waits for. */
  status() {
    const competition = this.currentCompetition;
    const waitingFor = this.waitingFor.length > 0
      ? [...this.waitingFor]
      : this.currentPhase === "scoring" && competition
      ? competition.rubric.judges
        .filter((j) =>
          !this.submittedScores.has(
            `${competition.id}:${this.currentPosition}:${j.id}`,
          )
        )
        .map((j) => `judge${j.id}`)
      : [];
    return {
      id: this.id,
      track_id: this.trackId ?? null,
      running: this.running,
      phase: this.currentPhase,
      competition_id: competition?.id ?? null,
      competition_name: competition?.name ?? null,
      position: this.currentPosition,
      connected: [...this.clients].filter(([, c]) => c).map(([id]) => id),
      waiting_for: waitingFor,
      incomplete: this.incomplete,
    };
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
    this.progress({
      kind: "competitor_started",
      competitionId: competition.id,
      competitorId: competition.competitors[position].id,
    });

    // Send performance start to DJ and all clients
    this.broadcast({
      event: "performance_start",
      competition_id: competition.id,
      position,
    });

    // Wait for DJ to signal completion (tag: perf:competitionId:position).
    // Ends early if an administrator skips it or stops the session.
    try {
      return await waitForTag(
        perfTag(competition.id, position),
        performanceTimeout(),
        this.signal,
      );
    } finally {
      this.currentPhase = "idle";
    }
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
   * Scoring phase - judges submit scores for competitor.
   * Ends when every expected judge has submitted, the time limit passes, an
   * administrator closes scoring, or the session is stopped. Judges whose score
   * never arrived are recorded in `incomplete` and told the window closed.
   */
  private async scorePhase(competition: Competition): Promise<void> {
    this.currentPhase = "scoring";
    const position = this.currentPosition;
    const competitor = competition.competitors[position];

    // Only judges score.
    this.broadcast({
      event: "enable_scoring",
      competition_id: competition.id,
      position,
    }, isJudge);

    const closer = new AbortController();
    this.scoreController = closer;
    const signal = AbortSignal.any([this.signal, closer.signal]);

    const record = (
      judge_id: number,
      reason: IncompleteScore["reason"],
    ) => {
      this.incomplete.push({
        competition_id: competition.id,
        competitor_id: competitor.id,
        judge_id,
        reason,
      });
    };

    const scorePromises = competition.rubric.judges.map(async ({ id }) => {
      // A judge the operator went on without stays excused unless they showed up.
      if (this.excusedJudges.has(id) && !this.clients.get(`judge${id}`)) {
        record(id, "absent");
        return { success: false };
      }
      try {
        const scores = await waitForTag(
          scoreTag(competition.id, competitor.id, id),
          scoreTimeout(),
          signal,
        );

        // Mark as submitted before saving
        this.submittedScores.add(`${competition.id}:${position}:${id}`);

        // Save to database
        const submission: ScoreSubmission = {
          competition_id: competition.id,
          competitor_id: competitor.id,
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
        if (this.signal.aborted) return { success: false }; // stopping, not a miss
        const closed = err instanceof ScoringClosedError;
        console.warn(
          `judge${id} ${closed ? "closed out" : "timeout or error"}:`,
          err,
        );
        record(id, closed ? "closed" : "timeout");
        return { success: false };
      }
    });

    try {
      await Promise.allSettled(scorePromises);
    } finally {
      this.scoreController = null;
    }
    this.signal.throwIfAborted();

    const missing = competition.rubric.judges
      .map((j) => j.id)
      .filter((id) =>
        !this.submittedScores.has(`${competition.id}:${position}:${id}`)
      );
    if (missing.length > 0) {
      console.warn(`${missing.length} judge(s) did not score`, { missing });
      this.broadcast({
        event: "scoring_closed",
        competition_id: competition.id,
        position,
        missing_judge_ids: missing,
      }, isJudge);
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
    this.progress({
      kind: "competition_started",
      competitionId: competition.id,
    });
    this.broadcast({
      event: "competition_start",
      competition,
    });
  }

  /**
   * Main session execution loop
   * @param competitions - Array of competitions to run
   * @param permanentClientIds - Client IDs that stay for entire session (DJ, scoreboards)
   * @param finished - "competitionId:competitorId" keys already done in an earlier
   *   run (see resume.ts); they are not run again, and a competition with nothing
   *   left is left out altogether. Positions stay those of the full list.
   */
  async runSession(
    allCompetitions: Competition[],
    permanentClientIds: string[], // the track's DJ and scoreboard
    finished: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    const competitions = allCompetitions.filter((c) =>
      c.competitors.some((p) => !finished.has(finishedKey(c.id, p.id)))
    );
    const allCompetitionCount = allCompetitions.length;
    if (this.running) {
      throw new Error(`Session ${this.id} already running`);
    }

    if (!allCompetitions || allCompetitionCount === 0) {
      throw new Error(`No competitions provided for session ${this.id}`);
    }

    this.running = true;
    this.runController = new AbortController();
    this.endReason = null;
    this.incomplete = [];
    this.excusedJudges.clear();
    this.skippedClients.clear();
    this.submittedScores.clear();
    this.progress({ kind: "session_started", resume: finished.size > 0 });

    console.log(
      `Starting session ${this.id} (competitions=${competitions.length}, already finished=${finished.size}, permanent clients=${permanentClientIds})`,
    );

    try {
      // Register permanent clients (DJ, scoreboards, etc.)
      this.registerPermanentClients(permanentClientIds);

      // Wait for all permanent clients to connect
      await this.require(permanentClientIds);
      console.log(`All permanent clients connected for session ${this.id}`);
      await this.awaitAudioReady(permanentClientIds);

      // Iterate through competitions in order
      for (const [index, competition] of competitions.entries()) {
        this.signal.throwIfAborted();
        // The operator decides per competition whether to go on without a judge.
        this.excusedJudges.clear();
        for (const id of this.skippedClients) {
          if (isJudge(id)) this.skippedClients.delete(id);
        }

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
          this.signal.throwIfAborted();
          if (finished.has(finishedKey(competition.id, competitor.id))) {
            continue;
          }
          let performed = false;
          try {
            const performanceCompleted = await this.performPhase(
              competition,
              position,
            );

            if (performanceCompleted) {
              performed = true;
              this.progress({
                kind: "competitor_performed",
                competitionId: competition.id,
                competitorId: competitor.id,
              });
              await this.scorePhase(competition);
            } else {
              // The DJ skipped it (or an administrator did): no scoring, and
              // the session goes on with the next competitor.
              console.log(
                `Competitor at position ${position} skipped, no scoring`,
              );
              this.progress({
                kind: "competitor_skipped",
                competitionId: competition.id,
                competitorId: competitor.id,
              });
            }
          } catch (err) {
            if (this.signal.aborted) throw err; // stopping: not a per-competitor error
            // Never performed (the DJ's answer never came, or playback broke):
            // record it as skipped rather than leaving it looking upcoming.
            if (!performed) {
              this.progress({
                kind: "competitor_skipped",
                competitionId: competition.id,
                competitorId: competitor.id,
              });
            }
            console.error("Error during competitor", {
              competitionId: competition.id,
              competitorId: competitor.id,
              position,
              err,
            });
          } finally {
            this.currentPhase = "idle";
            this.submittedScores.clear();
          }
        }

        this.progress({
          kind: "competition_completed",
          competitionId: competition.id,
        });
        // Competition over: nothing to replay to clients connecting between
        // competitions
        this.currentCompetition = null;
        this.currentPosition = -1;
        this.currentScores = [];

        // Clean up clients not needed for next competition. After the last one
        // everyone is released by reset(), once they have been told it ended.
        const nextCompetition = competitions[index + 1];
        if (nextCompetition) {
          this.clearUnneededClients(nextCompetition, permanentClientIds);
        }
      }

      this.endReason = "completed";
      console.log(`Session ${this.id} completed successfully`);
    } catch (err) {
      if (err instanceof SessionAbortedError) {
        this.endReason = "aborted";
        console.warn(`Session ${this.id} stopped: ${err.message}`);
      } else {
        this.endReason = "error";
        console.error(`Session ${this.id} error:`, err);
        throw err;
      }
    } finally {
      // Tell everyone how it ended before clients are released.
      this.announceEnd();
      this.reset();
      this.progress({
        kind: "session_ended",
        reason: this.endReason ?? "error",
      });
      await this.progressChain;
      console.log(`Session ${this.id} reset complete`);
    }
  }

  /**
   * Tell everyone the session is over: connected clients, and judges the
   * session is holding who are parked in the unassigned pool between
   * competitions.
   */
  private announceEnd(): void {
    const message: ServerToClientMessage = {
      event: "session_end",
      reason: this.endReason ?? "error",
      incomplete: this.incomplete.length,
    };
    this.broadcast(message);
    for (const id of this.claimedClients) {
      const parked = this.deps.unassignedClients.get(id);
      if (parked && !this.clients.get(id)) this.sendToClient(parked, message);
    }
  }

  /**
   * Reset session state after completion
   */
  private reset(): void {
    this.running = false;
    this.runController = null;
    this.waitController = null;
    this.scoreController = null;
    this.waitingFor = [];
    this.excusedJudges.clear();
    this.skippedClients.clear();
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
