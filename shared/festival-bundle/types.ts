/**
 * The festival bundle: what the registration portal exports and the competition
 * server runs from (portal.md section 5). This folder is shared by both: keep it
 * free of anything outside the Deno standard library and web APIs.
 *
 *   manifest.json   what this bundle is and how to verify it (BundleManifest)
 *   data.json       the structure as a nested tree (FestivalData)
 *   audio/<sha256>.<ext>
 */

/** Changes only when the shape of the bundle changes. */
export const BUNDLE_VERSION = 1;

export type AudioKind = "announce" | "music";
export const AUDIO_KINDS: readonly AudioKind[] = ["announce", "music"];

export type AudioContentType = "audio/mpeg" | "audio/wav";
/** File extension of each accepted content type (`audio/<sha256>.<ext>`). */
export const AUDIO_EXTENSIONS: Record<AudioContentType, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

/** One audio file as a competitor entry refers to it. */
export interface BundleAudioRef {
  sha256: string;
  content_type: AudioContentType;
  bytes: number;
}

export type CompetitorType = "individual" | "couple" | "team";

export interface BundleCompetitor {
  id: number;
  name: string;
  type: CompetitorType;
  order_number: number;
  /** Length of the performance in SECONDS. */
  duration: number;
  audio: { music?: BundleAudioRef; announce?: BundleAudioRef };
}

export interface BundleCompetition {
  id: number;
  name: string;
  order_number: number;
  /** Names one of `festival.rubrics`. */
  rubric_id: number;
  /** In running order. */
  competitors: BundleCompetitor[];
}

export interface BundleSession {
  id: number;
  name: string;
  /** Planned start, UTC ISO string. */
  start_time: string;
  order_number: number;
  competitions: BundleCompetition[];
}

export interface BundleTrack {
  id: number;
  name: string;
  location: string;
  sessions: BundleSession[];
}

export interface BundleCriterion {
  id: number;
  name: string;
  weight: number;
}

export interface BundleJudge {
  id: number;
  name: string;
  /** Ids of the rubric's criteria this judge scores. */
  criteria: number[];
}

export interface BundleRubric {
  id: number;
  name: string;
  criteria: BundleCriterion[];
  judges: BundleJudge[];
}

export interface BundleFestival {
  id: number;
  name: string;
  /** Every rubric used by a competition, once. */
  rubrics: BundleRubric[];
  tracks: BundleTrack[];
}

/** data.json */
export interface FestivalData {
  festival: BundleFestival;
}

export interface ManifestAudio {
  sha256: string;
  bytes: number;
  content_type: AudioContentType;
  lufs?: number;
  true_peak_db?: number;
}

/** An entry whose audio could not be exported (still processing, failed). */
export interface ManifestProblem {
  competition_id: number;
  competitor_id: number;
  kind: AudioKind;
  reason: string;
}

/** manifest.json */
export interface BundleManifest {
  bundle_version: number;
  festival_id: number;
  generated_at: string;
  /** sha256 of the exact bytes of data.json. */
  data_sha256: string;
  /** The bundle's identity: see `bundleDigest`. */
  digest: string;
  loudness_target_lufs?: number;
  /** One entry per distinct audio file referenced by data.json. */
  audio: ManifestAudio[];
  problems: ManifestProblem[];
}

/** `audio/<sha256>.<ext>` without the folder. */
export function audioFileName(
  ref: { sha256: string; content_type: AudioContentType },
): string {
  return `${ref.sha256}.${AUDIO_EXTENSIONS[ref.content_type]}`;
}
