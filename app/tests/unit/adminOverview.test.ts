import { assertEquals } from "@std/assert";
import {
  buildOverview,
  type OverviewRows,
  statusOf,
} from "../../src/adminOverview.ts";
import type { AudioRecord } from "../../src/audioLibrary.ts";
import type { Credential } from "../../src/credentials.ts";

const T = new Date("2030-01-01T12:00:00Z");
const rows = (): OverviewRows => ({
  festivals: [{ id: 1, name: "Fest" }],
  tracks: [{ id: 7, festival_id: 1, name: "Main", location: "Hall" }],
  sessions: [
    {
      id: 20,
      track_id: 7,
      name: "Later",
      status: "upcoming",
      start_time: new Date(T.getTime() + 3600_000),
      current_competition: null,
      current_competitor: null,
    },
    {
      id: 10,
      track_id: 7,
      name: "Morning",
      status: "active",
      start_time: T,
      current_competition: 100,
      current_competitor: 2,
    },
  ],
  competitions: [
    {
      id: 101,
      session_id: 10,
      order_number: 2,
      name: "Waltz",
      status: "upcoming",
      rubric_id: 5,
    },
    {
      id: 100,
      session_id: 10,
      order_number: 1,
      name: "Jive",
      status: "active",
      rubric_id: 5,
    },
  ],
  competitors: [
    {
      competition_id: 100,
      id: 3,
      name: "Cy",
      type: "individual",
      duration: 15,
      order_number: 3,
      status: "upcoming",
    },
    {
      competition_id: 100,
      id: 1,
      name: "Al",
      type: "individual",
      duration: 15,
      order_number: 1,
      status: "performed",
    },
    {
      competition_id: 100,
      id: 2,
      name: null,
      type: "couple",
      duration: null,
      order_number: 2,
      status: "upcoming",
    },
  ],
  rubricJudges: [
    { rubric_id: 5, judge_id: 31, name: "Ada", email: "ada@x.test" },
    { rubric_id: 5, judge_id: 32, name: "Ben", email: null },
  ],
  judges: [
    { id: 31, name: "Ada", email: "ada@x.test" },
    { id: 32, name: "Ben", email: null },
    { id: 33, name: "Cat", email: null },
  ],
  scores: [{ competition_id: 100, competitor_id: 1, judges: 2 }],
});

const cred = (id: number, clientId: string, revoked = false): Credential => ({
  id,
  clientId,
  label: `l${id}`,
  createdAt: T,
  revokedAt: revoked ? T : null,
});
const audio = (
  competitionId: number,
  competitorId: number,
  kind: "announce" | "music",
): AudioRecord => ({
  competitionId,
  competitorId,
  kind,
  storageKey: "k",
  contentType: "audio/mpeg",
  bytes: 1,
  sha256: "s",
});

const build = (over: Partial<Parameters<typeof buildOverview>[1]> = {}) =>
  buildOverview(rows(), {
    audio: [],
    credentials: [],
    connected: new Set(),
    live: () => null,
    cutoffMinutes: 30,
    ...over,
  });

Deno.test("overview: database statuses map to upcoming / in_progress / finished", () => {
  assertEquals(
    ["upcoming", "active", "completed", "weird"].map(statusOf),
    ["upcoming", "in_progress", "finished", "upcoming"],
  );
});

Deno.test("overview: the tree is ordered (sessions by start, competitions and competitors by order)", () => {
  const track = build().festivals[0].tracks[0];
  assertEquals(track.sessions.map((s) => s.name), ["Morning", "Later"]);
  const morning = track.sessions[0];
  assertEquals(morning.competitions.map((c) => c.name), ["Jive", "Waltz"]);
  assertEquals(morning.competitions[0].competitors.map((c) => c.id), [1, 2, 3]);
  assertEquals(morning.competitions[0].judges.map((j) => j.name), [
    "Ada",
    "Ben",
  ]);
  assertEquals(
    morning.audio_cutoff,
    new Date(T.getTime() - 30 * 60_000).toISOString(),
  );
});

