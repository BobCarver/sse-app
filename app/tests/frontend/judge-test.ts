// test/judge-test.ts
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { DOMParser } from "b-fuze/deno-dom";
import { JudgeClient } from "../../frontend-src/jd.ts";

// Guidance: This test uses the shared mock WebSocket clients exported from
// `src/test/websocket-mocks.ts`. Import the judge-specific mock
// `MockWebSocketClientForJudge` (aliased here as `MockWebSocketClient`) for
// dependency injection in tests. Extend `BaseMockWebSocketClient` in
// `websocket-mocks.ts` if you need more specialized behavior for other tests.
import { MockEventSource } from "./sse-mocks.ts";
import { interceptFetch, stubFetchNoop } from "./fetch-mock.ts";
import { applyStyleShim } from "./test-utils.ts";

class MockNavigator {
  public vibrateCallCount = 0;
  public lastVibrateDuration = 0;

  vibrate(duration: number) {
    this.vibrateCallCount++;
    this.lastVibrateDuration = duration;
  }
}

function createTestDOM(): Document {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html>
    <html>
      <body>
        <div id="sliders"></div>
        <button id="submit">Submit</button>
      </body>
    </html>`,
    "text/html",
  ) as any;
  // deno-dom doesn't implement element.style; use shared shim
  applyStyleShim(doc, "body");
  return doc;
}

Deno.test("JudgeClient creates sliders for assigned criteria", () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();

  const judge = new JudgeClient(101, {
    sse: mockSse as any,
    document: doc,
  });

  const rubric = {
    id: 1,
    judges: [
      { id: 101, name: "Judge 1", criteria: [1, 2] },
      { id: 102, name: "Judge 2", criteria: [3] },
    ],
    criteria: [
      { id: 1, name: "Technique" },
      { id: 2, name: "Artistry" },
      { id: 3, name: "Difficulty" },
    ],
  };

  mockSse.emit("competition_start", {
    competition: { id: 1, rubric },
  });

  const sliders = doc.querySelectorAll("#sliders input");

  // Should only have 2 sliders (criteria 1 and 2, not 3)
  assertEquals(sliders.length, 2);

  const labels = Array.from(doc.querySelectorAll("#sliders label"))
    .map((l) => l.textContent);
  assert(labels.includes("Technique"));
  assert(labels.includes("Artistry"));
  assert(!labels.includes("Difficulty"));

  judge.destroy();
});

Deno.test("JudgeClient slider updates score display", () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();

  const judge = new JudgeClient(101, {
    sse: mockSse as any,
    document: doc,
  });

  const rubric = {
    judges: [{ id: 101, name: "Judge 1", criteria: [1] }],
    criteria: [{ id: 1, name: "Technique" }],
  };

  mockSse.emit("competition_start", {
    competition: { id: 1, rubric },
  });

  const slider = doc.querySelector("#sliders input") as any;
  const scoreDisplay = slider.nextElementSibling;

  // Change slider value
  slider.value = "8.3";

  // The fake DOM does not trigger input events automatically, so we manually dispatch
  // to simulate user input.
  // Trigger input event (deno-dom may not bubble input events; dispatch on container and set target)
  // input events don't bubble in deno-dom
  // and HTMLInputElement isn't defined globally,
  // temporarily set globalThis.HTMLInputElement to the slider's constructor,
  // dispatch the event on #sliders, then restore the original value.
  const event = new Event("input", { bubbles: true });
  Object.defineProperty(event, "target", { value: slider });
  // Ensure HTMLInputElement is defined for the instanceof check in the handler
  const prevHTMLInputElement = (globalThis as any).HTMLInputElement;
  (globalThis as any).HTMLInputElement = (slider as any).constructor;
  try {
    doc.querySelector("#sliders")!.dispatchEvent(event);
  } finally {
    if (prevHTMLInputElement === undefined) {
      delete (globalThis as any).HTMLInputElement;
    } else {
      (globalThis as any).HTMLInputElement = prevHTMLInputElement;
    }
  }

  // Score display should update
  assertEquals(scoreDisplay.textContent, "8.3");

  judge.destroy();
});

Deno.test("JudgeClient enables submit button and sets alarm on enable_scoring", () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const ft = new FakeTime();
  let judge: JudgeClient | undefined;
  try {
    judge = new JudgeClient(101, {
      sse: mockSse as any,
      document: doc,
      setTimeout: (globalThis as any).setTimeout,
      clearTimeout: (globalThis as any).clearTimeout,
    });

    const rubric = {
      judges: [{ id: 101, name: "Judge 1", criteria: [1, 2] }],
      criteria: [
        { id: 1, name: "Technique" },
        { id: 2, name: "Artistry" },
      ],
    };

    mockSse.emit("competition_start", {
      competition: { id: 1, rubric },
    });

    const submit = doc.querySelector("#submit") as any;
    assertEquals(submit.disabled, true);

    // Enable scoring
    mockSse.emit("enable_scoring", {});

    assertEquals(submit.disabled, false);

    // All sliders should be reset to 5.0
    const sliders = Array.from(doc.querySelectorAll("#sliders input")) as any[];
    sliders.forEach((slider) => {
      assertEquals(slider.value, "5");
      assertEquals(slider.nextElementSibling.textContent, "5.0");
    });

    // Should have alarm timer id set
    assert((judge as any).alert !== undefined);
  } finally {
    try {
      judge?.destroy();
    } finally {
      ft.restore();
    }
  }
});

Deno.test("JudgeClient submits scores with correct data", async () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();

  const judge = new JudgeClient(101, {
    sse: mockSse as any,
    document: doc,
  });
  (judge as any).sessionId = 1; // set sessionId for test
  const rubric = {
    judges: [{ id: 101, name: "Judge 1", criteria: [1, 2] }],
    criteria: [
      { id: 1, name: "Technique" },
      { id: 2, name: "Artistry" },
    ],
  };

  const competition = {
    id: 5,
    rubric,
    competitors: [
      { id: 10, name: "Competitor 1" },
      { id: 11, name: "Competitor 2" },
    ],
  };

  mockSse.emit("competition_start", { competition });
  mockSse.emit("enable_scoring", {});

  // Set slider values
  const sliders = Array.from(doc.querySelectorAll("#sliders input")) as any[];
  sliders[0].value = "9.2";
  sliders[1].value = "8.5";

  // Mock position (would be set by webSocketClient base class)
  (judge as any).position = 0;

  const fetchStub = interceptFetch();

  const submit = doc.querySelector("#submit") as any;
  (submit as any).onclick?.();

  // Wait a tick for the async fetch mock to run
  await new Promise((r) => setTimeout(r, 0));

  // Check submitted data
  const f = fetchStub.getLastFetch();
  assert(f !== null);
  assertEquals(f!.url, "http://localhost/response");
  assertEquals(f!.body.tag, "score:5:10:101");
  assertEquals(Array.isArray(f!.body.scores), true);
  assertEquals(f!.body.scores.length, 2);
  assertEquals(f!.body.scores[0].criteria_id, 1);
  assertEquals(f!.body.scores[0].score, 9.2);
  assertEquals(f!.body.scores[1].criteria_id, 2);
  assertEquals(f!.body.scores[1].score, 8.5);

  // Submit should be disabled after submission
  assertEquals(submit.disabled, true);

  judge.destroy();

  fetchStub.restore();
});

Deno.test({
  name: "JudgeClient clears alarm on submit",
  ignore: true,
  fn: async () => {
    const doc = createTestDOM();
    const mockSse = new MockEventSource();
    const ft = new FakeTime();
    let judge: JudgeClient | undefined;
    // try {

    judge = new JudgeClient(101, {
      sse: mockSse as any,
      document: doc,
      setTimeout: (globalThis as any).setTimeout,
      clearTimeout: (globalThis as any).clearTimeout,
    });

    const rubric = {
      judges: [{ id: 101, name: "Judge 1", criteria: [1] }],
      criteria: [{ id: 1, name: "Technique" }],
    };

    mockSse.emit("competition_start", {
      competition: {
        id: 1,
        rubric,
        competitors: [{ id: 10 }],
      },
    });

    (judge as any).position = 0;

    mockSse.emit("enable_scoring", {});
    /* Check that alarm timer is set */
    assert((judge as any).alert !== undefined, "Should have alarm timer");

    // Prevent network and allow submit to complete
    const noop = stubFetchNoop();

    // Submit scores
    const submit = doc.querySelector("#submit") as any;
    /* Click submit to trigger score submission */
    (submit as any).onclick?.();

    // Wait a tick and check alarm cleared
    await new Promise((r) => setTimeout(r, 0));
    assert((judge as any).alert === undefined, "Alarm timer should be cleared");

    noop.restore();
    // } finally {
    //   try {
    //     judge?.destroy();
    //   } finally {
    //     ft.restore();
    //   }
    // }
  },
});

Deno.test("JudgeClient alarm triggers vibration and visual feedback", () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const mockNav = new MockNavigator();
  const ft = new FakeTime();
  let judge: JudgeClient | undefined;
  try {
    judge = new JudgeClient(101, {
      sse: mockSse as any,
      document: doc,
      navigator: mockNav as any,
      setTimeout: (globalThis as any).setTimeout,
      clearTimeout: (globalThis as any).clearTimeout,
    });

    const rubric = {
      judges: [{ id: 101, name: "Judge 1", criteria: [1] }],
      criteria: [{ id: 1, name: "Technique" }],
    };

    mockSse.emit("competition_start", {
      competition: { id: 1, rubric },
    });

    mockSse.emit("enable_scoring", {});

    // Advance time to trigger alarm (30 seconds)
    ft.tick(30000);

    // Check vibration
    assertEquals(mockNav.vibrateCallCount, 1);
    assertEquals(mockNav.lastVibrateDuration, 1000);

    // Check visual feedback
    assertEquals(doc.body.style.backgroundColor, "#ff0000");

    // Advance time to clear visual feedback (500ms)
    ft.tick(500);

    assertEquals(doc.body.style.backgroundColor, "");
  } finally {
    try {
      judge?.destroy();
    } finally {
      ft.restore();
    }
  }
});

Deno.test("JudgeClient destroy clears timers", () => {
  const doc = createTestDOM();
  const mockSse = new MockEventSource();
  const ft = new FakeTime();
  let judge: JudgeClient | undefined;

  try {
    judge = new JudgeClient(101, {
      sse: mockSse as any,
      document: doc,
      setTimeout: (globalThis as any).setTimeout,
      clearTimeout: (globalThis as any).clearTimeout,
    });

    const rubric = {
      judges: [{ id: 101, name: "Judge 1", criteria: [1] }],
      criteria: [{ id: 1, name: "Technique" }],
    };

    mockSse.emit("competition_start", {
      competition: { id: 1, rubric },
    });

    mockSse.emit("enable_scoring", {});

    // Alert timer should be set
    assert((judge as any).alert !== undefined, "Should have alarm timer");

    judge.destroy();

    assert((judge as any).alert === undefined, "All timers should be cleared");
  } finally {
    ft.restore();
  }
});
