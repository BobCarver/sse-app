// test/frontend/sseClient-test.ts
// deno-lint-ignore-file no-explicit-any
import { assertEquals, assertExists } from "std/assert";
import { DOMParser } from "b-fuze/deno-dom";
import { sseClient } from "../../src/frontend/sseClient.ts";
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
      { id: 1, name: "A", duration: 1000 },
      { id: 2, name: "B", duration: 2000 },
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
      { id: 1, name: "Alice", duration: 1000 },
      { id: 2, name: "Bob", duration: 2000 },
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
