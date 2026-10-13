/**
 * Festival bundles for the browser tests and the demo (they replace the old
 * SQL seeds). Each is defined here in code and written as a real bundle
 * folder: manifest.json, data.json and audio/<sha256>.<ext>.
 *
 *   deno task fixtures          # fixtures/bundles/e2e (committed)
 *   deno task demo:bundle       # fixtures/bundles/demo (generated, not committed)
 */
import {
  type AudioContentType,
  type BundleAudioRef,
  canonicalData,
  canonicalJson,
  type FestivalData,
  makeManifest,
  sha256Hex,
} from "../shared/festival-bundle/mod.ts";

/** A bundle in memory: what writeBundle puts on disk. */
export interface BundleFiles {
  dataText: string;
  manifestText: string;
  /** File name (`<sha256>.<ext>`) -> bytes. */
  audio: Map<string, Uint8Array>;
}

/** Collects the audio files a fixture refers to, by content. */
export class AudioSet {
  readonly files = new Map<string, Uint8Array>();
  async add(
    bytes: Uint8Array,
    contentType: AudioContentType = "audio/wav",
  ): Promise<BundleAudioRef> {
    const sha256 = await sha256Hex(bytes);
    const ext = contentType === "audio/wav" ? "wav" : "mp3";
    this.files.set(`${sha256}.${ext}`, bytes);
    return { sha256, content_type: contentType, bytes: bytes.length };
  }
}

/** Serialise a festival the way the portal's exporter does. */
export async function buildBundle(
  data: FestivalData,
  audio: AudioSet,
  generatedAt = "2026-01-01T00:00:00Z",
): Promise<BundleFiles> {
  const dataText = canonicalData(data);
  const manifest = await makeManifest({ dataText, generatedAt });
  return {
    dataText,
    manifestText: canonicalJson(manifest),
    audio: audio.files,
  };
}

/** Write a bundle folder; audio goes to `audioDir` (default `<dir>/audio`). */
export async function writeBundle(
  dir: string,
  files: BundleFiles,
  audioDir = `${dir}/audio`,
): Promise<void> {
  await Deno.mkdir(audioDir, { recursive: true });
  await Deno.writeTextFile(`${dir}/data.json`, files.dataText);
  await Deno.writeTextFile(`${dir}/manifest.json`, files.manifestText);
  for (const [name, bytes] of files.audio) {
    await Deno.writeFile(`${audioDir}/${name}`, bytes);
  }
}

// --- generated audio ---------------------------------------------------------

/** A mono 16-bit WAV of `seconds`, stepping through `notes` (0 = rest). */
export function makeWav(
  seconds: number,
  notes: number[],
  noteSeconds = 0.25,
  rate = 11025,
): Uint8Array<ArrayBuffer> {
  const n = Math.floor(seconds * rate);
  const out = new Uint8Array(44 + n * 2);
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((ch, i) => out[at + i] = ch.charCodeAt(0));
  text(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const freq = notes[Math.floor(t / noteSeconds) % notes.length];
    const local = (t % noteSeconds) / noteSeconds; // 0..1 within the note
    const envelope = Math.min(1, local * 25) * (1 - local * 0.5);
    const sample = freq ? Math.sin(2 * Math.PI * freq * t) * envelope * 0.3 : 0;
    v.setInt16(44 + i * 2, Math.round(sample * 32767), true);
  }
  return out;
}

/** Silence as an 8-bit 8 kHz WAV, so <audio> can play and end quickly. */
export function silentWav(seconds = 0.3): Uint8Array<ArrayBuffer> {
  const rate = 8000, n = Math.floor(rate * seconds);
  const out = new Uint8Array(44 + n).fill(128, 44); // 8-bit silence
  const v = new DataView(out.buffer);
  const text = (at: number, s: string) =>
    [...s].forEach((ch, i) => out[at + i] = ch.charCodeAt(0));
  text(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  text(36, "data");
  v.setUint32(40, n, true);
  return out;
}

const SCALE = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25];
const PATTERN = [0, 2, 4, 2, 1, 3, 5, 3];

/** Demo audio for the k-th competitor: a beep-beep, and a melody of its own. */
export function demoAudio(
  k: number,
  kind: "announce" | "music",
): Uint8Array<ArrayBuffer> {
  if (kind === "announce") return makeWav(1.2, [880, 0, 880], 0.3);
  const melody = PATTERN.map((p) => SCALE[(p + k) % SCALE.length]);
  return makeWav(12, melody, 0.25 + (k % 3) * 0.05);
}

