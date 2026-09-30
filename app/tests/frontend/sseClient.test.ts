// test/frontend/sseClient-test.ts
// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertExists } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { DOMParser } from "b-fuze/deno-dom";
import { sseClient } from "../../frontend-src/sseClient.ts";
import { MockEventSource } from "./sse-mocks.ts";
import { applyStyleShim, applyTableShims } from "./test-utils.ts";
import { Competition } from "../../src/types.ts";

function createDOM() {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html>
    <html>
      <body>
        <table id="compTable">
          <tbody id="tbody"></tbody>
        </table>
        <div id="status"></div>
      </body>
    </html>`,
    "text/html",
  ) as any;
  applyStyleShim(doc);
  applyTableShims(doc);
  return doc as Document;
}

Deno.test("sseClient constructs competitor table on competition_start", () => {
  const doc = createDOM();
  const mockSse = new MockEventSource();

  // subclass to access protected members for testing
  class TestClient extends sseClient {
    // expose for assertions
    getTbody() {
      return this.doc.querySelector("#tbody");
    }
  }

  const client = new TestClient({ sse: mockSse as any, document: doc });

  const competition: Competition = {
    id: 42,
    name: "Test Competition",
    rubric: { id: 1, criteria: [], judges: [] },
    competitors: [
      { id: 1, name: "A", duration: 120 },
      { id: 2, name: "B", duration: 180 },
    ],
  };

  mockSse.emit("competition_start", { competition });

  // table should now have rows for competitors
  const tbody = client.getTbody() as HTMLTableSectionElement;
  assertExists(tbody);
  // rows accessor is created by applyTableShims
  // Expect 2 rows
  // @ts-ignore -- rows shim
  assertEquals(tbody.rows.length, 2);
  // first row should contain competitor name A
  const firstRow = tbody.rows[0];
  assertEquals(firstRow.cells[1].textContent, "A");
});

Deno.test("sseClient updates times on performance_start", () => {
  const doc = createDOM();
  const mockSse = new MockEventSource();

  class TestClient extends sseClient {
    getTbody() {
      return this.doc.querySelector("#tbody");
    }
  }

  const client = new TestClient({ sse: mockSse as any, document: doc });

  const competition: Competition = {
    id: 99,
    name: "Mock Competition",
    rubric: { id: 1, criteria: [], judges: [] },
    competitors: [
      { id: 1, name: "Alice", duration: 120 },
      { id: 2, name: "Bob", duration: 180 },
    ],
  };

  mockSse.emit("competition_start", { competition });

  // Initially position is 0
  mockSse.emit("performance_start", { position: 0 });

  const tbody = client.getTbody() as HTMLTableSectionElement;
  // Check that first cell (time column) for each row is populated
  const firstCellText = tbody.rows[0].cells[0].textContent;
  const secondCellText = tbody.rows[1].cells[0].textContent;
  assertExists(firstCellText);
  assertExists(secondCellText);
  // Ensure they are formatted as HH:MM (basic check)
  // e.g., "09:30"
  const timeRegex = /^\d{2}:\d{2}$/;
  assertEquals(timeRegex.test(firstCellText), true);
  assertEquals(timeRegex.test(secondCellText), true);
});

// --- schedule: durations are SECONDS -----------------------------------------

function times(tbody: any): string[] {
  return Array.from(tbody.rows).map((r: any) => r.cells[0].textContent);
}

function schedule(
  run: (t: {
    emit: (event: string, payload: Record<string, unknown>) => void;
    tbody: any;
    time: FakeTime;
  }) => void,
) {
  const time = new FakeTime(new Date(2026, 0, 1, 9, 0, 0)); // 09:00:00 local
  try {
    const doc = createDOM();
    const sse = new MockEventSource();
    new (class extends sseClient {})({ sse: sse as any, document: doc });
    run({
      emit: (event, payload) => sse.emit(event, payload),
      tbody: doc.querySelector("#tbody"),
      time,
    });
  } finally {
    time.restore();
  }
}

Deno.test("schedule: durations are seconds (120 = two minutes, not 120 ms)", () => {
  const competition = {
    id: 1,
    name: "C",
    rubric: { id: 1, criteria: [], judges: [] },
    competitors: [{ id: 1, name: "A", duration: 120 }, {
      id: 2,
      name: "B",
      duration: 90,
    }, { id: 3, name: "C", duration: 180 }],
  };
  schedule(({ emit, tbody }) => {
    emit("competition_start", { competition });
    // 09:00, +120s = 09:02, +90s = 09:03:30 -> 09:03
    assertEquals(times(tbody), ["09:00", "09:02", "09:03"]);
  });
});

Deno.test("schedule: times shift as the show runs (performance_start recomputes from now)", () => {
  const competition = {
    id: 1,
    name: "C",
    rubric: { id: 1, criteria: [], judges: [] },
    competitors: [{ id: 1, name: "A", duration: 120 }, {
      id: 2,
      name: "B",
      duration: 120,
    }, { id: 3, name: "C", duration: 120 }],
  };
  schedule(({ emit, tbody, time }) => {
    emit("competition_start", { competition });
    time.tick(5 * 60 * 1000); // the first act ran long: it is now 09:05
    emit("performance_start", { competition_id: 1, position: 1 });
    // the current act starts now; the next follows two minutes later
    assertEquals(times(tbody).slice(1), ["09:05", "09:07"]);
  });
});

Deno.test("schedule: a missing duration counts as zero instead of showing NaN", () => {
  const competition = {
    id: 1,
    name: "C",
    rubric: { id: 1, criteria: [], judges: [] },
    competitors: [{ id: 1, name: "A", duration: null }, {
      id: 2,
      name: "B",
      duration: 60,
    }, { id: 3, name: "C" }],
  };
  schedule(({ emit, tbody }) => {
    emit("competition_start", { competition });
    assertEquals(times(tbody), ["09:00", "09:00", "09:01"]);
  });
});
