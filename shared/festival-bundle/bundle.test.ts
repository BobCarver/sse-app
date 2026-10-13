import { assert, assertEquals } from "@std/assert";
import {
  bundleDigest,
  canonicalData,
  type FestivalData,
  makeManifest,
  resolveSession,
  sha256Hex,
  validateData,
  validateManifest,
} from "./mod.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** Two rubrics, one track, one session with three competitions (one empty). */
function festival(): FestivalData {
  return {
    festival: {
      id: 1,
      name: "Autumn Open",
      rubrics: [
        {
          id: 1,
          name: "Standard",
          criteria: [
            { id: 1, name: "Technique", weight: 1 },
            { id: 2, name: "Musicality", weight: 1 },
          ],
          judges: [{ id: 1001, name: "Ada", criteria: [1, 2] }],
        },
        {
          id: 2,
          name: "Showcase",
          criteria: [{ id: 3, name: "Show", weight: 2 }],
          judges: [
            { id: 1001, name: "Ada", criteria: [3] },
            { id: 1002, name: "Ben", criteria: [3] },
          ],
        },
      ],
      tracks: [{
        id: 1,
        name: "Main floor",
        location: "Hall A",
        sessions: [{
          id: 1000,
          name: "Session 1",
          start_time: "2026-10-20T18:00:00Z",
          order_number: 1,
          competitions: [
            {
              id: 1001,
              name: "Showcase",
              order_number: 2,
              rubric_id: 2,
              competitors: [{
                id: 1003,
                name: "Team",
                type: "team",
                order_number: 1,
                duration: 30,
                audio: {
                  music: {
                    sha256: SHA_B,
                    content_type: "audio/mpeg",
                    bytes: 20,
                  },
                },
              }],
            },
            {
              id: 1000,
              name: "Latin solo",
              order_number: 1,
              rubric_id: 1,
              competitors: [
                {
                  id: 1002,
                  name: "Sam",
                  type: "individual",
                  order_number: 2,
                  duration: 15,
                  audio: {},
                },
                {
                  id: 1001,
                  name: "Alex",
                  type: "individual",
                  order_number: 1,
                  duration: 15,
                  audio: {
                    music: {
                      sha256: SHA_A,
                      content_type: "audio/mpeg",
                      bytes: 10,
                    },
                    announce: {
                      sha256: SHA_A,
                      content_type: "audio/mpeg",
                      bytes: 10,
                    },
                  },
                },
              ],
            },
            {
              id: 1002,
              name: "Nobody entered",
              order_number: 3,
              rubric_id: 1,
              competitors: [],
            },
          ],
        }],
      }],
    },
  };
}

const session = (d: FestivalData) => d.festival.tracks[0].sessions[0];

Deno.test("bundle: a well-formed festival has no problems", () => {
  assertEquals(validateData(festival()), []);
});

Deno.test("bundle: the same data exports to the same bytes and digest, in any input order", async () => {
  const a = festival();
  const b = festival();
  b.festival.rubrics.reverse();
  session(b).competitions.reverse();
  session(b).competitions[1].competitors.reverse();
  const [ta, tb] = [canonicalData(a), canonicalData(b)];
  assertEquals(ta, tb);
  const [ma, mb] = await Promise.all([
    makeManifest({ dataText: ta, generatedAt: "2026-10-20T00:00:00Z" }),
    makeManifest({ dataText: tb, generatedAt: "2026-10-20T00:00:00Z" }),
  ]);
  assertEquals(ma.digest, mb.digest);
  // Keys are sorted and entries come in running order.
  const parsed = JSON.parse(ta);
  assertEquals(Object.keys(parsed.festival), [
    "id",
    "name",
    "rubrics",
    "tracks",
  ]);
  assertEquals(
    parsed.festival.tracks[0].sessions[0].competitions.map((
      c: { id: number },
    ) => c.id),
    [1000, 1001, 1002],
  );
  // Any exported field changed: a different digest.
  const c = festival();
  session(c).competitions[0].competitors[0].duration = 31;
  const mc = await makeManifest({
    dataText: canonicalData(c),
    generatedAt: "2026-10-20T00:00:00Z",
  });
  assert(mc.digest !== ma.digest);
});

Deno.test("bundle: the manifest lists each distinct audio file once", async () => {
  const text = canonicalData(festival());
  const m = await makeManifest({
    dataText: text,
    generatedAt: "2026-10-20T00:00:00Z",
  });
  assertEquals(m.audio.map((a) => a.sha256), [SHA_A, SHA_B]);
  assertEquals(m.data_sha256, await sha256Hex(text));
  assertEquals(m.digest, await bundleDigest(m.data_sha256, [SHA_B, SHA_A]));
  assertEquals(await validateManifest(m, text, festival()), []);
});

