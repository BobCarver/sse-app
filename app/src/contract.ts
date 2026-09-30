/**
 * Client -> server wire contract, shared by server and browser code.
 * Keep this file free of Deno/DOM APIs so both sides can import it.
 *
 * Clients answer a server-side wait by POSTing `ResponseBody` to /response.
 * The tag identifies which wait is being resolved; `payload` is its value.
 */
import type { Scores } from "./types.ts";

// --- tag builders (the only place tag strings are constructed) -------------

/** DJ finished (true) or skipped (false) the performance at `position`. */
export const perfTag = (competitionId: number, position: number) =>
  `perf:${competitionId}:${position}` as const;

/** Judge `judgeId` scored `competitorId` in `competitionId`. */
export const scoreTag = (
  competitionId: number,
  competitorId: number,
  judgeId: number,
) => `score:${competitionId}:${competitorId}:${judgeId}` as const;

export const requiredTag = (clientId: string) =>
  `required:${clientId}` as const;

/** Which audio a competitor performs with: announcer intro or the music itself. */
export type AudioKind = "announce" | "music";
export const AUDIO_KINDS: readonly AudioKind[] = ["announce", "music"];

/** Where the DJ page fetches a performance's audio (see GET /audio/...). */
export const audioUrl = (
  competitionId: number,
  competitorId: number,
  kind: AudioKind,
) => `/audio/${competitionId}/${competitorId}/${kind}` as const;

/** One downloadable audio file in a DJ's manifest. */
export interface AudioManifestFile {
  competition_id: number;
  competitor_id: number;
  kind: AudioKind;
  /** Fetch from here (the DJ page stores it under its sha256). */
  url: string;
  sha256: string;
  bytes: number;
}

/** What a DJ should hold before a session: the frozen audio set of its next session. */
export interface AudioManifest {
  session_id: number | null;
  /** False until the upload cut-off has passed (the set may still change). */
  available: boolean;
  available_at: string | null;
  /** Identifies exactly this set of files; "" when there are none. */
  digest: string;
  files: AudioManifestFile[];
}

/**
 * Digest of a set of files, independent of order. Server and DJ page both
 * compute it, so a DJ can prove it holds exactly the files the server expects.
 */
export async function manifestDigest(
  files: Pick<
    AudioManifestFile,
    "competition_id" | "competitor_id" | "kind" | "sha256"
  >[],
): Promise<string> {
  if (files.length === 0) return "";
  const lines = files
    .map((f) => `${f.competition_id}:${f.competitor_id}:${f.kind}:${f.sha256}`)
    .sort()
    .join("\n");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(lines),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- request body ----------------------------------------------------------

export type ResponseBody =
  | { tag: ReturnType<typeof perfTag>; payload: boolean }
  | { tag: ReturnType<typeof scoreTag>; payload: Scores };

export type ParsedTag =
  | { kind: "perf"; competitionId: number; position: number }
  | {
    kind: "score";
    competitionId: number;
    competitorId: number;
    judgeId: number;
  };

const int = (s: string) => /^\d+$/.test(s) ? Number(s) : NaN;

/** Parse a client-resolvable tag; undefined if malformed or not client-resolvable. */
export function parseTag(tag: unknown): ParsedTag | undefined {
  if (typeof tag !== "string") return undefined;
  const p = tag.split(":");
  if (p[0] === "perf" && p.length === 3) {
    const [competitionId, position] = [int(p[1]), int(p[2])];
    if (!isNaN(competitionId) && !isNaN(position)) {
      return { kind: "perf", competitionId, position };
    }
  } else if (p[0] === "score" && p.length === 4) {
    const [competitionId, competitorId, judgeId] = [
      int(p[1]),
      int(p[2]),
      int(p[3]),
    ];
    if (![competitionId, competitorId, judgeId].some(isNaN)) {
      return { kind: "score", competitionId, competitorId, judgeId };
    }
  }
  return undefined;
}

/** Validate a payload against the tag kind. Returns an error string or undefined. */
export function validatePayload(
  parsed: ParsedTag,
  payload: unknown,
): string | undefined {
  if (parsed.kind === "perf") {
    return typeof payload === "boolean" ? undefined : "payload must be boolean";
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    return "payload must be a non-empty array of scores";
  }
  for (const s of payload) {
    if (
      !s || !Number.isInteger(s.criteria_id) || typeof s.score !== "number" ||
      !Number.isFinite(s.score)
    ) return "each score needs integer criteria_id and finite score";
  }
  return undefined;
}
