// deno-lint-ignore-file no-explicit-any
// Page classes must tolerate the server replaying state on (re)connect.
import { assertEquals, assertRejects } from "@std/assert";
import { DOMParser } from "b-fuze/deno-dom";
import { DjClient } from "../../frontend-src/dj.ts";
import { JudgeClient } from "../../frontend-src/jd.ts";
import { ScoreboardClient } from "../../frontend-src/sb.ts";
import {
  AuthError,
  connect,
  postResponse,
} from "../../frontend-src/connect.ts";
import { MockEventSource } from "./sse-mocks.ts";
import { applyStyleShim, applyTableShims } from "./test-utils.ts";
import { interceptFetch } from "./fetch-mock.ts";

function dom(body: string): Document {
  const d = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${body}</body></html>`,
    "text/html",
  ) as any;
  applyStyleShim(d, "body");
  applyTableShims(d);
  return d;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const competition = (id = 10) => ({
  id,
  name: "Comp",
  competitors: [{ id: 100, name: "A", duration: 60 }, {
    id: 101,
    name: "B",
    duration: 60,
  }],
  rubric: {
    criteria: [{ id: 1, name: "Technique" }],
    judges: [{ id: 2, name: "Judge 2", criteria: [1] }],
  },
});

// ---- judge ------------------------------------------------------------------

function judge() {
  const doc = dom(
    `<div id="sliders"></div><button id="submit">Submit</button><p id="status"></p>`,
  );
  const sse = new MockEventSource();
  const client = new JudgeClient(2, { sse: sse as any, document: doc });
  const slider = () => doc.querySelector("#sliders input") as any;
  const submit = () => doc.querySelector("#submit") as any;
  return { doc, sse, client, slider, submit };
}

Deno.test("judge: replayed competition_start keeps the sliders the judge is moving", () => {
  const { sse, client, slider } = judge();
  sse.emit("competition_start", { competition: competition() });
  const first = slider();
  first.value = "9";
  sse.emit("competition_start", { competition: competition() }); // reconnect replay
  assertEquals(slider() === first, true); // same element, not rebuilt
  assertEquals(slider().value, "9");
  // a different competition does rebuild
  sse.emit("competition_start", { competition: competition(11) });
  assertEquals(slider() === first, false);
  client.destroy();
});

Deno.test("judge: replayed enable_scoring does not reset sliders; a new position does", () => {
  const { sse, client, slider, submit } = judge();
  sse.emit("competition_start", { competition: competition() });
  sse.emit("enable_scoring", { competition_id: 10, position: 0 });
  assertEquals([submit().disabled, slider().value], [false, "5"]);

  slider().value = "9";
  sse.emit("enable_scoring", { competition_id: 10, position: 0 }); // blip replay
  assertEquals(slider().value, "9");

  submit().disabled = true; // submitted
  sse.emit("enable_scoring", { competition_id: 10, position: 1 }); // next competitor
  assertEquals([submit().disabled, slider().value], [false, "5"]);
  client.destroy();
});

Deno.test("judge: reload mid-scoring recovers from the replay alone (competition, position, enable)", async () => {
  const { sse, client, slider, submit } = judge();
  // a fresh page receives exactly what the server replays
  sse.emit("competition_start", { competition: competition() });
  sse.emit("performance_start", { competition_id: 10, position: 1 });
  sse.emit("enable_scoring", { competition_id: 10, position: 1 });
  slider().value = "7";
  const f = interceptFetch();
  try {
    submit().onclick();
    await tick();
    const sent = f.getLastFetch()!;
    assertEquals(sent.body.tag, "score:10:101:2"); // position 1 => competitor 101
    assertEquals(sent.body.payload, [{ criteria_id: 1, score: 7 }]);
  } finally {
    f.restore();
    client.destroy();
  }
});

Deno.test("client: 'superseded' shows a message and closes the connection", () => {
  const { doc, sse, client } = judge();
  let closed = false;
  const orig = sse.close.bind(sse);
  sse.close = () => {
    closed = true;
    orig();
  };
  sse.emit("superseded");
  assertEquals(closed, true);
  assertEquals(
    doc.getElementById("status")!.textContent.includes("another window"),
    true,
  );
  client.destroy();
});

// ---- DJ ---------------------------------------------------------------------

function dj() {
  const doc = dom(
    `<button id="start"></button><button id="skip"></button><p id="status"></p>`,
  );
  const audio: any = {
    paused: true,
    src: "",
    plays: 0,
    currentTime: 0,
    pause() {
      this.paused = true;
    },
    play() {
      this.plays++;
      this.paused = false;
      return Promise.resolve();
    },
  };
  const sse = new MockEventSource();
  const client = new DjClient({ sse: sse as any, document: doc, audio });
  const btn = (id: string) => doc.querySelector(id) as any;
  return { sse, client, audio, btn };
}

Deno.test("dj: performance_recovery for the performance already in progress is ignored (network blip)", async () => {
  const { sse, client, audio } = dj();
  sse.emit("competition_start", { competition: competition() });
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  await tick();
  assertEquals([audio.plays, audio.src], [1, "10-100-announce"]);

  sse.emit("performance_recovery", { competition_id: 10, position: 0 });
  await tick();
  assertEquals([audio.plays, audio.src], [1, "10-100-announce"]); // untouched
  client.destroy();
});

Deno.test("dj: after a reload, recovery skips the announcement, waits for the DJ, and can still report", async () => {
  const { sse, client, audio, btn } = dj();
  sse.emit("competition_start", { competition: competition() });
  sse.emit("performance_recovery", { competition_id: 10, position: 1 });
  await tick();
  assertEquals(audio.src, "10-101-music"); // straight to the music
  assertEquals(audio.plays, 0); // no autoplay (browsers would reject it and skip the act)
  assertEquals([btn("#start").disabled, btn("#skip").disabled], [false, false]);

  const f = interceptFetch();
  try {
    btn("#skip").onclick();
    await tick();
    await tick();
    const sent = f.getLastFetch()!;
    assertEquals([sent.body.tag, sent.body.payload], ["perf:10:1", false]);
  } finally {
    f.restore();
    client.destroy();
  }
});

// ---- scoreboard ---------------------------------------------------------------

function board() {
  const doc = dom(`<table id="scoreboard"></table>`);
  const sse = new MockEventSource();
  const client = new ScoreboardClient({ sse: sse as any, document: doc });
  const cells = () =>
    Array.from(doc.querySelectorAll("#scoreboard tbody td")).map((c: any) =>
      c.textContent
    );
  return { sse, client, cells };
}
const score = (competitor_id: number, s: number) => ({
  competition_id: 10,
  competitor_id,
  judge_id: 2,
  scores: [{ criteria_id: 1, score: s }],
});

Deno.test("scoreboard: replay (competition, position, scores so far) rebuilds the board", () => {
  const { sse, cells } = board();
  sse.emit("competition_start", { competition: competition() });
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  sse.emit("score_update", score(100, 8));
  assertEquals(cells(), ["8"]);

  // reload: same events again
  sse.emit("competition_start", { competition: competition() });
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  sse.emit("score_update", score(100, 8));
  assertEquals(cells(), ["8"]);
});

Deno.test("scoreboard: a new performance starts with an empty board", () => {
  const { sse, cells } = board();
  sse.emit("competition_start", { competition: competition() });
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  sse.emit("score_update", score(100, 8));
  sse.emit("performance_start", { competition_id: 10, position: 1 });
  assertEquals(cells(), [""]);
});

Deno.test("scoreboard: a score arriving before any competition state does not throw", () => {
  const { sse, cells } = board();
  sse.emit("score_update", score(100, 8)); // handler errors are swallowed by the mock; must not corrupt state
  sse.emit("competition_start", { competition: competition() });
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  sse.emit("score_update", score(100, 6));
  assertEquals(cells(), ["6"]);
});

// ---- identity & revocation ---------------------------------------------------

function stubFetch(handler: (url: string, init?: any) => Response) {
  const g = globalThis as any;
  const orig = g.fetch, origES = g.EventSource;
  const calls: string[] = [];
  g.fetch = (input: any, init?: any) => {
    const url = String(input);
    calls.push(new URL(url, "http://x").pathname);
    return Promise.resolve(handler(url, init));
  };
  g.EventSource = class {
    addEventListener() {}
    close() {}
  };
  return {
    calls,
    restore() {
      g.fetch = orig;
      g.EventSource = origES;
    },
  };
}

Deno.test("connect: identity comes from the server, and must match the page kind", async () => {
  const f = stubFetch(() =>
    new Response(JSON.stringify({ client_id: "judge7" }), { status: 200 })
  );
  try {
    const { clientId, num, sse } = await connect("judge");
    assertEquals([clientId, num], ["judge7", 7]);
    sse.close();
    await assertRejects(() => connect("dj"), Error, "not a dj page");
  } finally {
    f.restore();
  }
});

Deno.test("connect: no/invalid credential is an AuthError", async () => {
  const f = stubFetch(() => new Response("{}", { status: 401 }));
  try {
    await assertRejects(() => connect("judge"), AuthError);
  } finally {
    f.restore();
  }
});

Deno.test("postResponse: 401 (revoked) is reported, not retried", async () => {
  const f = stubFetch(() => new Response(null, { status: 401 }));
  try {
    assertEquals(await postResponse({ tag: "perf:1:0", payload: true }), {
      ok: false,
      status: 401,
    });
    assertEquals(f.calls, ["/response"]);
  } finally {
    f.restore();
  }
});

Deno.test("judge: revoked or forbidden submit says access denied and stays disabled", async () => {
  for (const status of [401, 403]) {
    const { doc, sse, client, submit } = judge();
    sse.emit("competition_start", { competition: competition() });
    sse.emit("performance_start", { competition_id: 10, position: 0 });
    sse.emit("enable_scoring", { competition_id: 10, position: 0 });
    const f = stubFetch(() => new Response(null, { status }));
    try {
      submit().onclick();
      await tick();
      await tick();
      assertEquals(
        doc.getElementById("status")!.textContent.startsWith("Access denied"),
        true,
        String(status),
      );
      assertEquals(submit().disabled, true);
    } finally {
      f.restore();
      client.destroy();
    }
  }
});
