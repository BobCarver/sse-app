// Loading the festival bundle: verification refuses a bad copy with a clear
// message; the in-memory festival answers what the database used to.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { BundleError, loadBundle } from "../../src/bundle.ts";
import { Festival } from "../../src/festival.ts";
import {
  type BundleFiles,
  demoBundle,
  e2eBundle,
  writeBundle,
} from "../../../scripts/fixtures.ts";

async function withBundle(
  files: BundleFiles,
  fn: (dir: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  try {
    await writeBundle(dir, files);
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const problemsOf = async (p: Promise<unknown>) =>
  (await assertRejects(() => p, BundleError)).problems;

Deno.test("bundle: the committed e2e fixture is what scripts/fixtures.ts makes (run `deno task fixtures`)", async () => {
  const want = await e2eBundle();
  const dir = new URL("../../../fixtures/bundles/e2e/", import.meta.url)
    .pathname;
  assertEquals(await Deno.readTextFile(`${dir}data.json`), want.dataText);
  assertEquals(
    await Deno.readTextFile(`${dir}manifest.json`),
    want.manifestText,
  );
  for (const [name, bytes] of want.audio) {
    assertEquals(await Deno.readFile(`${dir}audio/${name}`), bytes);
  }
  const loaded = await loadBundle(dir, `${dir}audio`);
  assertEquals(loaded.data.festival.name, "test1");
});

Deno.test("bundle: a good bundle loads; the same data gives the same digest", async () => {
  const files = await demoBundle();
  await withBundle(files, async (dir) => {
    const b = await loadBundle(dir, `${dir}/audio`);
    assertEquals(b.dataText, files.dataText);
    assertEquals(b.manifest.audio.length, 6); // one announcement shared by all
    assertEquals(
      b.manifest.digest,
      JSON.parse((await demoBundle()).manifestText).digest,
    );
  });
});

Deno.test("bundle: a missing, short or damaged audio file is refused", async () => {
  const files = await e2eBundle();
  const [name, bytes] = [...files.audio][0];
  await withBundle(files, async (dir) => {
    await Deno.remove(`${dir}/audio/${name}`);
    const missing = await problemsOf(loadBundle(dir, `${dir}/audio`));
    assert(missing[0].includes("is missing"), missing[0]);

    await Deno.writeFile(`${dir}/audio/${name}`, bytes.subarray(0, 100));
    const short = await problemsOf(loadBundle(dir, `${dir}/audio`));
    assert(short[0].includes("incomplete copy"), short[0]);

    const damaged = bytes.slice();
    damaged[damaged.length - 1] ^= 0xff;
    await Deno.writeFile(`${dir}/audio/${name}`, damaged);
    const bad = await problemsOf(loadBundle(dir, `${dir}/audio`));
    assert(bad[0].includes("does not match its sha256"), bad[0]);
  });
});

Deno.test("bundle: an edited data.json or a missing manifest is refused", async () => {
  const files = await e2eBundle();
  await withBundle(files, async (dir) => {
    await Deno.writeTextFile(
      `${dir}/data.json`,
      files.dataText.replace("Competitor 1", "Competitor One"),
    );
    const edited = await problemsOf(loadBundle(dir, `${dir}/audio`));
    assert(edited.some((p) => p.includes("data_sha256 does not match")));

    await Deno.remove(`${dir}/manifest.json`);
    const none = await problemsOf(loadBundle(dir, `${dir}/audio`));
    assert(none[0].includes("manifest.json not found"), none[0]);
  });
  // The message lists every problem, readable on the console.
  assert(new BundleError(["a", "b"]).message.includes("\n  - a\n  - b"));
});

Deno.test("festival: sessions, tracks, judges and audio come from the bundle", async () => {
  const f = new Festival(JSON.parse((await demoBundle()).dataText), "d");
  assert(f.loaded);
  const comps = f.sessionCompetitions(1000);
  assertEquals(comps.map((c) => c.name), ["Solo Jive", "Showcase Waltz"]);
  // The same shape as the database used to give (and clients receive).
  assertEquals(comps[0].competitors[0], {
    id: 1001,
    name: "Alex Rivera",
    duration: 15,
  });
  assertEquals(comps[0].rubric, {
    id: 1000,
    criteria: [
      { id: 1000, name: "Technique", weight: 1 },
      { id: 1001, name: "Musicality", weight: 1 },
    ],
    judges: [
      { id: 1001, name: "Judge Ada", criteria: [1000, 1001] },
      { id: 1002, name: "Judge Ben", criteria: [1000, 1001] },
    ],
  });
  assertEquals(f.sessionCompetitions(999), []);
  assertEquals(f.sessionTrackId(1000), 1000);
  assertEquals(f.competition(1001), { sessionId: 1000, trackId: 1000 });
  assertEquals([f.hasTrack(1000), f.hasTrack(1)], [true, false]);
  assertEquals([f.hasJudge(1002), f.hasJudge(3)], [true, false]);
  const music = f.audioFile({
    competitionId: 1000,
    competitorId: 1001,
    kind: "music",
  });
  assertEquals(music?.contentType, "audio/wav");
  assertEquals(music?.storageKey, `${music?.sha256}.wav`);
  assertEquals(f.audioFor([1001]).length, 4); // 2 entries x announce + music
  assert(!Festival.empty().loaded);
});

Deno.test("festival: next and following sessions skip the ones already done", () => {
  const session = (id: number, start: string, order: number) => ({
    id,
    name: `S${id}`,
    start_time: start,
    order_number: order,
    competitions: [],
  });
  const f = new Festival({
    festival: {
      id: 1,
      name: "F",
      rubrics: [],
      tracks: [{
        id: 1,
        name: "T",
        location: "L",
        sessions: [
          session(3, "2026-10-20T14:00:00Z", 3),
          session(1, "2026-10-20T10:00:00Z", 1),
          session(2, "2026-10-20T10:00:00Z", 2), // same start: order_number decides
        ],
      }],
    },
  });
  assertEquals(f.trackSessions(1).map((s) => s.id), [1, 2, 3]);
  assertEquals(f.nextSession(1, new Set())?.id, 1);
  assertEquals(f.nextSession(1, new Set([1]))?.id, 2);
  assertEquals(f.nextSession(1, new Set(), 3)?.id, 3); // the open one first
  assertEquals(f.followingSession(1, new Set())?.id, 2);
  assertEquals(f.followingSession(1, new Set([2]))?.id, 3);
  assertEquals(f.followingSession(3, new Set()), undefined);
});