Deno.test("bundle: running order must be strict at every level", () => {
  const d = festival();
  session(d).competitions[1].competitors[0].order_number = 1; // two entries at 1
  session(d).competitions[2].order_number = 2; // two competitions at 2
  d.festival.tracks[0].sessions.push({
    ...session(festival()),
    id: 2000,
    competitions: [],
  }); // two sessions at 1 on the track
  const problems = validateData(d);
  assert(
    problems.some((p) =>
      p.includes("competitor 1001") && p.includes("order_number 1")
    ),
  );
  assert(
    problems.some((p) =>
      p.includes("competition 1002") && p.includes("order_number 2")
    ),
  );
  assert(
    problems.some((p) =>
      p.includes("session 2000") && p.includes("order_number 1")
    ),
  );

  const missing = festival() as unknown as {
    festival: { tracks: { sessions: { order_number?: number }[] }[] };
  };
  delete missing.festival.tracks[0].sessions[0].order_number;
  assert(
    validateData(missing).some((p) =>
      p.includes("`order_number` must be an integer")
    ),
  );
});

Deno.test("bundle: rubric references are checked", () => {
  const d = festival();
  session(d).competitions[0].rubric_id = 9;
  assert(
    validateData(d).some((p) =>
      p.includes("rubric_id 9 is not one of the festival's rubrics")
    ),
  );

  const dup = festival();
  dup.festival.rubrics[1].id = 1;
  assert(
    validateData(dup).some((p) =>
      p.includes("rubric 1: id is used by another rubric")
    ),
  );

  const outside = festival();
  outside.festival.rubrics[0].judges[0].criteria = [1, 3];
  assert(
    validateData(outside).some((p) =>
      p.includes("judge 1001 scores criterion 3, which is not in the rubric")
    ),
  );

  const nobody = festival();
  nobody.festival.rubrics[1].judges = [];
  assert(
    validateData(nobody).some((p) =>
      p.includes("rubric 2: needs at least one judge")
    ),
  );
});

Deno.test("bundle: ids, times and audio references are checked", () => {
  const d = festival();
  session(d).start_time = "2026-10-20 18:00";
  session(d).competitions[0].id = 1000; // same id as another competition
  session(d).competitions[1].competitors[1].audio.music!.sha256 = "XYZ";
  const problems = validateData(d);
  assert(problems.some((p) => p.includes("start_time")));
  assert(
    problems.some((p) =>
      p.includes("competition 1000: id is used by another competition")
    ),
  );
  assert(
    problems.some((p) => p.includes("music needs a lower-case hex `sha256`")),
  );
  assertEquals(validateData({}), [
    "data.json: expected an object with a `festival`",
  ]);
});

Deno.test("bundle: a manifest that does not match its data is refused", async () => {
  const text = canonicalData(festival());
  const good = await makeManifest({
    dataText: text,
    generatedAt: "2026-10-20T00:00:00Z",
  });
  const data = festival();

  // data.json changed after export
  const edited = text.replace('"Alex"', '"Alexa"');
  assert((await validateManifest(good, edited, JSON.parse(edited)))
    .some((p) => p.includes("data_sha256 does not match")));
  // digest tampered
  assert((await validateManifest({ ...good, digest: SHA_A }, text, data))
    .some((p) => p.includes("digest does not match")));
  // a file used by data.json but not listed, and one listed but not used
  const wrongList = {
    ...good,
    audio: [good.audio[0], {
      sha256: "c".repeat(64),
      bytes: 1,
      content_type: "audio/wav" as const,
    }],
  };
  const problems = await validateManifest(wrongList, text, data);
  assert(
    problems.some((p) =>
      p.includes(`${SHA_B} is used in data.json but not listed`)
    ),
  );
  assert(problems.some((p) => p.includes("is listed but not used")));
  // another format version
  assert((await validateManifest({ ...good, bundle_version: 2 }, text, data))[0]
    .includes("bundle_version 2 is not supported"));
});

Deno.test("bundle: each competition gets the rubric it names, in running order", () => {
  const resolved = resolveSession(festival(), 1000)!;
  // the empty competition is left out
  assertEquals(resolved.map((c) => [c.id, c.rubric.id]), [[1000, 1], [
    1001,
    2,
  ]]);
  assertEquals(resolved[0].competitors.map((p) => p.id), [1001, 1002]);
  assertEquals(resolved[1].rubric.judges.map((j) => j.id), [1001, 1002]);
  assertEquals(resolveSession(festival(), 999), undefined);
});
