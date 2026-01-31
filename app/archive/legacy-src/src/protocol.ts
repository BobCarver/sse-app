/**
 * SSE Protocol for Competition Management System
 *
 * Design principles:
 * - One SSE connection per client per active session
 * - All required clients must be connected before competition starts
 * - System waits for reconnections during active scoring
 * - Scores submitted once per competitor, no revisions
 * - Real-time score updates as judges submit
 * - State-based recovery instead of event replay
 */
import { Competition } from "./types.ts";

// ============================================================================
// BASE MESSAGE TYPES
// ============================================================================

interface BaseMessage {
  event: string;
}

// ============================================================================
// CONNECTION MESSAGES
// ============================================================================

// SERVER -> ALL CLIENTS: Broadcast client status changes
export interface ClientStatusMessage extends BaseMessage {
  event: "client_status";
  connected_clients: string[];
}

// ============================================================================
// COMPETITION FLOW MESSAGES
// ============================================================================

// SERVER -> ALL CLIENTS: New competition starting
export interface CompetitionStartMessage extends BaseMessage {
  event: "competition_start";
  competition: Competition;
}

// ============================================================================
// PERFORMANCE FLOW MESSAGES
// ============================================================================

// SERVER -> ALL CLIENTS: Competitor performing now
export interface PerformanceStartMessage extends BaseMessage {
  event: "performance_start";
  competition_id: number;
  position: number; // ordinal position in competition
}

// SERVER -> DJ: Recovery message when DJ reconnects during performance
export interface PerformanceRecoveryMessage extends BaseMessage {
  event: "performance_recovery";
  competition_id: number;
  position: number;
}

// ============================================================================
// SCORING FLOW MESSAGES
// ============================================================================

// SERVER -> JUDGES: Enable score submission
export interface EnableScoringMessage extends BaseMessage {
  event: "enable_scoring";
  competition_id: number;
  position: number;
}

// SERVER -> SCOREBOARDS: Update with new score
export interface ScoreUpdateMessage extends BaseMessage {
  event: "score_update";
  competition_id: number;
  competitor_id: number;
  judge_id: number;
  scores: Array<{ criteria_id: number; score: number }>;
}

// ============================================================================
// HEARTBEAT & ERROR MESSAGES
// ============================================================================

export interface PingMessage {
  event: "ping";
}

interface ErrorMessage extends BaseMessage {
  event: "error";
  error_code: string;
  error_message: string;
  recoverable: boolean;
}

// ============================================================================
// MESSAGE UNION TYPES
// ============================================================================

// All server-to-client messages
export type ServerToClientMessage =
  | ClientStatusMessage
  | CompetitionStartMessage
  | PerformanceStartMessage
  | PerformanceRecoveryMessage
  | EnableScoringMessage
  | ScoreUpdateMessage
  | PingMessage
  | ErrorMessage;

// ============================================================================
// MESSAGE VALIDATION HELPERS
// ============================================================================

export function validateMessage(
  // deno-lint-ignore no-explicit-any
  msg: any,
): { valid: boolean; error?: string } {
  if (!msg || typeof msg !== "object") {
    return { valid: false, error: "Message must be an object" };
  }

  if (typeof msg.event !== "string") {
    return { valid: false, error: "Message event must be a string" };
  }

  if (msg.event === "ping") {
    return { valid: true };
  }

  return { valid: true };
}