Deno.test("overview: competitor status - finished once all judges scored, in progress while performing, else upcoming", () => {
  const [al, second, cy] =
    build().festivals[0].tracks[0].sessions[0].competitions[0].competitors;
  assertEquals([al.status, al.scored_by], ["finished", 2]);
  assertEquals(second.status, "in_progress"); // session.current_competitor = 2
  assertEquals(cy.status, "upcoming");
  assertEquals(second.name, "Competitor 2"); // unnamed competitors still get a label
});

Deno.test("overview: a finished competition makes everyone in it finished", () => {
  const r = rows();
  r.competitions[1].status = "completed";
  r.competitions[1].id = 100; // make the first one 'completed' instead
  r.competitions[0].status = "upcoming";
  const o = buildOverview(
    { ...r, competitions: [{ ...r.competitions[1], status: "completed" }] },
    { audio: [], credentials: [], connected: new Set(), live: () => null },
  );
  const comp =
    o.festivals[0].tracks[0].sessions.find((s) => s.id === 10)!.competitions[0];
  assertEquals(comp.status, "finished");
  assertEquals(comp.competitors.map((c) => c.status), [
    "finished",
    "finished",
    "finished",
  ]);
});

Deno.test("overview: audio flags, links (revoked ones hidden), connection and live state", () => {
  const o = build({
    audio: [
      audio(100, 1, "music"),
      audio(100, 1, "announce"),
      audio(100, 2, "music"),
    ],
    credentials: [cred(1, "dj7"), cred(2, "dj7", true), cred(3, "judge31")],
    connected: new Set(["dj7", "judge32"]),
    live: (id) =>
      id === 10
        ? {
          phase: "performing",
          competition_name: "Jive",
          position: 1,
          waiting_for: [],
        }
        : null,
  });
  const track = o.festivals[0].tracks[0];
  const [al, second] = track.sessions[0].competitions[0].competitors;
  assertEquals(al.audio, { announce: true, music: true });
  assertEquals(second.audio, { announce: false, music: true });

  const [dj, sb] = track.devices;
  assertEquals([dj.client_id, dj.connected, dj.links.map((l) => l.id)], [
    "dj7",
    true,
    [1],
  ]);
  assertEquals([sb.client_id, sb.connected, sb.links], ["sb7", false, []]);

  assertEquals(track.sessions[0].running, true);
  assertEquals(track.sessions[0].live?.phase, "performing");
  assertEquals(track.sessions[1].running, false);

  const judges = o.judges;
  assertEquals(
    judges.map((j) => [j.id, j.device.connected, j.device.links.length]),
    [[31, false, 1], [32, true, 0], [33, false, 0]],
  );
  assertEquals(judges[0].competitions.map((c) => c.name).sort(), [
    "Jive",
    "Waltz",
  ]);
  assertEquals(judges[2].competitions, []); // judge 33 judges nothing yet
  assertEquals(judges[0].email, "ada@x.test");
});

Deno.test("overview: an empty database gives an empty tree", () => {
  const o = buildOverview(
    {
      festivals: [],
      tracks: [],
      sessions: [],
      competitions: [],
      competitors: [],
      rubricJudges: [],
      judges: [],
      scores: [],
    },
    { audio: [], credentials: [], connected: new Set(), live: () => null },
  );
  assertEquals(o, { festivals: [], judges: [] });
});

Deno.test("overview: a skipped competitor is skipped, whatever the competition is doing", () => {
  const r = rows();
  r.competitors.find((c) => c.id === 3)!.status = "skipped";
  const comp = buildOverview(r, {
    audio: [],
    credentials: [],
    connected: new Set(),
    live: () => null,
  }).festivals[0].tracks[0].sessions[0].competitions[0];
  assertEquals(comp.competitors.map((c) => [c.id, c.status]), [
    [1, "finished"],
    [2, "in_progress"],
    [3, "skipped"],
  ]);

  // Even once the competition is finished, the skipped one stays skipped.
  r.competitions.find((c) => c.id === 100)!.status = "completed";
  const done = buildOverview(r, {
    audio: [],
    credentials: [],
    connected: new Set(),
    live: () => null,
  }).festivals[0].tracks[0].sessions[0].competitions[0];
  assertEquals(done.competitors.map((c) => c.status), [
    "finished",
    "finished",
    "skipped",
  ]);
});
