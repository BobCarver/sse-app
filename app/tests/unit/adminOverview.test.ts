import { assertEquals } from "@std/assert";
import type { FestivalData } from "../../../shared/festival-bundle/mod.ts";
import { buildOverview, type ProgressRows } from "../../src/adminOverview.ts";
import type { AudioRecord } from "../../src/audioLibrary.ts";
import type { Credential } from "../../src/credentials.ts";

const T = new Date("2030-01-01T12:00:00Z");
const entry = (id: number, name: string, order: number) => ({
  id,
  name,
  type: "individual" as const,
  order_number: order,
  duration: 15,
  audio: {},
});

/** Festival > track 7 > "Later" (20) and "Morning" (10) > Jive (100), Waltz (101). */
const festival = (): FestivalData => ({
  festival: {
    id: 1,
    name: "Fest",
    rubrics: [{
      id: 5,
      name: "R",
      criteria: [{ id: 1, name: "T", weight: 1 }],
      judges: [
        { id: 31, name: "Ada", criteria: [1] },
        { id: 32, name: "Ben", criteria: [1] },
      ],
    }],
    tracks: [{
      id: 7,
      name: "Main",
      location: "Hall",
      sessions: [
        {
          id: 20,
          name: "Later",
          start_time: new Date(T.getTime() + 3600_000).toISOString(),
          order_number: 2,
          competitions: [],
        },
        {
          id: 10,
          name: "Morning",
          start_time: T.toISOString(),
          order_number: 1,
          competitions: [
            {
              id: 101,
              name: "Waltz",
              order_number: 2,
              rubric_id: 5,
              competitors: [entry(4, "Di", 1)],
            },
            {
              id: 100,
              name: "Jive",
              order_number: 1,
              rubric_id: 5,
              competitors: [
                entry(3, "Cy", 3),
                entry(1, "Al", 1),
                entry(2, "Bo", 2),
              ],
            },
          ],
        },
      ],
    }],
  },
});

/** Session 10 open, the cursor on Bo (competitor 2) performing; Al fully scored. */
const progress = (over: Partial<ProgressRows> = {}): ProgressRows => ({
  runs: [{
    session_id: 10,
    started_at: T,
    finished_at: null,
    cancelled_at: null,
  }],
  cursors: [{
    track_id: 7,
    open_session: 10,
    competition_id: 100,
    competitor_id: 2,
    phase: "performing",
  }],
  skips: [],
  scores: [{ competition_id: 100, competitor_id: 1, judges: 2 }],
  ...over,
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

const ctx = (over: Partial<Parameters<typeof buildOverview>[2]> = {}) => ({
  audio: [],
  credentials: [],
  connected: new Set<string>(),
  live: () => null,
  cutoffMinutes: 30,
  ...over,
});
const build = (rows = progress(), over = {}) =>
  buildOverview(festival(), rows, ctx(over));
const morning = (rows = progress()) =>
  build(rows).festivals[0].tracks[0].sessions[0];

Deno.test("overview: the tree is ordered (sessions by start, competitions and competitors by order)", () => {
  const track = build().festivals[0].tracks[0];
  assertEquals(track.sessions.map((s) => s.name), ["Morning", "Later"]);
  const s = track.sessions[0];
  assertEquals(s.competitions.map((c) => c.name), ["Jive", "Waltz"]);
  assertEquals(s.competitions[0].competitors.map((c) => c.id), [1, 2, 3]);
  assertEquals(s.competitions[0].judges.map((j) => j.name), ["Ada", "Ben"]);
  assertEquals(
    s.audio_cutoff,
    new Date(T.getTime() - 30 * 60_000).toISOString(),
  );
});

Deno.test("overview: statuses come from the cursor - before it finished, on it in progress, after it upcoming", () => {
  const s = morning();
  assertEquals(s.status, "in_progress");
  const [jive, waltz] = s.competitions;
  assertEquals([jive.status, waltz.status], ["in_progress", "upcoming"]);
  assertEquals(
    jive.competitors.map((c) => [c.name, c.status, c.scored_by]),
    [["Al", "finished", 2], ["Bo", "in_progress", 0], ["Cy", "upcoming", 0]],
  );
  // The later session has not started.
  assertEquals(build().festivals[0].tracks[0].sessions[1].status, "upcoming");
});

Deno.test("overview: the next competitor waiting to begin is upcoming, not on now", () => {
  const rows = progress();
  rows.cursors[0] = {
    ...rows.cursors[0],
    competition_id: 101,
    competitor_id: 4,
    phase: null,
  };
  const [jive, waltz] = morning(rows).competitions;
  assertEquals(jive.status, "finished");
  assertEquals(waltz.status, "upcoming");
  assertEquals(waltz.competitors[0].status, "upcoming");
});

Deno.test("overview: a finished session is finished throughout; skips stay skipped", () => {
  const rows = progress({
    runs: [{
      session_id: 10,
      started_at: T,
      finished_at: T,
      cancelled_at: null,
    }],
    cursors: [{
      track_id: 7,
      open_session: null,
      competition_id: null,
      competitor_id: null,
      phase: null,
    }],
    skips: [{ session_id: 10, competition_id: 100, competitor_id: 3 }],
  });
  const s = morning(rows);
  assertEquals(s.status, "finished");
  assertEquals(s.competitions.map((c) => c.status), ["finished", "finished"]);
  assertEquals(s.competitions[0].competitors.map((c) => c.status), [
    "finished",
    "finished",
    "skipped",
  ]);
});

Deno.test("overview: a skipped competitor before the cursor shows as skipped", () => {
  const rows = progress({
    skips: [{ session_id: 10, competition_id: 100, competitor_id: 1 }],
  });
  assertEquals(
    morning(rows).competitions[0].competitors.map((c) => [c.id, c.status]),
    [[1, "skipped"], [2, "in_progress"], [3, "upcoming"]],
  );
});

Deno.test("overview: audio flags, links (revoked ones hidden), connection and live state", () => {
  const o = build(progress(), {
    audio: [
      audio(100, 1, "music"),
      audio(100, 1, "announce"),
      audio(100, 2, "music"),
    ],
    credentials: [cred(1, "dj7"), cred(2, "dj7", true), cred(3, "judge31")],
    connected: new Set(["dj7", "judge32"]),
    live: (id: number) =>
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
  const [al, bo] = track.sessions[0].competitions[0].competitors;
  assertEquals(al.audio, { announce: true, music: true });
  assertEquals(bo.audio, { announce: false, music: true });

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

  // Judges come from the rubrics; the bundle carries no emails.
  assertEquals(
    o.judges.map((j) => [j.id, j.device.connected, j.device.links.length]),
    [[31, false, 1], [32, true, 0]],
  );
  assertEquals(o.judges[0].competitions.map((c) => c.name), ["Jive", "Waltz"]);
  assertEquals(o.judges[0].email, null);
});

Deno.test("overview: no festival loaded gives an empty tree", () => {
  const o = buildOverview(
    { festival: { id: 0, name: "", rubrics: [], tracks: [] } },
    { runs: [], cursors: [], skips: [], scores: [] },
    ctx(),
  );
  assertEquals(o, { festivals: [], judges: [] });
});
