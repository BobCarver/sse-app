import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  renderDevice,
  renderJudges,
  renderOverview,
  type ViewState,
} from "../../frontend-src/adminView.ts";
import { qrSvg, shareLinks, whatsappNumber } from "../../frontend-src/admin.ts";
// Test-only: an independent decoder, to prove the codes actually scan.
import { decode } from "@pinta365/qr/decode";
import type { AdminOverview, OverviewSession } from "../../src/adminTypes.ts";

const state = (
  open: Record<string, boolean> = {},
  now = Date.parse("2030-01-01T00:00:00Z"),
): ViewState => ({
  isOpen: (key, dflt) => open[key] ?? dflt,
  now,
});

const session = (over: Partial<OverviewSession> = {}): OverviewSession => ({
  id: 10,
  name: "Morning",
  status: "in_progress",
  start_time: "2030-01-01T12:00:00Z",
  audio_cutoff: "2030-01-01T11:30:00Z",
  running: false,
  live: null,
  competitions: [{
    id: 100,
    name: "Jive <b>",
    order: 1,
    status: "in_progress",
    judges: [{ id: 31, name: "Ada" }, { id: 32, name: "Ben" }],
    competitors: [
      {
        id: 1,
        name: "Al",
        type: "individual",
        order: 1,
        duration: 15,
        status: "finished",
        scored_by: 2,
        audio: { announce: true, music: true },
      },
      {
        id: 2,
        name: "Bo & Cy",
        type: "couple",
        order: 2,
        duration: null,
        status: "in_progress",
        scored_by: 1,
        audio: { announce: false, music: true },
      },
      {
        id: 3,
        name: "Di",
        type: "team",
        order: 3,
        duration: 20,
        status: "upcoming",
        scored_by: 0,
        audio: { announce: false, music: false },
      },
    ],
  }],
  ...over,
});

const overview = (s: OverviewSession = session()): AdminOverview => ({
  festivals: [{
    id: 1,
    name: "Fest",
    tracks: [{
      id: 7,
      name: "Main",
      location: "Hall",
      devices: [
        {
          client_id: "dj7",
          kind: "dj",
          name: "DJ",
          connected: true,
          links: [{ id: 5, label: "x", created_at: "2030-01-01T00:00:00Z" }],
        },
        {
          client_id: "sb7",
          kind: "sb",
          name: "Scoreboard",
          connected: false,
          links: [],
        },
      ],
      sessions: [s],
    }],
  }],
  judges: [{
    id: 31,
    name: "Ada",
    email: "ada@x.test",
    device: {
      client_id: "judge31",
      kind: "judge",
      name: "Ada",
      connected: false,
      links: [],
    },
    competitions: [{ id: 100, name: "Jive <b>" }],
  }],
});

Deno.test("admin view: the tree is hierarchical <details> with a triangle at every level", () => {
  const html = renderOverview(overview(), state());
  for (const key of ["f1", "t7", "s10", "c100"]) {
    assertStringIncludes(html, `data-key="${key}"`);
  }
  assertEquals((html.match(/<details /g) ?? []).length, 4);
  assertEquals((html.match(/<summary>/g) ?? []).length, 4);
});

Deno.test("admin view: status shows as colour class AND text, for sessions, competitions and competitors", () => {
  const html = renderOverview(overview(), state());
  assertStringIncludes(html, 'class="session in_progress"');
  assertStringIncludes(html, 'class="competition in_progress"');
  for (
    const [cls, label] of [["finished", "Finished"], [
      "in_progress",
      "In progress",
    ], ["upcoming", "Upcoming"]]
  ) {
    assertStringIncludes(html, `<li class="competitor ${cls}">`);
    assertStringIncludes(html, `<span class="badge ${cls}">${label}</span>`);
  }
  assertStringIncludes(html, "scored 2/2");
  assertStringIncludes(html, "scored 1/2");
});

Deno.test("admin view: names are escaped (no markup from the database reaches the page)", () => {
  const html = renderOverview(overview(), state());
  assert(!html.includes("Jive <b>")); // the raw name never appears
  assertStringIncludes(html, "Jive &lt;b&gt;");
  assertStringIncludes(html, "Bo &amp; Cy");
});

Deno.test("admin view: open/closed follows the saved state, with sensible defaults", () => {
  const dflt = renderOverview(overview(), state());
  assertStringIncludes(
    dflt,
    '<details data-key="s10" class="session in_progress" open>',
  ); // not finished: open
  assertStringIncludes(
    dflt,
    '<details data-key="c100" class="competition in_progress" open>',
  ); // in progress: open

  const closed = renderOverview(
    overview(session({ status: "finished" })),
    state(),
  );
  assert(!closed.includes('data-key="s10" class="session finished" open'));

  const saved = renderOverview(overview(), state({ s10: false, f1: false }));
  assert(!saved.includes('data-key="s10" class="session in_progress" open'));
  assert(!saved.includes('data-key="f1" class="festival" open'));
});

Deno.test("admin view: session controls follow whether it is running", () => {
  const idle = renderOverview(overview(), state());
  assertStringIncludes(idle, 'data-action="start" data-id="10" >');
  assertStringIncludes(idle, 'data-action="skip" data-id="10" disabled');
  assertStringIncludes(idle, 'data-action="abort" data-id="10" disabled');

  const running = renderOverview(
    overview(
      session({
        running: true,
        live: {
          phase: "performing",
          competition_name: "Jive",
          position: 1,
          waiting_for: ["judge31"],
        },
      }),
    ),
    state(),
  );
  assertStringIncludes(running, 'data-action="start" data-id="10" disabled');
  assertStringIncludes(running, "performing · Jive #2 · waiting for judge31");
  assert(!running.includes('data-action="skip" data-id="10" disabled'));

  const done = renderOverview(
    overview(session({ status: "finished" })),
    state(),
  );
  assertStringIncludes(done, ">Run again<");
});

