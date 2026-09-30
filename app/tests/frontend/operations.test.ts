// deno-lint-ignore-file no-explicit-any
// Page behaviour for operator actions: session end, scoring closed, skipped
// performance, and the DJ's audio-unlock step.
import { assertEquals } from "@std/assert";
import { DOMParser } from "b-fuze/deno-dom";
import { DjClient } from "../../frontend-src/dj.ts";
import { JudgeClient } from "../../frontend-src/jd.ts";
import { MockEventSource } from "./sse-mocks.ts";
import { applyStyleShim } from "./test-utils.ts";
import { interceptFetch } from "./fetch-mock.ts";

function dom(body: string): Document {
  const d = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${body}</body></html>`,
    "text/html",
  ) as any;
  applyStyleShim(d, "body");
  return d;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const text = (d: Document, id: string) => d.getElementById(id)!.textContent;

const competition = {
  id: 10,
  name: "Comp",
  competitors: [{ id: 100, name: "A", duration: 60 }, {
    id: 101,
    name: "B",
    duration: 60,
  }],
  rubric: {
    criteria: [{ id: 1, name: "Technique" }],
    judges: [{ id: 2, name: "J2", criteria: [1] }, {
      id: 3,
      name: "J3",
      criteria: [1],
    }],
  },
};

// ---- judge ------------------------------------------------------------------

function judge(id = 2) {
  const doc = dom(
    `<div id="sliders"></div><button id="submit">Submit</button><p id="status"></p>`,
  );
  const sse = new MockEventSource();
  const client = new JudgeClient(id, { sse: sse as any, document: doc });
  sse.emit("competition_start", { competition });
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  sse.emit("enable_scoring", { competition_id: 10, position: 0 });
  return {
    doc,
    sse,
    client,
    submit: () => doc.querySelector("#submit") as any,
  };
}

Deno.test("judge: scoring_closed naming this judge disables submit and explains", () => {
  const { doc, sse, client, submit } = judge(2);
  assertEquals(submit().disabled, false);
  sse.emit("scoring_closed", {
    competition_id: 10,
    position: 0,
    missing_judge_ids: [2, 3],
  });
  assertEquals(submit().disabled, true);
  assertEquals(text(doc, "status").startsWith("Scoring closed"), true);
  client.destroy();
});

Deno.test("judge: scoring_closed for other judges leaves this judge alone", () => {
  const { sse, client, submit } = judge(2);
  sse.emit("scoring_closed", {
    competition_id: 10,
    position: 0,
    missing_judge_ids: [3],
  });
  assertEquals(submit().disabled, false);
  client.destroy();
});

Deno.test("judge: after scoring closed, the next competitor's window opens normally", () => {
  const { sse, client, submit } = judge(2);
  sse.emit("scoring_closed", {
    competition_id: 10,
    position: 0,
    missing_judge_ids: [2],
  });
  assertEquals(submit().disabled, true);
  sse.emit("enable_scoring", { competition_id: 10, position: 1 });
  assertEquals(submit().disabled, false);
  client.destroy();
});

Deno.test("judge: session_end shows the outcome and disables submit", () => {
  for (
    const [reason, expected] of [
      ["completed", "Session complete"],
      ["aborted", "Session stopped by an administrator"],
      ["error", "Session ended unexpectedly"],
    ]
  ) {
    const { doc, sse, client, submit } = judge(2);
    sse.emit("session_end", { reason, incomplete: 0 });
    assertEquals(text(doc, "status"), expected);
    assertEquals(submit().disabled, true);
    client.destroy();
  }
});

Deno.test("judge: a missed score is still explained after 'Session complete'", () => {
  const { doc, sse, client } = judge(2);
  sse.emit("scoring_closed", {
    competition_id: 10,
    position: 0,
    missing_judge_ids: [2],
  });
  sse.emit("session_end", { reason: "completed", incomplete: 1 });
  const status = text(doc, "status");
  assertEquals(status.startsWith("Session complete"), true);
  assertEquals(status.includes("your scores were not received"), true);
  client.destroy();
});

Deno.test("judge: a judge who scored is not told they missed anything at session end", () => {
  const { doc, sse, client } = judge(3);
  sse.emit("scoring_closed", {
    competition_id: 10,
    position: 0,
    missing_judge_ids: [2],
  }); // someone else
  sse.emit("session_end", { reason: "completed", incomplete: 1 });
  assertEquals(text(doc, "status"), "Session complete");
  client.destroy();
});

// ---- DJ ---------------------------------------------------------------------

function dj(withUnlock = false) {
  const doc = dom(
    `<button id="start"></button><button id="skip"></button>${
      withUnlock ? '<button id="unlock">Enable audio</button>' : ""
    }<p id="status"></p>`,
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
  sse.emit("competition_start", { competition });
  return {
    doc,
    sse,
    client,
    audio,
    btn: (id: string) => doc.querySelector(id) as any,
  };
}

Deno.test("dj: performance_skipped stops playback and reports the act as skipped", async () => {
  const { doc, sse, client, audio, btn } = dj();
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  await tick();
  // announcement is playing
  assertEquals(audio.src, "10-100-announce");

  const f = interceptFetch();
  try {
    sse.emit("performance_skipped", { competition_id: 10, position: 0 });
    await tick();
    await tick();
    assertEquals(audio.paused, true);
    assertEquals(f.getLastFetch()!.body.payload, false);
    assertEquals(
      text(doc, "status"),
      "Performance skipped by an administrator",
    );
    assertEquals(btn("#skip").disabled, true); // back to the idle state
  } finally {
    f.restore();
    client.destroy();
  }
});

Deno.test("dj: performance_skipped for a different position is ignored", async () => {
  const { sse, client, audio } = dj();
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  await tick();
  sse.emit("performance_skipped", { competition_id: 10, position: 1 });
  await tick();
  assertEquals(audio.paused, false); // still playing
  client.destroy();
});

Deno.test("dj: session_end during a performance stops it and keeps the 'session ended' message", async () => {
  const { doc, sse, client, audio } = dj();
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  await tick();
  const f = interceptFetch();
  try {
    sse.emit("session_end", { reason: "aborted", incomplete: 0 });
    await tick();
    await tick();
    assertEquals(audio.paused, true);
    assertEquals(text(doc, "status"), "Session stopped by an administrator");
  } finally {
    f.restore();
    client.destroy();
  }
});

Deno.test("dj: a performance that starts before 'Enable audio' waits instead of failing", async () => {
  const { doc, sse, client, audio, btn } = dj(true);
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  await tick();
  assertEquals(audio.plays, 0); // nothing played, nothing reported
  assertEquals(text(doc, "status").includes("Enable audio"), true);

  btn("#unlock").onclick(); // the DJ taps the button
  await tick();
  assertEquals(audio.src.startsWith("data:audio/wav"), true); // silent clip plays first
  assertEquals(!!btn("#unlock").hidden, false); // ...and only when it ends is audio "enabled"
  audio.onended();
  await tick();
  await tick();
  assertEquals(btn("#unlock").hidden, true);
  assertEquals(audio.src, "10-100-announce"); // now the announcement plays
  assertEquals(text(doc, "status"), "");
  client.destroy();
});

Deno.test("dj: skipping while waiting for 'Enable audio' does not leave a stuck handler", async () => {
  const { sse, client, audio } = dj(true);
  sse.emit("performance_start", { competition_id: 10, position: 0 });
  await tick();
  const f = interceptFetch();
  try {
    sse.emit("performance_skipped", { competition_id: 10, position: 0 });
    await tick();
    await tick();
    assertEquals(audio.plays, 0);
    assertEquals(f.getLastFetch()!.body.payload, false);
  } finally {
    f.restore();
    client.destroy();
  }
});
