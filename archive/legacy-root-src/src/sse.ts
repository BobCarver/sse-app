// src/sse/handlers.ts
import type { SSEStreamingApi } from "hono/streaming";
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
  let pingInterval: number | undefined;

  console.log(
    `SSE connection established for client ${clientId} (${clientType})`,
  );

  try {
    client = createClient(stream, clientId);
    registerClient(client, dependencies);
    pingInterval = startPing(stream, clientId, signal);

    await waitForDisconnect(signal);
    console.log(`Client ${clientId} disconnected`);
  } catch (error) {
    console.error(`SSE error for client ${clientId}:`, error);
    throw error;
  } finally {
    cleanup(clientId, pingInterval, dependencies);
  }
}

/**
 * Create an SSE client with stream controller
 */
function createClient(
  stream: SSEStreamingApi,
  id: string,
): SSEClient {
  return {
    id,
    controller: {
      enqueue: (chunk: string) => {
        stream.write(chunk).catch((err) => {
          console.error(`Write failed for client ${id}:`, err);
          console.log(
            `Client ${id} connection appears broken, awaiting disconnect signal`,
          );
        });
      },
    },
  };
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
): number {
  const interval = setInterval(() => {
    if (signal.aborted) {
      clearInterval(interval);
      return;
    }

    stream.write(": ping\n\n").catch((err) => {
      console.warn(`Ping failed for client ${clientId}:`, err);
    });
  }, 30000);

  return interval as number;
}

/**
 * Wait for client disconnect via abort signal
 */
function waitForDisconnect(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * Clean up client registration and ping interval
 * IMPORTANT: This marks client as disconnected but keeps the slot
 */
function cleanup(
  clientId: string,
  pingInterval: number | undefined,
  { SessionManager, unassignedClients }: SSEDependencies,
): void {
  clearInterval(pingInterval);

  try {
    const session = SessionManager.findSessionForClient(clientId);
    if (session) {
      // Mark client as disconnected (keep the slot)
      session.disconnectClient(clientId);
    }
  } catch (err) {
    console.warn(`Cleanup: couldn't find session for ${clientId}:`, err);
  }

  // Remove from unassigned pool
  unassignedClients.delete(clientId);
  console.log(`SSE: cleaned up client ${clientId}`);
}
