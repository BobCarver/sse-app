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
  private _src: string = "";
  // A real <audio> is paused after loading a new source and once a clip ends.
  get src(): string {
    return this._src;
  }
  set src(value: string) {
    this._src = value;
    this.paused = true;
  }
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
    this.paused = true;
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
      { id: 10, name: "Competitor 1", duration: 120 },
      { id: 11, name: "Competitor 2", duration: 180 },
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
  assertEquals(f!.body.tag, "perf:100:0");
  assertEquals(f!.body.payload, true);

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
    competitors: [{ id: 10, name: "Competitor 1", duration: 120 }],
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
    competitors: [{ id: 10, name: "Competitor 1", duration: 120 }],
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
  assertEquals(f!.body.tag, "perf:100:0");
  assertEquals(f!.body.payload, false);

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
    competitors: [{ id: 10, name: "Competitor 1", duration: 120 }],
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

Deno.test("DjClient: an announcement that fails to play does not fail the performance", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  mockAudio.shouldFailPlay = true; // the announcement cannot play
  const fetchStub = interceptFetch();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const startButton = doc.querySelector("#start") as any;

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };
  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });
  await delay(100);

  // the song is loaded and waits for play; nothing was reported as skipped
  assertEquals(mockAudio.src, "/audio/100/10/music");
  assertEquals(startButton.disabled, false);
  assertEquals(fetchStub.getLastFetch(), null);

  fetchStub.restore();
});

Deno.test("DjClient: an announcement that errors out does not fail the performance", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  mockAudio.shouldFailOnError = true; // e.g. 404 on the announcement
  const fetchStub = interceptFetch();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const startButton = doc.querySelector("#start") as any;

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };
  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });
  await delay(100);

  assertEquals(mockAudio.src, "/audio/100/10/music");
  assertEquals(startButton.disabled, false);
  assertEquals(fetchStub.getLastFetch(), null);

  fetchStub.restore();
});

Deno.test("DjClient: a song that errors out is reported as skipped", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  const fetchStub = interceptFetch();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const startButton = doc.querySelector("#start") as any;

  const competition = {
    id: 100,
    competitors: [{ id: 10, name: "Competitor 1", duration: 120 }],
    rubric: { id: 1, judges: [], criteria: [] },
  };
  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  mockAudio.triggerEnded(); // announcement over
  await delay(0);

  mockAudio.shouldFailOnError = true; // the song file is broken
  startButton.onclick();
  await delay(100);

  const f = fetchStub.getLastFetch();
  assert(f !== null);
  assertEquals(f!.body.tag, "perf:100:0");
  assertEquals(f!.body.payload, false);

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
    competitors: [{ id: 777, name: "Competitor 1", duration: 120 }],
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
  assertEquals(announceSrc, "/audio/555/777/announce");
  assertEquals(musicSrc, "/audio/555/777/music");
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

// --- the DJ controls the song --------------------------------------------------

/** A fetch whose reply is held back until `release()`, like a slow network. */
function slowFetch() {
  const original = globalThis.fetch;
  const calls: { url: string; body: any }[] = [];
  const waiting: Array<() => void> = [];
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Promise<Response>((resolve) =>
      waiting.push(() => resolve(new Response("{}", { status: 200 })))
    );
  };
  return {
    calls,
    release: () => waiting.splice(0).forEach((r) => r()),
    restore: () => (globalThis.fetch = original),
  };
}

const twoCompetitors = {
  id: 100,
  name: "Test Competition",
  competitors: [
    { id: 10, name: "Competitor 1", duration: 120 },
    { id: 11, name: "Competitor 2", duration: 120 },
  ],
  rubric: { id: 1, judges: [], criteria: [] },
};

Deno.test("DjClient: the song does not start by itself after the announcement", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  const noop = stubFetchNoop();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const startButton = doc.querySelector("#start") as any;

  mockSse.emit("competition_start", { competition: twoCompetitors });
  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  assertEquals(mockAudio.src, "/audio/100/10/announce");
  assertEquals(mockAudio.playCallCount, 1); // the announcement

  mockAudio.triggerEnded(); // announcement over
  await delay(0);
  assertEquals(mockAudio.src, "/audio/100/10/music"); // the song is loaded...
  assertEquals(mockAudio.playCallCount, 1); // ...but not playing
  assertEquals(mockAudio.paused, true);
  assertEquals(startButton.disabled, false); // the DJ can press play
  assertEquals(startButton.innerText, "play");

  await delay(30); // it keeps waiting
  assertEquals(mockAudio.playCallCount, 1);

  startButton.onclick(); // the DJ presses play
  await delay(0);
  assertEquals(mockAudio.playCallCount, 2);
  assertEquals(startButton.innerText, "pause");

  mockAudio.triggerEnded(); // song over
  await delay(0);
  noop.restore();
});

