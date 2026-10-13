import { assertEquals, assertRejects } from "@std/assert";
import {
  AudioLibrary,
  type AudioRecord,
  MemoryAudioMetadata,
} from "../../src/audioLibrary.ts";
import { DiskAudioStorage } from "../../src/audioStorage.ts";

const mp3 = (n = 64, fill = 1) => {
  const b = new Uint8Array(n).fill(fill);
  b.set([0x49, 0x44, 0x33]); // "ID3"
  return b;
};
const REC: AudioRecord = {
  competitionId: 10,
  competitorId: 100,
  kind: "music",
  storageKey: "a".repeat(64) + ".mp3",
  contentType: "audio/mpeg",
  bytes: 64,
  sha256: "a".repeat(64),
};

async function withLibrary(
  fn: (lib: AudioLibrary, dir: string, meta: MemoryAudioMetadata) => Promise<
    void
  >,
) {
  const dir = await Deno.makeTempDir();
  const meta = new MemoryAudioMetadata();
  try {
    await fn(new AudioLibrary(new DiskAudioStorage(dir), meta), dir, meta);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("audio: a file in the audio folder is found by its record", () =>
  withLibrary(async (lib, dir, meta) => {
    await Deno.writeFile(`${dir}/${REC.storageKey}`, mp3());
    meta.set(REC);
    const rec = await lib.get(REC);
    assertEquals(rec?.sha256, REC.sha256);
    const opened = await lib.open(rec!);
    assertEquals(opened?.size, 64);
    opened?.file.close();
    assertEquals(await lib.list([10]), [REC]);
    assertEquals(await lib.list([11]), []);
  }));

Deno.test("audio: missing() lists every slot without a file", () =>
  withLibrary(async (lib, _dir, meta) => {
    meta.set(REC);
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
