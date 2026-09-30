import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  AudioLibrary,
  AudioRejectedError,
  MemoryAudioMetadata,
  sniffFormat,
} from "../../src/audioLibrary.ts";
import { DiskAudioStorage } from "../../src/audioStorage.ts";

const mp3 = (n = 64, fill = 1) => {
  const b = new Uint8Array(n).fill(fill);
  b.set([0x49, 0x44, 0x33]); // "ID3"
  return b;
};
const wav = () => {
  const b = new Uint8Array(64);
  b.set(new TextEncoder().encode("RIFF"), 0);
  b.set(new TextEncoder().encode("WAVE"), 8);
  return b;
};
const REF = { competitionId: 10, competitorId: 100, kind: "music" } as const;

async function withLibrary(
  fn: (lib: AudioLibrary, dir: string) => Promise<void>,
  maxBytes?: number,
) {
  const dir = await Deno.makeTempDir();
  try {
    await fn(
      new AudioLibrary(
        new DiskAudioStorage(dir),
        new MemoryAudioMetadata(),
        maxBytes,
      ),
      dir,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("sniffFormat: recognises mp3 and wav by content, rejects others", () => {
  assertEquals(sniffFormat(mp3()), "mp3");
  assertEquals(sniffFormat(new Uint8Array([0xff, 0xfb, 0x90, 0])), "mp3");
  assertEquals(sniffFormat(wav()), "wav");
  assertEquals(
    sniffFormat(new TextEncoder().encode("hello world!!")),
    undefined,
  );
  assertEquals(sniffFormat(new Uint8Array()), undefined);
});

Deno.test("audio: add stores the file and can read it back", () =>
  withLibrary(async (lib) => {
    const rec = await lib.add(REF, mp3());
    assertEquals(rec.contentType, "audio/mpeg");
    assertEquals(rec.bytes, 64);
    const opened = await lib.open(rec);
    assertEquals(opened?.size, 64);
    opened?.file.close();
  }));

Deno.test("audio: bad uploads are refused (empty, wrong type, too big)", () =>
  withLibrary(async (lib) => {
    await assertRejects(
      () => lib.add(REF, new Uint8Array()),
      AudioRejectedError,
    );
    await assertRejects(
      () => lib.add(REF, new TextEncoder().encode("not audio at all")),
      AudioRejectedError,
      "mp3 or wav",
    );
    const err = await assertRejects(
      () => lib.add(REF, mp3(200)),
      AudioRejectedError,
    );
    assertEquals(err.status, 413);
    assertEquals(await lib.get(REF), undefined);
  }, 100));

Deno.test("audio: replacing removes the old file, but not one another slot still uses", () =>
  withLibrary(async (lib, dir) => {
    const first = await lib.add(REF, mp3(64, 1));
    // A second slot with identical bytes shares the stored file.
    await lib.add({ ...REF, kind: "announce" }, mp3(64, 1));
    await lib.add(REF, mp3(64, 2));
    assert(await lib.open(first), "shared file must survive");

    const slot = { ...REF, competitorId: 101 };
    const solo = await lib.add(slot, mp3(64, 3));
    await lib.add(slot, mp3(64, 4));
    assertEquals(await lib.open(solo), undefined, "unused old file is removed");
    const files = [...Deno.readDirSync(dir)].map((f) => f.name);
    assertEquals(files.some((f) => f.endsWith(".tmp")), false);
  }));

Deno.test("audio: missing() lists every slot without a file", () =>
  withLibrary(async (lib) => {
    await lib.add(REF, mp3());
    const missing = await lib.missing(
      [{ id: 10, competitors: [{ id: 100 }, { id: 101 }] }],
      ["announce", "music"],
    );
    assertEquals(
      missing.map((m) => `${m.competitorId}:${m.kind}`),
      ["100:announce", "101:announce", "101:music"],
    );
  }));

Deno.test("storage: keys that could escape the directory are refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const s = new DiskAudioStorage(dir);
    await assertRejects(() => s.put("../evil.mp3", mp3()), Error, "unsafe");
    await assertRejects(() => s.open("a/b"), Error, "unsafe");
    assertEquals(await s.open("missing.mp3"), undefined);
    await s.delete("missing.mp3"); // no error
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
