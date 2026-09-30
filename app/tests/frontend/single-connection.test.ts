// deno-lint-ignore-file no-explicit-any
// Regression: each page must open exactly ONE EventSource. The server keeps one
// connection per client id, so a second one steals messages from the first.
import { assertEquals } from "@std/assert";
import { DOMParser } from "b-fuze/deno-dom";
import { DjClient } from "../../frontend-src/dj.ts";
import { JudgeClient } from "../../frontend-src/jd.ts";
import { ScoreboardClient } from "../../frontend-src/sb.ts";
import { applyStyleShim } from "./test-utils.ts";

function doc(body: string): Document {
  const d = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${body}</body></html>`,
    "text/html",
  ) as any;
  applyStyleShim(d, "body");
  return d;
}

function withCountingEventSource(fn: () => void): number {
  const g = globalThis as any;
  const original = g.EventSource;
  let count = 0;
  g.EventSource = class {
    constructor() {
      count++;
    }
    addEventListener() {}
    close() {}
  };
  try {
    fn();
  } finally {
    g.EventSource = original;
  }
  return count;
}

Deno.test("DjClient opens exactly one EventSource", () => {
  const d = doc(`<button id="start"></button><button id="skip"></button>`);
  const audio = { pause() {}, play: () => Promise.resolve() } as any;
  assertEquals(
    withCountingEventSource(() => new DjClient({ document: d, audio })),
    1,
  );
});

Deno.test("JudgeClient opens exactly one EventSource", () => {
  const d = doc(`<div id="sliders"></div><button id="submit"></button>`);
  assertEquals(
    withCountingEventSource(() => new JudgeClient(1, { document: d })),
    1,
  );
});

Deno.test("ScoreboardClient opens exactly one EventSource", () => {
  const d = doc(`<table id="scoreboard"></table>`);
  assertEquals(
    withCountingEventSource(() => new ScoreboardClient({ document: d })),
    1,
  );
});
