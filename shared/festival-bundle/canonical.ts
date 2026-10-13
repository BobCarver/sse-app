import type { BundleManifest, FestivalData, ManifestAudio } from "./types.ts";
import { BUNDLE_VERSION } from "./types.ts";

/**
 * The one way a bundle file is written: keys sorted at every level, two-space
 * indentation, a final newline. Exporting the same data twice gives the same
 * bytes, so the same `data_sha256` and `digest`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((
        k,
      ) => [k, sortKeys(obj[k])]),
    );
  }
  return value;
}

const byOrder = <T extends { order_number: number }>(a: T, b: T) =>
  a.order_number - b.order_number;
const byId = <T extends { id: number }>(a: T, b: T) => a.id - b.id;

/**
 * data.json text for `data`: arrays in running order (sessions by planned start
 * then order_number, competitions and entries by order_number), rubrics,
 * criteria, judges and tracks by id, then `canonicalJson`.
 */
export function canonicalData(data: FestivalData): string {
  const f = data.festival;
  return canonicalJson({
    festival: {
      ...f,
      rubrics: f.rubrics.toSorted(byId).map((r) => ({
        ...r,
        criteria: r.criteria.toSorted(byId),
        judges: r.judges.toSorted(byId).map((j) => ({
          ...j,
          criteria: j.criteria.toSorted((a, b) => a - b),
        })),
      })),
      tracks: f.tracks.toSorted(byId).map((t) => ({
        ...t,
        sessions: t.sessions.toSorted((a, b) =>
          Date.parse(a.start_time) - Date.parse(b.start_time) ||
          byOrder(a, b)
        ).map((s) => ({
          ...s,
          competitions: s.competitions.toSorted(byOrder).map((c) => ({
            ...c,
            competitors: c.competitors.toSorted(byOrder),
          })),
        })),
      })),
    },
  });
}

/** Lower-case hex sha256 of a string (UTF-8) or bytes. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string"
    ? new TextEncoder().encode(data)
    : data;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The bundle's identity: sha256 over `data_sha256` and the sorted audio hashes,
 * one per line ("<data_sha256>\n<hash1>\n<hash2>..."; no trailing newline).
 */
export function bundleDigest(
  dataSha256: string,
  audioHashes: string[],
): Promise<string> {
  return sha256Hex([dataSha256, ...audioHashes.toSorted()].join("\n"));
}

/** Every distinct audio file data.json refers to, by hash. */
export function referencedAudio(data: FestivalData): ManifestAudio[] {
  const seen = new Map<string, ManifestAudio>();
  for (const t of data.festival.tracks) {
    for (const s of t.sessions) {
      for (const c of s.competitions) {
        for (const p of c.competitors) {
          for (const ref of [p.audio?.announce, p.audio?.music]) {
            if (ref && !seen.has(ref.sha256)) {
              seen.set(ref.sha256, {
                sha256: ref.sha256,
                bytes: ref.bytes,
                content_type: ref.content_type,
              });
            }
          }
        }
      }
    }
  }
  return [...seen.values()].toSorted((a, b) => a.sha256 < b.sha256 ? -1 : 1);
}

/**
 * manifest.json for a data.json text (what an exporter writes last). Audio
 * entries default to the files data.json refers to; pass `audio` to add
 * loudness figures.
 */
export async function makeManifest(opts: {
  dataText: string;
  generatedAt: string;
  audio?: ManifestAudio[];
  problems?: BundleManifest["problems"];
  loudnessTargetLufs?: number;
}): Promise<BundleManifest> {
  const data = JSON.parse(opts.dataText) as FestivalData;
  const audio = opts.audio ?? referencedAudio(data);
  const dataSha = await sha256Hex(opts.dataText);
  return {
    bundle_version: BUNDLE_VERSION,
    festival_id: data.festival.id,
    generated_at: opts.generatedAt,
    data_sha256: dataSha,
    digest: await bundleDigest(dataSha, audio.map((a) => a.sha256)),
    loudness_target_lufs: opts.loudnessTargetLufs,
    audio,
    problems: opts.problems ?? [],
  };
}
