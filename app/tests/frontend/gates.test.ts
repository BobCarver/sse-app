// deno-lint-ignore-file no-explicit-any
// The break between competitions: the scoreboard announces it, the DJ page has
// the button that starts the competition (or ends the finished session).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { DOMParser } from "b-fuze/deno-dom";
import { DjClient } from "../../frontend-src/dj.ts";
import { ScoreboardClient } from "../../frontend-src/sb.ts";
import { MockEventSource } from "./sse-mocks.ts";
import { interceptFetch } from "./fetch-mock.ts";
import { applyStyleShim, applyTableShims } from "./test-utils.ts";

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

const page = (body: string) => {
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${body}</body></html>`,
    "text/html",
  ) as any;
  applyStyleShim(doc);
  applyTableShims(doc);
  return doc;
};

const rubric = {
  id: 1,
  judges: [{ id: 1, name: "J1", criteria: [1] }],
  criteria: [{ id: 1, name: "Technique" }],
};

Deno.test("scoreboard: banner for the next competition, gone when it starts, last scores kept", () => {
  const doc = page(
    `<div id="banner" hidden></div><p id="scoresFor"></p><table id="scoreboard"></table>`,
  );
  const sse = new MockEventSource();
  new ScoreboardClient({ sse: sse as any, document: doc });
  const banner = doc.getElementById("banner");

  sse.emit("competition_ready", { competition_id: 10, name: "Juniors" });
  assertStringIncludes(banner.textContent, "Juniors");
  assertStringIncludes(banner.textContent, "about to begin");
  assertEquals(banner.hasAttribute("hidden"), false);
  assert(doc.body.classList.contains("waiting")); // last scores dimmed

  sse.emit("competition_start", {
    competition: { id: 10, name: "Juniors", competitors: [], rubric },
  });
  assertEquals(banner.hasAttribute("hidden"), true);
  assertEquals(banner.textContent, "");
  assertEquals(doc.body.classList.contains("waiting"), false);
});

Deno.test("scoreboard: after the last competition it says when the next session begins", () => {
  const doc = page(
    `<div id="banner" hidden></div><table id="scoreboard"></table>`,
  );
  const sse = new MockEventSource();
  new ScoreboardClient({ sse: sse as any, document: doc });
  const banner = doc.getElementById("banner");

  const soon = new Date();
  soon.setHours(23, 59, 0, 0);
  sse.emit("session_finished", {
    session_id: 1,
    next_session_name: "Evening",
    next_session_start: soon.toISOString(),
  });
  assertStringIncludes(banner.textContent, "Session ended");
  assertStringIncludes(banner.textContent, "(Evening)");
  assertStringIncludes(banner.textContent, "23:59");

  // The DJ ends the session: the message stays up.
  sse.emit("session_end", { reason: "completed", incomplete: 0 });
  assertStringIncludes(banner.textContent, "Session ended");

  sse.emit("session_finished", {
    session_id: 1,
    next_session_name: null,
    next_session_start: null,
  });
  assertStringIncludes(banner.textContent, "No further sessions");
});

const stubAudio = () => ({
  src: "",
  paused: true,
  onended: null,
  onerror: null,
  play: () => Promise.resolve(),
  pause() {},
});

const djPage = () =>
  page(`<button id="begin" hidden></button><button id="start">play</button>
    <button id="skip">skip</button><p id="status"></p>
    <table id="compTable"><tbody id="tbody"></tbody></table>`);

Deno.test("DJ page: the button starts the competition, once", async () => {
  const doc = djPage();
  const sse = new MockEventSource();
  const fetched = interceptFetch();
  try {
    new DjClient({ sse: sse as any, document: doc, audio: stubAudio() as any });
    const button = doc.getElementById("begin");
    assertEquals(button.hasAttribute("hidden"), true); // nothing to start yet

    sse.emit("competition_ready", { competition_id: 10, name: "Juniors" });
    assertEquals(button.hasAttribute("hidden"), false);
    assertEquals(button.textContent, "Start competition: Juniors");

    button.onclick();
    await delay(10);
    assertEquals(fetched.getLastFetch()?.body, {
      tag: "begin:10",
      payload: true,
    });
    assertEquals(button.disabled, true); // pressed: no double start

    // The server starts the competition: the button goes away.
    sse.emit("competition_start", {
      competition: { id: 10, name: "Juniors", competitors: [], rubric },
    });
    assertEquals(button.hasAttribute("hidden"), true);
  } finally {
    fetched.restore();
  }
});

Deno.test("DJ page: after the last competition the button ends the session", async () => {
  const doc = djPage();
  const sse = new MockEventSource();
  const fetched = interceptFetch();
  try {
    new DjClient({ sse: sse as any, document: doc, audio: stubAudio() as any });
    sse.emit("session_finished", {
      session_id: 7,
      next_session_name: null,
      next_session_start: null,
    });
    const button = doc.getElementById("begin");
    assertEquals(button.textContent, "End session");
    assertStringIncludes(
      doc.getElementById("status").textContent,
      "No further",
    );

    button.onclick();
    await delay(10);
    assertEquals(fetched.getLastFetch()?.body, {
      tag: "close:7",
      payload: true,
    });

    sse.emit("session_end", { reason: "completed", incomplete: 0 });
    assertEquals(button.hasAttribute("hidden"), true);
  } finally {
    fetched.restore();
  }
});

Deno.test("DJ page: a failed press can be tried again", async () => {
  const doc = djPage();
  const sse = new MockEventSource();
  const original = globalThis.fetch;
  // deno-lint-ignore require-await
  globalThis.fetch = async () => new Response(null, { status: 403 });
  try {
    new DjClient({ sse: sse as any, document: doc, audio: stubAudio() as any });
    sse.emit("competition_ready", { competition_id: 10, name: "Juniors" });
    const button = doc.getElementById("begin");
    button.onclick();
    await delay(10);
    assertEquals(button.disabled, false);
    assertStringIncludes(
      doc.getElementById("status").textContent,
      "Access denied",
    );
  } finally {
    globalThis.fetch = original;
  }
});
