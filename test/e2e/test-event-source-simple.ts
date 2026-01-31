// tests/e2e/test-event-source.ts

/**
 * Minimal EventSource implementation for Deno testing
 * Simplified based on actual test requirements
 */

export interface EventSourceOptions {
  cookies?: string;
  headers?: Record<string, string>;
}

export class TestEventSource {
  public readonly CONNECTING = 0;
  public readonly OPEN = 1;
  public readonly CLOSED = 2;

  public readyState: number = this.CONNECTING;

  private listeners = new Map<string, (event: MessageEvent) => void>();
  private abortController: AbortController | null = null;

  public onopen: ((event: Event) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;

  constructor(
    public readonly url: string,
    private options?: EventSourceOptions,
  ) {
    this.connect();
  }

  private async connect(): Promise<void> {
    this.abortController = new AbortController();

    try {
      const headers: Record<string, string> = {
        "Accept": "text/event-stream",
        ...this.options?.headers,
      };

      if (this.options?.cookies) {
        headers["Cookie"] = this.options.cookies;
      }

      const response = await fetch(this.url, {
        headers,
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      this.readyState = this.OPEN;
      this.onopen?.(new Event("open"));

      await this.processStream(response.body!);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;

      this.readyState = this.CLOSED;
      this.onerror?.(new Event("error"));
    }
  }

  private async processStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Split on double newlines (SSE message separator)
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const message of parts) {
          if (message.trim()) {
            this.parseAndDispatch(message);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private parseAndDispatch(raw: string): void {
    let eventType = "message";
    const dataLines: string[] = [];

    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // Comment

      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const field = line.substring(0, colonIdx);
      const value = line.substring(colonIdx + 1).replace(/^ /, "");

      if (field === "event") eventType = value;
      else if (field === "data") dataLines.push(value);
    }

    if (dataLines.length > 0) {
      const listener = this.listeners.get(eventType);
      if (listener) {
        listener(
          new MessageEvent(eventType, {
            data: dataLines.join("\n"),
          }),
        );
      }
    }
  }

  public addEventListener(
    type: string,
    listener: (event: MessageEvent) => void,
  ): void {
    this.listeners.set(type, listener);
  }

  public close(): void {
    this.readyState = this.CLOSED;
    this.abortController?.abort();
    this.abortController = null;
  }
}
