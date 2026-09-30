// src/sse/handlers.ts
import type { SSEStreamingApi } from "@hono/hono/streaming";
import type { ClientType, SSEClient } from "./types.ts";
import { SessionManager } from "./sessionManager.ts";

export interface SSEDependencies {
  // The SessionManager class (provides static helpers like findSessionForClient)
  SessionManager: typeof SessionManager;
  unassignedClients: Map<string, SSEClient>;
}

/**
 * Main SSE connection handler
 * The AbortSignal will fire when the connection is closed (network error, browser close, etc.)
 */
export async function handleSSEConnection(
  stream: SSEStreamingApi,
  signal: AbortSignal,
  clientId: string,
  clientType: ClientType,
  dependencies: SSEDependencies,
): Promise<void> {
  let client: SSEClient | null = null;
  let pingInterval: ReturnType<typeof setInterval> | undefined;

  console.log(
    `SSE connection established for client ${clientId} (${clientType})`,
  );

  try {
    client = createClient(stream, clientId, dependencies);
    registerClient(client, dependencies);
    pingInterval = startPing(stream, clientId, signal);

    await waitForDisconnect(signal);
    console.log(`Client ${clientId} disconnected`);
  } catch (error) {
    console.error(`SSE error for client ${clientId}:`, error);
    throw error;
  } finally {
    cleanup(client, clientId, pingInterval, dependencies);
  }
}

/**
 * Create an SSE client with stream controller
 */
function createClient(
  stream: SSEStreamingApi,
  id: string,
  { SessionManager, unassignedClients }: SSEDependencies,
): SSEClient {
  const client: SSEClient = {
    id,
    controller: {
      enqueue: (chunk: string) => {
        stream.write(chunk).catch((err) => {
          // The connection is dead even if the abort signal has not fired yet:
          // stop treating it as connected so the operator sees who is missing
          // (a reconnect will register a fresh connection).
          console.error(`Write failed for client ${id}:`, err);
          SessionManager.findSessionForClient(id)?.disconnectClient(id, client);
          if (unassignedClients.get(id) === client) unassignedClients.delete(id);
        });
      },
    },
  };
  return client;
}

/**
 * Register client with session or add to unassigned clients
 */
function registerClient(
  client: SSEClient,
  { SessionManager, unassignedClients }: SSEDependencies,
) {
  const session = SessionManager.findSessionForClient(client.id);

  if (session) {
    // Client has a registered slot in a session
    session.connectClient(client);
  } else {
    // Client not part of any session yet, add to unassigned pool
    console.log(
      `Client ${client.id} not assigned to session, adding to unassigned pool`,
    );
    const previous = unassignedClients.get(client.id);
    if (previous && previous !== client) {
      previous.controller.enqueue("event: superseded\ndata: {}\n\n");
    }
    unassignedClients.set(client.id, client);
  }
}

/**
 * Start periodic ping to keep connection alive
 */
function startPing(
  stream: SSEStreamingApi,
  clientId: string,
  signal: AbortSignal,
): ReturnType<typeof setInterval> {
  const interval = setInterval(() => {
    if (signal.aborted) {
      clearInterval(interval);
      return;
    }

    // A real event (not a ": comment") so browser clients can see it and use it
    // as a liveness signal.
    stream.write("event: ping\ndata: {}\n\n").catch((err) => {
      console.warn(`Ping failed for client ${clientId}:`, err);
    });
  }, 30000);

  return interval;
}

/**
 * Wait for client disconnect via abort signal
 */
function waitForDisconnect(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Clean up client registration and ping interval
 * IMPORTANT: This marks client as disconnected but keeps the slot
 */
function cleanup(
  client: SSEClient | null,
  clientId: string,
  pingInterval: ReturnType<typeof setInterval> | undefined,
  { SessionManager, unassignedClients }: SSEDependencies,
): void {
  clearInterval(pingInterval);

  try {
    const session = SessionManager.findSessionForClient(clientId);
    if (session) {
      // Mark client as disconnected (keep the slot) - only if this stream
      // still owns it; a newer connection may have replaced it already.
      session.disconnectClient(clientId, client ?? undefined);
    }
  } catch (err) {
    console.warn(`Cleanup: couldn't find session for ${clientId}:`, err);
  }

  // Remove from unassigned pool - only our own entry, never a replacement's
  if (!client || unassignedClients.get(clientId) === client) {
    unassignedClients.delete(clientId);
  }
  console.log(`SSE: cleaned up client ${clientId}`);
}
