// test/dj-test.ts
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertExists } from "@std/assert";
import { DOMParser } from "b-fuze/deno-dom";
import { DjClient } from "../../frontend-src/dj.ts";

// Guidance: This test uses the shared mock WebSocket clients available in
// `src/test/websocket-mocks.ts`. We import the DJ-specific mock
// `MockWebSocketClientForDj`  for
// dependency injection; extend `BaseMockWebSocketClient` in the mocks file if
// you need more specialized behavior.

import { MockEventSource } from "./sse-mocks.ts";
import { interceptFetch, stubFetchNoop } from "./fetch-mock.ts";
import { applyStyleShim, applyTableShims } from "./test-utils.ts";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

class MockAudio {
  public src: string = "";
  public paused: boolean = true;
  public currentTime: number = 0;
  public onended: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public playCallCount: number = 0;
  public pauseCallCount: number = 0;
  public shouldFailPlay: boolean = false;
  public shouldFailOnError: boolean = false;

  // deno-lint-ignore require-await
  async play(): Promise<void> {
    this.playCallCount++;
    if (this.shouldFailPlay) {
      throw new Error("Play failed");
    }
    this.paused = false;

    if (this.shouldFailOnError && this.onerror) {
      setTimeout(() => this.onerror!(), 0);
    }
  }

  pause(): void {
    this.pauseCallCount++;
    this.paused = true;
  }

  // Helper to simulate audio ending
  triggerEnded(): void {
    if (this.onended) {
      this.onended();
    }
  }

  // Helper to simulate audio error
  triggerError(): void {
    if (this.onerror) {
      this.onerror();
    }
  }
}

