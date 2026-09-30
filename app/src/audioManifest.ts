import type { AudioLibrary, AudioRecord } from "./audioLibrary.ts";
import { uploadCutoff } from "./audioLibrary.ts";
import {
  AUDIO_KINDS,
  type AudioManifest,
  type AudioManifestFile,
  audioUrl,
  manifestDigest,
} from "./contract.ts";
import type { Competition } from "./types.ts";

export interface ManifestSource {
  nextSession(
    trackId: number,
  ): Promise<{ id: number; startTime: Date } | undefined>;
  competitions(sessionId: number): Promise<Competition[]>;
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

/** Digest of everything a session needs ("" if it has no audio). */
export async function sessionAudioDigest(
  audio: AudioLibrary,
  competitions: Competition[],
): Promise<string> {
  return manifestDigest(await filesFor(audio, competitions));
}

/**
 * What the DJ of `trackId` should download: the next session's audio. Until the
 * upload cut-off has passed the set can still change, so nothing is offered.
 */
export async function buildManifest(
  audio: AudioLibrary,
  source: ManifestSource,
  trackId: number,
  now = new Date(),
): Promise<AudioManifest> {
  const session = await source.nextSession(trackId);
  if (!session) {
    return {
      session_id: null,
      available: false,
      available_at: null,
      digest: "",
      files: [],
    };
  }
  const availableAt = uploadCutoff(session.startTime);
  if (now < availableAt) {
    return {
      session_id: session.id,
      available: false,
      available_at: availableAt.toISOString(),
      digest: "",
      files: [],
    };
  }
  const files = await filesFor(audio, await source.competitions(session.id));
  return {
    session_id: session.id,
    available: true,
    available_at: availableAt.toISOString(),
    digest: await manifestDigest(files),
    files,
  };
}
