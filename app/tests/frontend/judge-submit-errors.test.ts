// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
import { DOMParser } from "b-fuze/deno-dom";
import { JudgeClient } from "../../frontend-src/jd.ts";
import { MockEventSource } from "./sse-mocks.ts";
import { applyStyleShim } from "./test-utils.ts";

function setup() {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>
      <div id="sliders"></div><button id="submit">Submit</button><p id="status"></p>
    </body></html>`,
    "text/html",
  ) as any;
  applyStyleShim(doc, "body");
  const sse = new MockEventSource();
  const judge = new JudgeClient(101, { sse: sse as any, document: doc });
  sse.emit("competition_start", {
    competition: {
      id: 5,
      rubric: {
        judges: [{ id: 101, name: "J", criteria: [1] }],
        criteria: [{ id: 1, name: "<b>Tech</b>" }],
      },
      competitors: [{ id: 10, name: "C1" }],
    },
  });
  sse.emit("performance_start", { competition_id: 5, position: 0 });
  sse.emit("enable_scoring", {});
  return { doc, judge };
}

async function submitWith(status: number) {
  const { doc, judge } = setup();
  const orig = globalThis.fetch;
  globalThis.fetch =
    (() => Promise.resolve(new Response(null, { status }))) as any;
  try {
    (doc.querySelector("#submit") as any).onclick();
    await new Promise((r) => setTimeout(r, 0));
  } finally {
    globalThis.fetch = orig;
    judge.destroy();
  }
  return {
    submitDisabled: (doc.querySelector("#submit") as any).disabled,
    status: doc.getElementById("status")!.textContent,
    doc,
  };
}

Deno.test("judge: accepted submit stays disabled and confirms", async () => {
  const r = await submitWith(200);
  assertEquals(r.submitDisabled, true);
  assertEquals(r.status, "Scores submitted");
});

Deno.test("judge: 404 (window closed) stays disabled and says too late", async () => {
  const r = await submitWith(404);
  assertEquals(r.submitDisabled, true);
  assertEquals(r.status.startsWith("Too late"), true);
});

Deno.test("judge: 400 rejects, judge can retry", async () => {
  const r = await submitWith(400);
  assertEquals(r.submitDisabled, false);
  assertEquals(r.status.startsWith("Submit failed"), true);
});

Deno.test("judge: criterion names are escaped in the sliders", () => {
  const { doc, judge } = setup();
  const label = doc.querySelector("#sliders label")!;
  assertEquals(label.textContent, "<b>Tech</b>");
  assertEquals(doc.querySelectorAll("#sliders b").length, 0);
  judge.destroy();
});