function createTestDOM(): Document {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html>
    <html>
      <body>
        <div id="status">disconnected</div>
        <button id="start">play</button>
        <button id="skip">skip</button>
        <table id="compTable">
          <tbody id="tbody"></tbody>
        </table>
      </body>
    </html>`,
    "text/html",
  ) as any;
  // Apply shared shims
  applyStyleShim(doc);
  applyTableShims(doc);
  return doc;
}

Deno.test("DjClient initializes with dependencies", () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  const deps: any = {
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  };
  const dj = new DjClient(deps);

  assertExists(dj);

  const startButton = doc.querySelector("#start") as any;
  const skipButton = doc.querySelector("#skip") as any;

  assertExists(startButton);
  assertExists(skipButton);
  assertEquals(startButton.disabled, true);
  assertEquals(skipButton.disabled, true);
});

Deno.test("DjClient start/pause button toggles audio playback", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  const deps: any = {
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  };
  new DjClient(deps);

  const startButton = doc.querySelector("#start") as any;

  // Initially paused
  assertEquals(mockAudio.paused, true);
  assertEquals(startButton.innerText, "play");

  // Click to play (enable first so events are processed like a real user click)
  startButton.disabled = false;
  (startButton as any).onclick?.();

  await delay(10);

  assertEquals(mockAudio.playCallCount, 1);
  assertEquals(startButton.innerText, "pause");

  // Click to pause
  (startButton as any).onclick?.();

  // initialState calls pause once during setup, so total should be 2 after pause click
  assertEquals(mockAudio.pauseCallCount, 2);
  assertEquals(startButton.innerText, "play");
});

Deno.test("DjClient handles performance_start with announcement and music", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  const fetchStub = interceptFetch();
  const deps: any = {
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  };
  new DjClient(deps);

  const competition = {
    id: 100,
    name: "Test Competition",
    competitors: [
      { id: 10, name: "Competitor 1", duration: 120000 },
      { id: 11, name: "Competitor 2", duration: 180000 },
    ],
    rubric: { id: 1, judges: [], criteria: [] },
  };

  mockSse.emit("competition_start", { competition });

  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  // Simulate announcement ending
  mockAudio.triggerEnded();
  await delay(0);
  // Simulate music ending
  mockAudio.triggerEnded();
  await delay(0);

  // Check that announcement was played
  //assert(mockAudio.src.includes("100-10-announce"));

  // Check that completePerformance was called via fetch
  const f = fetchStub.getLastFetch();
  assert(f !== null);
  assertEquals(
    f!.url,
    "http://localhost/response",
  );
  assertEquals(f!.body.tag, "performance:100:10");
  assertEquals(f!.body.completed, true);

  fetchStub.restore();
});

Deno.test("DjClient enables buttons during music playback", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  // prevent outbound network calls during test
  const noopFetch = stubFetchNoop();

  const deps: any = {
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  };
  new DjClient(deps);

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120000 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };

  mockSse.emit("competition_start", { competition });

  const startButton = doc.querySelector("#start") as any;
  const skipButton = doc.querySelector("#skip") as any;

  // Initially disabled
  assertEquals(startButton.disabled, true);
  assertEquals(skipButton.disabled, true);

  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  // After announcement ends
  mockAudio.triggerEnded();

  await delay(0);
  // Check buttons are enabled during music
  assertEquals(startButton.disabled, false);
  assertEquals(skipButton.disabled, false);

  // End music
  mockAudio.triggerEnded();
  await delay(0);

  noopFetch.restore();
});

Deno.test("DjClient handles skip button during music playback", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  const fetchStub = interceptFetch();

  new DjClient({
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  });

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120000 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };

  mockSse.emit("competition_start", { competition });

  const skipButton = doc.querySelector("#skip") as any;

  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  // End announcement
  mockAudio.triggerEnded();
  await delay(0);
  (skipButton as any).onclick?.();
  await delay(0);

  // Check that completePerformance was called with skipped=false via fetch
  const f = fetchStub.getLastFetch();
  assert(f !== null);
  assertEquals(
    f!.url,
    "http://localhost/response",
  );
  assertEquals(f!.body.tag, "performance:100:10");
  assertEquals(f!.body.completed, false);

  fetchStub.restore();
});

Deno.test("DjClient resets to initial state after performance", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  // Prevent outbound network calls during the performance flow
  const noopFetch = stubFetchNoop();

  new DjClient({
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  });

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120000 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };

  mockSse.emit("competition_start", { competition });

  const startButton = doc.querySelector("#start") as any;
  const skipButton = doc.querySelector("#skip") as any;

  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  mockAudio.triggerEnded(); // End announcement
  await delay(0);
  mockAudio.triggerEnded(); // End music
  await delay(0);

  // Check initial state restored
  assertEquals(startButton.disabled, true);
  assertEquals(skipButton.disabled, true);
  assertEquals(startButton.innerText, "play");
  assertEquals(mockAudio.onended, null);
  assertEquals(mockAudio.onerror, null);
  assertEquals(skipButton.onclick, null);

  noopFetch.restore();
});

Deno.test("DjClient handles audio playback error", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  mockAudio.shouldFailPlay = true;

  const fetchStub = interceptFetch();

  new DjClient({
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  });

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120000 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };

  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });

  await delay(100);

  // Check error message was sent via fetch
  const f = fetchStub.getLastFetch();
  assert(f !== null);
  assertEquals(f!.url, "http://localhost/response");
  assertEquals(f!.body.tag, "error:Play failed");

  fetchStub.restore();
});

Deno.test("DjClient handles audio error event", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  mockAudio.shouldFailOnError = true;

  const fetchStub = interceptFetch();

  new DjClient({
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  });

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120000 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };

  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });

  await delay(100);

  // Check error message was sent via fetch
  const f = fetchStub.getLastFetch();
  assert(f !== null);
  assertEquals(f!.url, "http://localhost/response");
  assertEquals(f!.body.tag, "error:audio_error");

  fetchStub.restore();
});

Deno.test("DjClient plays correct audio sources", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  // Prevent outbound network calls during the performance flow
  stubFetchNoop();

  new DjClient({
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  });

  const competition = {
    id: 555,
    competitors: [{ id: 777, name: "Competitor 1", duration: 120000 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };

  mockSse.emit("competition_start", { competition });

  mockSse.emit("performance_start", { position: 0 });
  await delay(50);
  const announceSrc = mockAudio.src;
  mockAudio.triggerEnded(); // End announcement
  await delay(50);
  const musicSrc = mockAudio.src;
  mockAudio.triggerEnded(); // End music
  await delay(100);
  assertEquals(announceSrc, "555-777-announce");
  assertEquals(musicSrc, "555-777-music");
});

Deno.test("DjClient destroy cleans up", () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();

  const fetchStub = interceptFetch();

  const dj = new DjClient({
    document: doc,
    sse: mockSse as any,
    audio: mockAudio as any,
  });

  dj.destroy();

  assert(fetchStub.getLastFetch() === null);

  fetchStub.restore();

  const startButton = doc.querySelector("#start") as any;
  const skipButton = doc.querySelector("#skip") as any;

  assertEquals(startButton.disabled, true);
  assertEquals(skipButton.disabled, true);
});
