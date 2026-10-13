// A DJ is offered the audio of the whole track, from the start of the day.
import { assertEquals } from "@std/assert";
import type { FestivalData } from "../../../shared/festival-bundle/mod.ts";
import { announceAudio } from "../../src/audioAnnouncer.ts";
import {
  AudioLibrary,
  type AudioMetadataStore,
} from "../../src/audioLibrary.ts";
import { buildManifest, trackAudioDigest } from "../../src/audioManifest.ts";
import { DiskAudioStorage } from "../../src/audioStorage.ts";
import { Festival } from "../../src/festival.ts";
import { createMockClient } from "../test-utils.ts";

const ref = (n: number) => ({
  sha256: n.toString(16).padStart(64, "0"),
  content_type: "audio/mpeg" as const,
  bytes: n,
});
const entry = (id: number, order: number, music?: number) => ({
  id,
  name: `P${id}`,
  type: "individual" as const,
  order_number: order,
  duration: 15,
  audio: music === undefined ? {} : { music: ref(music) },
});
const session = (
  id: number,
  order: number,
  start: string,
  ...competitions: { id: number; entries: ReturnType<typeof entry>[] }[]
) => ({
  id,
  name: `S${id}`,
  start_time: start,
  order_number: order,
  competitions: competitions.map((c, i) => ({
    id: c.id,
    name: `C${c.id}`,
    order_number: i + 1,
    rubric_id: 5,
    competitors: c.entries,
  })),
});

/** Track 1: "Late" (starts 14:00) before "Early" (13:00) in the file; track 2 alone. */
const data: FestivalData = {
  festival: {
    id: 1,
    name: "F",
    rubrics: [{
      id: 5,
      name: "R",
      criteria: [{ id: 1, name: "T", weight: 1 }],
      judges: [{ id: 31, name: "Ada", criteria: [1] }],
    }],
    tracks: [
      {
        id: 1,
        name: "Main",
        location: "Hall",
        sessions: [
          session(20, 2, "2030-01-01T14:00:00Z", {
            id: 200,
            entries: [entry(3, 1, 30)],
          }),
          session(10, 1, "2030-01-01T13:00:00Z", {
            id: 100,
            entries: [entry(1, 1, 10), entry(2, 2, 20)],
          }),
        ],
      },
      {
        id: 2,
        name: "Side",
        location: "Hall",
        sessions: [
          session(30, 1, "2030-01-01T13:00:00Z", {
            id: 300,
            entries: [entry(4, 1, 40)],
          }),
        ],
      },
    ],
  },
};

const f = new Festival(data, "test");
const meta: AudioMetadataStore = {
  get: (r) => Promise.resolve(f.audioFile(r)),
  listForCompetitions: (ids) => Promise.resolve(f.audioFor(ids)),
};
const audio = new AudioLibrary(new DiskAudioStorage("/nonexistent"), meta);
const source = { competitions: (t: number) => f.trackCompetitions(t) };

Deno.test("manifest: the whole track's audio, in running order, before any session starts", async () => {
  const m = await buildManifest(audio, source, 1);
  assertEquals(m.track_id, 1);
  assertEquals(
    m.files.map((x) => `${x.competition_id}:${x.competitor_id}`),
    ["100:1", "100:2", "200:3"],
  );
  assertEquals(m.digest, await trackAudioDigest(audio, f.trackCompetitions(1)));
});

Deno.test("manifest: another track's audio is not in it, and the sets differ", async () => {
  const one = await buildManifest(audio, source, 1);
  const two = await buildManifest(audio, source, 2);
  assertEquals(two.files.map((x) => x.competitor_id), [4]);
  assertEquals(one.digest === two.digest, false);
});

Deno.test("manifest: a track with no audio (or none in the bundle) has an empty digest", async () => {
  const m = await buildManifest(audio, source, 99);
  assertEquals([m.files, m.digest], [[], ""]);
});

Deno.test("announcer: a DJ is told once about its track's set, at any time of day", async () => {
  const mock = createMockClient("dj1");
  const deps = { audio, source, connectedClients: () => [mock] };
  await announceAudio(deps);
  await announceAudio(deps);
  const told = (mock as unknown as { __messages: string[] }).__messages.filter((
    x: string,
  ) => x.startsWith("event: audio_available"));
  assertEquals(told.length, 1);
  const body = JSON.parse(told[0].split("data: ")[1]);
  assertEquals([body.track_id, body.count], [1, 3]);
});
