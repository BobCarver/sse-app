// tests/e2e/setup.ts
import { delay } from "../test-utils.ts";
import { TestEventSource } from "./test-event-source.ts";

export interface TestServer {
  url: string;
  port: number;
  process: Deno.ChildProcess;
}

export async function startTestServer(): Promise<TestServer> {
  const port = 3001;

  const command = new Deno.Command("deno", {
    args: [
      "run",
      "--allow-net",
      "--allow-env",
      "--allow-read",
      "src/main.ts",
    ],
    env: {
      PORT: port.toString(),
      DATABASE_URL: "postgres://test:test@localhost:5432/test_db",
      JUDGE_SCORE_TIMEOUT_MS: "5000",
    },
    stdout: "piped",
    stderr: "piped",
  });

  const process = command.spawn();
  await waitForServer(`http://localhost:${port}`, 5000);

  return { url: `http://localhost:${port}`, port, process };
}

export async function stopTestServer(server: TestServer): Promise<void> {
  server.process.kill("SIGTERM");
  await server.process.status;
}

async function waitForServer(url: string, timeout: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      const response = await fetch(`${url}/_health`);
      if (response.ok) return;
    } catch {
      // Not ready
    }
    await delay(100);
  }

  throw new Error(`Server did not start within ${timeout}ms`);
}

/**
 * SSE client for testing - simplified for actual usage
 */
export class TestSSEClient {
  private eventSource: TestEventSource | null = null;
  private messages: Array<{ event: string; data: any }> = [];
  private connected = false;

  constructor(
    public clientId: string,
    public clientType: "dj" | "judge" | "sb",
    private serverUrl: string,
  ) {}

  async connect(sessionId: number): Promise<void> {
    return new Promise((resolve, reject) => {
      // Initialize EventSource connection the session_token as cookie
      this.eventSource = new TestEventSource(
        `${this.serverUrl}/events`,
        {
          headers: {
            "Cookie": `session_token=${this.clientId}`,
          },
        },
      );

      this.eventSource.onopen = () => {
        this.connected = true;
        resolve();
      };

      this.eventSource.onerror = () => {
        if (!this.connected) {
          reject(new Error("Failed to connect to SSE"));
        }
      };

      // Register listeners for all event types your tests use
      const eventTypes = [
        "client_status",
        "competition_start",
        "performance_start",
        "performance_recovery",
        "enable_scoring",
        "score_update",
      ];

      for (const eventType of eventTypes) {
        this.eventSource.addEventListener(eventType, (e: MessageEvent) => {
          this.messages.push({
            event: eventType,
            data: JSON.parse(e.data),
          });
        });
      }

      // Connection timeout
      delay(5000).then(() => {
        if (!this.connected) {
          reject(new Error("Connection timeout"));
        }
      });
    });
  }

  disconnect(): void {
    this.eventSource?.close();
    this.connected = false;
  }

  async waitForMessage(eventType: string, timeout = 5000): Promise<any> {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const message = this.messages.find((m) => m.event === eventType);
      if (message) {
        this.messages = this.messages.filter((m) => m !== message);
        return message.data;
      }
      await delay(50);
    }

    throw new Error(`Timeout waiting for message: ${eventType}`);
  }

  getMessages(eventType?: string): Array<{ event: string; data: any }> {
    return eventType
      ? this.messages.filter((m) => m.event === eventType)
      : [...this.messages];
  }

  clearMessages(): void {
    this.messages = [];
  }

  async completePerformance(
    sessionId: number,
    competitionId: number,
    position: number,
    played: boolean,
  ): Promise<void> {
    const tag = `perf:${competitionId}:${position}`;
    const response = await fetch(`${this.serverUrl}/response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, payload: played }),
    });

    if (!response.ok) {
      throw new Error(`Failed to complete performance: ${response.statusText}`);
    }
  }

  async submitScores(
    sessionId: number,
    competitionId: number,
    competitorId: number,
    scores: Array<{ criteria_id: number; score: number }>,
  ): Promise<void> {
    const judgeNumericId = this.clientId.replace(/^\D+/, "");
    const tag = `score:${competitionId}:${competitorId}:${judgeNumericId}`;
    const response = await fetch(`${this.serverUrl}/response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag, payload: scores }),
    });

    if (!response.ok) {
      throw new Error(`Failed to submit scores: ${response.statusText}`);
    }
  }
}
