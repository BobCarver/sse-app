import type { AudioStorage } from "./audioStorage.ts";
import type { AudioKind } from "./contract.ts";

/**
 * The audio each competitor performs with. The files come with the festival
 * bundle (AUDIO_DIR, content-addressed `<sha256>.<ext>`); what they are and
 * whose they are is read from the bundle's data (see festival.ts). Read-only:
 * the bundle is final, so there are no uploads on the competition server.
 */

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
  get(ref: AudioRef): Promise<AudioRecord | undefined>;
  listForCompetitions(competitionIds: number[]): Promise<AudioRecord[]>;
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

/** Records held in memory (unit tests). */
export class MemoryAudioMetadata implements AudioMetadataStore {
  private rows = new Map<string, AudioRecord>();
  private id = (r: AudioRef) =>
    `${r.competitionId}:${r.competitorId}:${r.kind}`;
  set(rec: AudioRecord): void {
    this.rows.set(this.id(rec), rec);
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
  ) {}

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
