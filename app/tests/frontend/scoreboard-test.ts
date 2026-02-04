// test/scoreboard-di-test.ts
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals } from "@std/assert";
import { DOMParser } from "b-fuze/deno-dom";

import { ScoreboardClient } from "../../frontend-src/sb.ts";

// Guidance: This test uses the shared mock WebSocket clients exported from
// `src/test/websocket-mocks.ts`. Import the scoreboard-specific mock
// `MockWebSocketClientForScoreboard` (aliased here as `MockWebSocketClient`) for
// dependency injection in tests. Extend `BaseMockWebSocketClient` in
// `websocket-mocks.ts` if you need more specialized behavior for other tests.
import { MockEventSource } from "./sse-mocks.ts";

import { applyTableShims } from "./test-utils.ts";

Deno.test("ScoreboardClient with dependency injection", () => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html>
    <html>
      <body>
        <table id="scoreboard"></table>
      </body>
    </html>`,
    "text/html",
  );
  applyTableShims(doc);

  const mockSse = new MockEventSource();

  new ScoreboardClient({
    sse: mockSse as any,
    document: doc as any,
  });

  const rubric = {
    id: 1,
    judges: [{ id: 1, name: "Judge 1", criteria: [1] }],
    criteria: [{ id: 1, name: "Technique" }],
  };

  mockSse.emit("competition_start", {
    competition: { rubric },
  });

  const table = doc.querySelector("#scoreboard");
  assert(table, "Scoreboard should exist");

  const headers = table!.querySelectorAll("th");
  assertEquals(headers.length, 3); // Criteria + 1 judge
});

Deno.test("ScoreboardClient clearTable clears all score cells", () => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body><table id="scoreboard"></table></body></html>`,
    "text/html",
  );
  applyTableShims(doc);
  const mockSse = new MockEventSource();
  const sb = new ScoreboardClient({
    sse: mockSse as any,
    document: doc as any,
  });

  mockSse.emit("competition_start", {
    competition: {
      rubric: {
        id: 1,
        judges: [{ id: 10, name: "J1" }, { id: 11, name: "J2" }],
        criteria: [{ id: 20, name: "C1" }, { id: 21, name: "C2" }],
      },
      competitors: [{ id: 1, name: "A", duration: 1000 }],
    },
  });

  const table = doc.querySelector("#scoreboard") as HTMLTableElement;
  table.rows[1].cells[1].textContent = "5";
  table.rows[2].cells[2].textContent = "6";

  sb.clearTable();

  const tds = Array.from(table.querySelectorAll("td"));
  tds.forEach((td) => assertEquals(td.textContent, ""));
});

Deno.test("ScoreboardClient updates correct cell on matching score_update", () => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body><table id="scoreboard"></table></body></html>`,
    "text/html",
  );
  applyTableShims(doc);
  const mockSse = new MockEventSource();
  new ScoreboardClient({ sse: mockSse as any, document: doc as any });

  const competition = {
    id: 999,
    competitors: [{ id: 1, name: "A", duration: 1000 }],
    rubric: {
      id: 1,
      judges: [{ id: 2, name: "J1" }],
      criteria: [{ id: 10, name: "C1" }],
    },
  };

  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });

  mockSse.emit("score_update", {
    competition_id: 999,
    competitor_id: 1,
    judge_id: 2,
    scores: [{ criteria_id: 10, score: 8 }],
  });

  const table = doc.querySelector("#scoreboard") as HTMLTableElement;
  assertEquals(table.rows[1].cells[1].textContent, "8");
});

Deno.test("ScoreboardClient ignores score_update for wrong competitor", () => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body><table id="scoreboard"></table></body></html>`,
    "text/html",
  );
  applyTableShims(doc);
  const mockSse = new MockEventSource();
  new ScoreboardClient({ sse: mockSse as any, document: doc as any });

  const competition = {
    id: 500,
    competitors: [{ id: 10, name: "A", duration: 1000 }, {
      id: 20,
      name: "B",
      duration: 1000,
    }],
    rubric: {
      id: 1,
      judges: [{ id: 7, name: "J1" }],
      criteria: [{ id: 30, name: "C1" }],
    },
  };

  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });

  mockSse.emit("score_update", {
    competition_id: 500,
    competitor_id: 20,
    judge_id: 7,
    scores: [{ criteria_id: 30, score: 9 }],
  });

  const table = doc.querySelector("#scoreboard") as HTMLTableElement;
  assertEquals(table.rows[1].cells[1].textContent, "");
});

Deno.test("ScoreboardClient clears previous scores when moving to next competitor", () => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body><table id="scoreboard"></table></body></html>`,
    "text/html",
  );
  applyTableShims(doc);
  const mockSse = new MockEventSource();
  new ScoreboardClient({ sse: mockSse as any, document: doc as any });

  const competition = {
    id: 777,
    competitors: [{ id: 1, name: "A", duration: 1000 }, {
      id: 2,
      name: "B",
      duration: 1000,
    }],
    rubric: {
      id: 1,
      judges: [{ id: 3, name: "J1" }],
      criteria: [{ id: 40, name: "C1" }],
    },
  };

  mockSse.emit("competition_start", { competition });
  mockSse.emit("performance_start", { position: 0 });

  mockSse.emit("score_update", {
    competition_id: 777,
    competitor_id: 1,
    judge_id: 3,
    scores: [{ criteria_id: 40, score: 5 }],
  });

  const table = doc.querySelector("#scoreboard") as HTMLTableElement;
  assertEquals(table.rows[1].cells[1].textContent, "5");

  mockSse.emit("performance_start", { position: 1 });

  mockSse.emit("score_update", {
    competition_id: 777,
    competitor_id: 2,
    judge_id: 3,
    scores: [{ criteria_id: 40, score: 7 }],
  });

  assertEquals(table.rows[1].cells[1].textContent, "7");
});
