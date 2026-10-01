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
      competitors: [{ id: 1, name: "A", duration: 120 }],
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
    competitors: [{ id: 1, name: "A", duration: 120 }],
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
    competitors: [{ id: 10, name: "A", duration: 120 }, {
      id: 20,
      name: "B",
      duration: 120,
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
    competitors: [{ id: 1, name: "A", duration: 120 }, {
      id: 2,
      name: "B",
      duration: 120,
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

// --- the last scores stay up until the next competitor has a score -----------------

function boardDoc() {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body><p id="scoresFor"></p><table id="scoreboard"></table></body></html>`,
    "text/html",
  );
  applyTableShims(doc);
  return doc;
}
const rubric = (judgeNames: string[], criteria: string[]) => ({
  id: 1,
  judges: judgeNames.map((name, i) => ({ id: 3 + i, name })),
  criteria: criteria.map((name, i) => ({ id: 40 + i, name })),
});
const score = (
  competition: number,
  competitor: number,
  judge: number,
  value: number,
  criteria = 40,
) => ({
  competition_id: competition,
  competitor_id: competitor,
  judge_id: judge,
  scores: [{ criteria_id: criteria, score: value }],
});
const cells = (doc: any) =>
  [...doc.querySelectorAll("#scoreboard tbody td")].map((td: any) =>
    td.textContent
  );
const label = (doc: any) =>
  (doc.getElementById("scoresFor") as any).textContent;

Deno.test("scoreboard: the last scores stay up when the next performance starts, until a judge scores the new competitor", () => {
  const doc = boardDoc();
  const sse = new MockEventSource();
  new ScoreboardClient({ sse: sse as any, document: doc as any });
  const competition = {
    id: 777,
    name: "C",
    competitors: [{ id: 1, name: "Alex", duration: 60 }, {
      id: 2,
      name: "Sam",
      duration: 60,
    }],
    rubric: rubric(["Ada", "Ben"], ["Technique"]),
  };
  sse.emit("competition_start", { competition });
  sse.emit("performance_start", { position: 0 });
  assertEquals(label(doc), ""); // nothing scored yet
  sse.emit("score_update", score(777, 1, 3, 8));
  sse.emit("score_update", score(777, 1, 4, 6));
  assertEquals(cells(doc), ["8", "6"]);
  assertEquals(label(doc), "Scores: Alex");

  // Sam's performance starts: Alex's result is still readable, and labelled.
  sse.emit("performance_start", { position: 1 });
  assertEquals(cells(doc), ["8", "6"]);
  assertEquals(label(doc), "Last scores: Alex");

  // ...for as long as it takes (a replay of the same event changes nothing).
  sse.emit("performance_start", { position: 1 });
  assertEquals(cells(doc), ["8", "6"]);

  // The first judge to score Sam replaces the old board - only Sam's score shows.
  sse.emit("score_update", score(777, 2, 4, 9));
  assertEquals(cells(doc), ["", "9"]);
  assertEquals(label(doc), "Scores: Sam");
  sse.emit("score_update", score(777, 2, 3, 7));
  assertEquals(cells(doc), ["7", "9"]);
});

Deno.test("scoreboard: a skipped competitor leaves the previous scores up", () => {
  const doc = boardDoc();
  const sse = new MockEventSource();
  new ScoreboardClient({ sse: sse as any, document: doc as any });
  const competition = {
    id: 777,
    name: "C",
    competitors: [{ id: 1, name: "Alex", duration: 60 }, {
      id: 2,
      name: "Sam",
      duration: 60,
    }, { id: 3, name: "Di", duration: 60 }],
    rubric: rubric(["Ada"], ["Technique"]),
  };
  sse.emit("competition_start", { competition });
  sse.emit("performance_start", { position: 0 });
  sse.emit("score_update", score(777, 1, 3, 8));
  sse.emit("performance_start", { position: 1 }); // Sam is skipped: no scores
  sse.emit("performance_start", { position: 2 }); // Di is on now
  assertEquals(cells(doc), ["8"]);
  assertEquals(label(doc), "Last scores: Alex");
  sse.emit("score_update", score(777, 3, 3, 5));
  assertEquals(cells(doc), ["5"]);
  assertEquals(label(doc), "Scores: Di");
});

Deno.test("scoreboard: a score for someone who is not on now changes nothing", () => {
  const doc = boardDoc();
  const sse = new MockEventSource();
  new ScoreboardClient({ sse: sse as any, document: doc as any });
  const competition = {
    id: 777,
    name: "C",
    competitors: [{ id: 1, name: "Alex", duration: 60 }, {
      id: 2,
      name: "Sam",
      duration: 60,
    }],
    rubric: rubric(["Ada"], ["Technique"]),
  };
  sse.emit("competition_start", { competition });
  sse.emit("performance_start", { position: 0 });
  sse.emit("score_update", score(777, 1, 3, 8));
  sse.emit("performance_start", { position: 1 });
  sse.emit("score_update", score(777, 1, 3, 2)); // late/stale: Alex again
  sse.emit("score_update", score(999, 2, 3, 2)); // another competition
  assertEquals(cells(doc), ["8"]);
  assertEquals(label(doc), "Last scores: Alex");
});

Deno.test("scoreboard: the next competition keeps the last scores too, and switches layout with its first score", () => {
  const doc = boardDoc();
  const sse = new MockEventSource();
  new ScoreboardClient({ sse: sse as any, document: doc as any });
  const first = {
    id: 777,
    name: "Jive",
    competitors: [{ id: 1, name: "Alex", duration: 60 }],
    rubric: rubric(["Ada", "Ben"], ["Technique"]),
  };
  const second = {
    id: 888,
    name: "Waltz",
    competitors: [{ id: 5, name: "Mia", duration: 60 }],
    rubric: rubric(["Cat"], ["Grace", "Timing"]), // a different panel and criteria
  };
  sse.emit("competition_start", { competition: first });
  sse.emit("performance_start", { position: 0 });
  sse.emit("score_update", score(777, 1, 3, 8));
  sse.emit("score_update", score(777, 1, 4, 6));
  assertEquals(cells(doc), ["8", "6"]);

  // The Waltz begins: the Jive board (and its judges) is still showing.
  sse.emit("competition_start", { competition: second });
  sse.emit("performance_start", { position: 0 });
  assertEquals(cells(doc), ["8", "6"]);
  assertEquals((doc.querySelectorAll("#scoreboard thead th") as any).length, 3); // Criteria + 2 judges
  assertEquals(label(doc), "Last scores: Alex");

  // Mia's first score rebuilds the board for the new panel.
  sse.emit("score_update", score(888, 5, 3, 9, 40));
  assertEquals((doc.querySelectorAll("#scoreboard thead th") as any).length, 2); // Criteria + 1 judge
  assertEquals(cells(doc), ["9", ""]); // two criteria rows, one judge
  assertEquals(label(doc), "Scores: Mia");
});

Deno.test("scoreboard: after a reconnect the replayed state rebuilds the same board", () => {
  const doc = boardDoc();
  const sse = new MockEventSource();
  new ScoreboardClient({ sse: sse as any, document: doc as any });
  const competition = {
    id: 777,
    name: "C",
    competitors: [{ id: 1, name: "Alex", duration: 60 }],
    rubric: rubric(["Ada", "Ben"], ["Technique"]),
  };
  // What a freshly (re)connected page is sent: the competition, the performance
  // in progress, then the scores so far.
  sse.emit("competition_start", { competition });
  sse.emit("performance_start", { position: 0 });
  sse.emit("score_update", score(777, 1, 3, 8));
  assertEquals(cells(doc), ["8", ""]);
  // A blip on a page that already shows them: the same replay changes nothing.
  sse.emit("competition_start", { competition });
  sse.emit("performance_start", { position: 0 });
  sse.emit("score_update", score(777, 1, 3, 8));
  assertEquals(cells(doc), ["8", ""]);
  sse.emit("score_update", score(777, 1, 4, 6));
  assertEquals(cells(doc), ["8", "6"]);
});
