import type { AudioLibrary, AudioRecord } from "./audioLibrary.ts";
import {
  AUDIO_KINDS,
  type AudioManifest,
  type AudioManifestFile,
  audioUrl,
  manifestDigest,
} from "./contract.ts";
import type { Competition } from "./types.ts";

export interface ManifestSource {
  /** The competitions of all the track's sessions, in running order. */
  competitions(trackId: number): Competition[];
}

const toFile = (r: AudioRecord): AudioManifestFile => ({
  competition_id: r.competitionId,
  competitor_id: r.competitorId,
  kind: r.kind,
  url: audioUrl(r.competitionId, r.competitorId, r.kind),
  sha256: r.sha256,
  bytes: r.bytes,
});

/** Files of these competitions in performance order (announce before music). */
export async function filesFor(
  audio: AudioLibrary,
  competitions: Competition[],
): Promise<AudioManifestFile[]> {
  const records = await audio.list(competitions.map((c) => c.id));
  const byKey = new Map(
    records.map((r) => [`${r.competitionId}:${r.competitorId}:${r.kind}`, r]),
  );
  const out: AudioManifestFile[] = [];
  for (const comp of competitions) {
    for (const competitor of comp.competitors) {
      for (const kind of AUDIO_KINDS) {
        const rec = byKey.get(`${comp.id}:${competitor.id}:${kind}`);
        if (rec) out.push(toFile(rec));
      }
    }
  }
  return out;
}

/** Digest of everything a track's DJ needs ("" if it has no audio). */
export async function trackAudioDigest(
  audio: AudioLibrary,
  competitions: Competition[],
): Promise<string> {
  return manifestDigest(await filesFor(audio, competitions));
}

/**
 * What the DJ of `trackId` should download: the audio of all the track's
 * sessions, in running order. The bundle is final, so the set never changes
 * during the festival and is offered from the start.
 */
export async function buildManifest(
  audio: AudioLibrary,
  source: ManifestSource,
  trackId: number,
): Promise<AudioManifest> {
  const files = await filesFor(audio, source.competitions(trackId));
  return { track_id: trackId, digest: await manifestDigest(files), files };
}