Deno.test("DjClient: pausing and playing again carries on from where it stopped", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  const noop = stubFetchNoop();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const startButton = doc.querySelector("#start") as any;

  mockSse.emit("competition_start", { competition: twoCompetitors });
  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  mockAudio.triggerEnded();
  await delay(0);

  startButton.onclick(); // play
  await delay(0);
  mockAudio.currentTime = 42; // 42 seconds in
  startButton.onclick(); // pause
  startButton.onclick(); // play again
  await delay(0);
  assertEquals(mockAudio.currentTime, 42, "resumes, does not restart");
  noop.restore();
});

Deno.test("DjClient: skip works from the start of a performance, even during the announcement", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  const fetchStub = interceptFetch();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const skipButton = doc.querySelector("#skip") as any;

  mockSse.emit("competition_start", { competition: twoCompetitors });
  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  assertEquals(
    skipButton.disabled,
    false,
    "skip is available during the announcement",
  );

  skipButton.onclick(); // skip while the announcement plays
  await delay(5);
  const f = fetchStub.getLastFetch();
  assertEquals(f!.body.tag, "perf:100:0");
  assertEquals(f!.body.payload, false);
  assertEquals(mockAudio.paused, true, "the announcement is stopped");
  fetchStub.restore();
});

Deno.test("DjClient: skip before pressing play reports the performance as skipped", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  const fetchStub = interceptFetch();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const skipButton = doc.querySelector("#skip") as any;

  mockSse.emit("competition_start", { competition: twoCompetitors });
  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  mockAudio.triggerEnded(); // announcement over, song waiting for play
  await delay(0);
  skipButton.onclick();
  await delay(5);
  const f = fetchStub.getLastFetch();
  assertEquals([f!.body.tag, f!.body.payload], ["perf:100:0", false]);
  fetchStub.restore();
});

Deno.test("DjClient: after Skip the next competitor starts cleanly, even if the server moves on before the reply arrives", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockAudio = new MockAudio();
  const net = slowFetch();
  new DjClient({ document: doc, sse: mockSse as any, audio: mockAudio as any });
  const startButton = doc.querySelector("#start") as any;
  const skipButton = doc.querySelector("#skip") as any;

  mockSse.emit("competition_start", { competition: twoCompetitors });
  mockSse.emit("performance_start", { position: 0 });
  await delay(0);
  mockAudio.triggerEnded(); // announcement over
  await delay(0);

  skipButton.onclick(); // DJ skips competitor 1: the POST is now in flight
  await delay(0);
  assertEquals(net.calls.at(-1)!.body.payload, false);

  // The server has already moved on: competitor 2 is announced before the
  // reply to the skip has come back.
  mockSse.emit("performance_start", { position: 1 });
  await delay(0);
  assertEquals(mockAudio.src, "/audio/100/11/announce");

  net.release(); // now the reply to the skip arrives
  await delay(5);

  // Competitor 2's performance is intact: its announcement can finish, the song
  // is loaded and waits for play, and both buttons work.
  assert(
    mockAudio.onended !== null,
    "the new announcement is still being listened to",
  );
  assertEquals(skipButton.disabled, false);
  mockAudio.triggerEnded();
  await delay(0);
  assertEquals(mockAudio.src, "/audio/100/11/music");
  assertEquals(startButton.disabled, false);
  assertEquals(mockAudio.playCallCount, 2, "announcements only, no song yet");

  startButton.onclick();
  await delay(0);
  assertEquals(mockAudio.playCallCount, 3);
  mockAudio.triggerEnded(); // song over
  await delay(0);
  assertEquals(net.calls.at(-1)!.body.tag, "perf:100:1");
  assertEquals(net.calls.at(-1)!.body.payload, true);
  net.release();
  net.restore();
});