// --- the fixtures --------------------------------------------------------------

/**
 * Browser tests: festival test1 > track1 (track 1) > session1 (session 1) >
 * Competition 1 (competition 10) with Competitor 1 (competitor 100); judges 2
 * and 3 score Technique (criterion 1). Announcement and song are 0.3 s of
 * silence (one file: same bytes).
 */
export async function e2eBundle(): Promise<BundleFiles> {
  const audio = new AudioSet();
  const clip = await audio.add(silentWav(0.3));
  return buildBundle({
    festival: {
      id: 1,
      name: "test1",
      rubrics: [{
        id: 1,
        name: "rubric1",
        criteria: [{ id: 1, name: "Technique", weight: 1 }],
        judges: [
          { id: 2, name: "Judge A", criteria: [1] },
          { id: 3, name: "Judge B", criteria: [1] },
        ],
      }],
      tracks: [{
        id: 1,
        name: "track1",
        location: "Main Stage",
        sessions: [{
          id: 1,
          name: "session1",
          start_time: "2026-01-01T09:00:00Z",
          order_number: 1,
          competitions: [{
            id: 10,
            name: "Competition 1",
            order_number: 1,
            rubric_id: 1,
            competitors: [{
              id: 100,
              name: "Competitor 1",
              type: "individual",
              order_number: 1,
              duration: 120,
              audio: { announce: clip, music: clip },
            }],
          }],
        }],
      }],
    },
  }, audio);
}

/**
 * The demo (see "Demo" in CLAUDE.md): one track (dj1000, sb1000), one session
 * (1000) with two competitions and five competitors, two judges (1001, 1002)
 * who each score Technique and Musicality. Every entry has generated tones.
 */
export async function demoBundle(): Promise<BundleFiles> {
  const audio = new AudioSet();
  const announce = await audio.add(demoAudio(0, "announce"));
  let k = 0;
  const entry = async (
    id: number,
    name: string,
    type: "individual" | "couple" | "team",
    order: number,
  ) => ({
    id,
    name,
    type,
    order_number: order,
    duration: 15,
    audio: { announce, music: await audio.add(demoAudio(k++, "music")) },
  });
  return buildBundle({
    festival: {
      id: 1000,
      name: "Demo Festival",
      rubrics: [{
        id: 1000,
        name: "Demo rubric",
        criteria: [
          { id: 1000, name: "Technique", weight: 1 },
          { id: 1001, name: "Musicality", weight: 1 },
        ],
        judges: [
          { id: 1001, name: "Judge Ada", criteria: [1000, 1001] },
          { id: 1002, name: "Judge Ben", criteria: [1000, 1001] },
        ],
      }],
      tracks: [{
        id: 1000,
        name: "Demo Stage",
        location: "Main Hall",
        sessions: [{
          id: 1000,
          name: "Demo Session",
          start_time: "2026-01-01T09:00:00Z",
          order_number: 1,
          competitions: [
            {
              id: 1000,
              name: "Solo Jive",
              order_number: 1,
              rubric_id: 1000,
              competitors: [
                await entry(1001, "Alex Rivera", "individual", 1),
                await entry(1002, "Sam Okafor", "individual", 2),
                await entry(1003, "Jordan Lee", "individual", 3),
              ],
            },
            {
              id: 1001,
              name: "Showcase Waltz",
              order_number: 2,
              rubric_id: 1000,
              competitors: [
                await entry(1004, "Mia & Leo", "couple", 1),
                await entry(1005, "Team Sparks", "team", 2),
              ],
            },
          ],
        }],
      }],
    },
  }, audio);
}

export const FIXTURES = { e2e: e2eBundle, demo: demoBundle };

if (import.meta.main) {
  const name = Deno.args[0] as keyof typeof FIXTURES;
  if (!(name in FIXTURES)) {
    console.error("usage: fixtures.ts e2e|demo [outDir]");
    Deno.exit(2);
  }
  const dir = Deno.args[1] ?? `fixtures/bundles/${name}`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await writeBundle(dir, await FIXTURES[name]());
  console.log(`wrote the ${name} bundle to ${dir}`);
}
