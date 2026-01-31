// src/test/frontend/sse-mocks.ts
// Extracted mock sse and SSE implementations for frontend tests
// Auto-generated for convenience on 2026-01-03

/**
 * Base mock sse client with event handling capabilities.
 * Can be extended or composed for specific test scenarios.
 */
// deno-lint-ignore-file no-explicit-any ban-types
export class BaseMockWebSocketClient {
  private handlers = new Map<string, Function[]>();

  on(event: string, handler: Function) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, []);
    }
    this.handlers.get(event)!.push(handler);
    return this;
  }

  trigger(event: string, data: any) {
    const handlers = this.handlers.get(event);
    if (handlers) {
      handlers.forEach((h) => h(data));
    }
  }

  disconnect() {}
}

/**
 * Generic mock used by `websocket-client-test.ts`
 */
export class MockWebSocketClient extends BaseMockWebSocketClient {
  public disconnectCalled = false;

  override disconnect() {
    this.disconnectCalled = true;
  }

  send() {}
}

/**
 * Mock used by `judge-test.ts`
 */
export class MockWebSocketClientForJudge extends BaseMockWebSocketClient {
  public submitScoreCalled = false;
  public lastSubmittedScore: any = null;

  submitScore(score: any) {
    this.submitScoreCalled = true;
    this.lastSubmittedScore = score;
  }
}

/**
 * Mock used by `dj-test.ts` (includes send/completePerformance semantics)
 */
export class MockWebSocketClientForDj extends BaseMockWebSocketClient {
  public completePerformanceCalled = false;
  public lastPerformanceCompetitorId: number | null = null;
  public lastPerformanceCompleted: boolean | null = null;
  public sentMessages: any[] = [];

  completePerformance(competitorId: number, completed: boolean) {
    this.completePerformanceCalled = true;
    this.lastPerformanceCompetitorId = competitorId;
    this.lastPerformanceCompleted = completed;
  }

  send(message: any) {
    this.sentMessages.push(message);
  }
}

/**
 * Minimal mock used by `scoreboard-di-test.ts`
 */
export class MockWebSocketClientForScoreboard extends BaseMockWebSocketClient {}

// ============================================================================
// EventSource (SSE) Mock
// ============================================================================

/**
 * Minimal in-memory EventSource mock suitable for frontend tests.
 * Supports `addEventListener(event, handler)` and `removeEventListener`.
 *
 * Behavior notes:
 * - For name d events (e.g., "competition_start") handlers will be invoked with
 *   the JSON string for the payload object.
 */
export class MockEventSource {
  private handlers = new Map<string, Set<Function>>();
  url?: string;

  constructor(url?: string) {
    this.url = url;
  }

  addEventListener(type: string, handler: (ev: any) => void) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: (ev: any) => void) {
    this.handlers.get(type)?.delete(handler);
  }

  close() {
    this.handlers.clear();
  }

  /**
   * Trigger a named server event. For named events, the handler is invoked
   * with the JSON string for the object . For 'message' handlers the handler
   * receives a MessageEvent-like object with a `data` string.
   */
  emit(event: string, payload: Record<string, unknown> = {}) {
    // Build the MessageEvent-like data string (matching browser behavior)
    const data = JSON.stringify(payload);

    // Notify handlers registered for the specific event name with a MessageEvent-like object.
    const handlers = this.handlers.get(event);
    if (handlers) {
      for (const h of handlers) {
        try {
          h({ data });
        } catch (_e) {
          // ignore handler errors in test harness
        }
      }
    }

    // Do NOT call 'message' handlers for named events (per SSE spec).
    // If you want to simulate a plain 'message' event, call emit('message', {...}).
  }
}