Deno.test("admin view: audio status and the upload note", () => {
  const afterCutoff = Date.parse("2030-01-01T12:00:00Z");
  const html = renderOverview(overview(), state({}, afterCutoff));
  assertStringIncludes(html, 'class="audio have"');
  assertStringIncludes(html, 'class="audio missing"');
  assertStringIncludes(
    html,
    'data-competition="100" data-competitor="2" data-kind="announce"',
  );
  assertStringIncludes(html, "Audio uploads are closed"); // the cut-off has passed
  const early = renderOverview(
    overview(),
    state({}, Date.parse("2029-12-31T00:00:00Z")),
  );
  assertStringIncludes(early, "Audio uploads close ");
});

Deno.test("admin view: devices show connection and links, with new-link and revoke actions", () => {
  const html = renderOverview(overview(), state());
  assertStringIncludes(html, 'data-client="dj7"');
  assertStringIncludes(html, 'class="dot on"');
  assertStringIncludes(html, 'class="dot off"');
  assertStringIncludes(html, 'data-action="revoke" data-id="5"');
  assertStringIncludes(html, "no active links"); // the scoreboard has none
  assertStringIncludes(
    renderDevice(overview().judges[0].device, { email: 'a"b@x.test' }),
    'data-email="a&quot;b@x.test"',
  );
});

Deno.test("admin view: the judges tab lists judges with email and what they judge", () => {
  const html = renderJudges(overview());
  assertStringIncludes(html, "judge31");
  assertStringIncludes(html, "ada@x.test");
  assertStringIncludes(html, "Jive &lt;b&gt;");
  assertStringIncludes(
    renderJudges({ festivals: [], judges: [] }),
    "No judges yet",
  );
});

Deno.test("admin view: an empty database explains how to get data", () => {
  assertStringIncludes(
    renderOverview({ festivals: [], judges: [] }, state()),
    "demo:seed",
  );
});

Deno.test("share links: mailto and sms carry the link, encoded", () => {
  const link = "http://192.168.1.5:3000/join/abc_DEF-123";
  const { mailto, sms } = shareLinks(link, "Main DJ", "dj@x.test");
  assert(mailto.startsWith("mailto:dj%40x.test?subject="));
  assertStringIncludes(decodeURIComponent(mailto), link);
  assert(sms.startsWith("sms:?&body="));
  assertStringIncludes(decodeURIComponent(sms), link);
  assert(shareLinks(link, "x").mailto.startsWith("mailto:?subject=")); // no address on file
});

Deno.test("qr: produces an inline SVG for a join link", () => {
  const svg = qrSvg("http://192.168.1.5:3000/join/" + "a".repeat(43));
  assert(svg.startsWith("<svg"));
  assertStringIncludes(svg, "viewBox");
});

Deno.test("qr: the code decodes back to exactly the link (it would scan)", () => {
  const secret = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  for (
    const base of [
      "http://localhost:3000",
      "https://scoring.example.org",
      "http://192.168.100.200:3000",
    ]
  ) {
    const link = `${base}/join/${secret}`;
    const svg = qrSvg(link);
    assert(svg.startsWith("<svg"), "the XML prolog is stripped");
    const side = Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]);
    const dark = new Set(
      [...svg.matchAll(/M(\d+),(\d+)h1v1h-1z/g)].map((m) => `${m[1]},${m[2]}`),
    );
    const border = 2; // the quiet zone around the symbol
    const result = decode({
      size: side - 2 * border,
      isDark: (x: number, y: number) => dark.has(`${x + border},${y + border}`),
    });
    assertEquals(result.text, link);
  }
});

Deno.test("whatsapp: numbers are normalised to what wa.me wants, or refused", () => {
  assertEquals(whatsappNumber("+44 7700 900123"), "447700900123");
  assertEquals(whatsappNumber("(0044) 7700-900123"), "447700900123"); // 00 prefix dropped
  assertEquals(whatsappNumber("+1 (415) 555-2671"), "14155552671");
  assertEquals(whatsappNumber(""), "");
  assertEquals(whatsappNumber("12345"), ""); // too short to be international
  assertEquals(whatsappNumber("1".repeat(16)), ""); // longer than any number
  assertEquals(whatsappNumber("call me"), "");
});

Deno.test("whatsapp: the link carries the message, with or without a number", () => {
  const link = "http://192.168.1.5:3000/join/abc_DEF-123";
  const open = shareLinks(link, "Main DJ").whatsapp;
  assert(
    open.startsWith("https://wa.me/?text="),
    "no number: opens the contact chooser",
  );
  assertStringIncludes(decodeURIComponent(open), link);
  assertStringIncludes(decodeURIComponent(open), "Main DJ");

  const direct = shareLinks(link, "Main DJ", undefined, "+44 7700 900123");
  assert(direct.whatsapp.startsWith("https://wa.me/447700900123?text="));
  assert(direct.sms.startsWith("sms:+447700900123?&body="));
  // A half-typed number is ignored rather than producing a broken link.
  assert(
    shareLinks(link, "x", undefined, "07700").whatsapp.startsWith(
      "https://wa.me/?text=",
    ),
  );
  // The text is encoded: no raw "&" or "?" from the link can break the URL.
  const tricky =
    shareLinks("http://x/join/a?b=1&c=2", "N&M", undefined, "+44 7700 900123")
      .whatsapp;
  assertEquals(tricky.split("?").length, 2);
  assertEquals(
    new URL(tricky).searchParams.get("text")!.includes("a?b=1&c=2"),
    true,
  );
});
