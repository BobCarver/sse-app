import type { AudioStorage } from "./audioStorage.ts";
import type { AudioKind } from "./contract.ts";

/**
 * The audio each competitor performs with. Bytes go to an AudioStorage; what
 * they are and who they belong to is kept in a metadata store (Postgres, or
 * memory when there is no database).
 */

export type AudioFormat = "mp3" | "wav";
export const CONTENT_TYPES: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

export const DEFAULT_MAX_AUDIO_BYTES = 50 * 1024 * 1024;

export interface AudioRef {
  competitionId: number;
  competitorId: number;
  kind: AudioKind;
}

export interface AudioRecord extends AudioRef {
  storageKey: string;
  contentType: string;
  bytes: number;
  sha256: string;
}

export interface AudioMetadataStore {
  /** Insert or replace; returns the record that was replaced, if any. */
  upsert(rec: AudioRecord): Promise<AudioRecord | undefined>;
  get(ref: AudioRef): Promise<AudioRecord | undefined>;
  listForCompetitions(competitionIds: number[]): Promise<AudioRecord[]>;
}

/** The real type of the data, from its first bytes (never from the file name). */
export function sniffFormat(data: Uint8Array): AudioFormat | undefined {
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...data.subarray(from, to));
  if (data.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
    return "wav";
  }
  if (data.length >= 3 && ascii(0, 3) === "ID3") return "mp3";
  // MPEG audio frame sync: 11 set bits.
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) {
    return "mp3";
  }
  return undefined;
}

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Minutes before a session's start_time after which uploads are closed. */
export function cutoffMinutes(): number {
  const n = Number(Deno.env.get("AUDIO_CUTOFF_MINUTES"));
  return Number.isFinite(n) && n >= 0 && Deno.env.get("AUDIO_CUTOFF_MINUTES")
    ? n
    : DEFAULT_CUTOFF_MINUTES;
}
export const DEFAULT_CUTOFF_MINUTES = 30;

/** When uploads close for a session starting at `startTime`. */
export function uploadCutoff(startTime: Date, minutes = cutoffMinutes()): Date {
  return new Date(startTime.getTime() - minutes * 60_000);
}

export class AudioRejectedError extends Error {
  constructor(message: string, readonly status: 400 | 413 = 400) {
    super(message);
    this.name = "AudioRejectedError";
  }
}

export class MemoryAudioMetadata implements AudioMetadataStore {
  private rows = new Map<string, AudioRecord>();
  private id = (r: AudioRef) =>
    `${r.competitionId}:${r.competitorId}:${r.kind}`;
  upsert(rec: AudioRecord) {
    const old = this.rows.get(this.id(rec));
    this.rows.set(this.id(rec), rec);
    return Promise.resolve(old);
  }
  get(ref: AudioRef) {
    return Promise.resolve(this.rows.get(this.id(ref)));
  }
  listForCompetitions(ids: number[]) {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => ids.includes(r.competitionId)),
    );
  }
}

export class AudioLibrary {
  constructor(
    private storage: AudioStorage,
    private meta: AudioMetadataStore,
    private maxBytes = DEFAULT_MAX_AUDIO_BYTES,
  ) {}

  /** Validate and store an upload. Replaces the previous file for the same slot. */
  async add(
    ref: AudioRef,
    data: Uint8Array<ArrayBuffer>,
  ): Promise<AudioRecord> {
    if (data.length === 0) throw new AudioRejectedError("empty upload");
    if (data.length > this.maxBytes) {
      throw new AudioRejectedError(
        `file too large (max ${this.maxBytes} bytes)`,
        413,
      );
    }
    const format = sniffFormat(data);
    if (!format) throw new AudioRejectedError("not an mp3 or wav file");

    const sha256 = await sha256Hex(data);
    // Content-addressed: a new upload never overwrites the file being played.
    const storageKey = `${sha256}.${format}`;
    await this.storage.put(storageKey, data);
    const old = await this.meta.upsert({
      ...ref,
      storageKey,
      contentType: CONTENT_TYPES[format],
      bytes: data.length,
      sha256,
    });
    if (old && old.storageKey !== storageKey) {
      // Another slot may share identical bytes; only remove an unused file.
      const stillUsed = (await this.meta.listForCompetitions([
        old.competitionId,
      ])).some((r) => r.storageKey === old.storageKey);
      if (!stillUsed) await this.storage.delete(old.storageKey);
    }
    return (await this.meta.get(ref))!;
  }

  /** Every file belonging to these competitions. */
  list(competitionIds: number[]): Promise<AudioRecord[]> {
    return this.meta.listForCompetitions(competitionIds);
  }

  get(ref: AudioRef): Promise<AudioRecord | undefined> {
    return this.meta.get(ref);
  }

  open(rec: AudioRecord) {
    return this.storage.open(rec.storageKey);
  }

  /** Every audio slot (announce, music) of these competitions with no file. */
  async missing(
    competitions: { id: number; competitors: { id: number }[] }[],
    kinds: readonly AudioKind[],
  ): Promise<AudioRef[]> {
    const have = new Set(
      (await this.meta.listForCompetitions(competitions.map((c) => c.id)))
        .map((r) => `${r.competitionId}:${r.competitorId}:${r.kind}`),
    );
    const out: AudioRef[] = [];
    for (const comp of competitions) {
      for (const competitor of comp.competitors) {
        for (const kind of kinds) {
          if (!have.has(`${comp.id}:${competitor.id}:${kind}`)) {
            out.push({
              competitionId: comp.id,
              competitorId: competitor.id,
              kind,
            });
          }
        }
      }
    }
    return out;
  }
}
