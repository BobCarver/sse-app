import {
  audioFileName,
  type BundleManifest,
  type FestivalData,
  sha256Hex,
  validateData,
  validateManifest,
} from "../../shared/festival-bundle/mod.ts";

/**
 * Load the festival bundle (BUNDLE_DIR: manifest.json + data.json; audio files
 * in AUDIO_DIR as <sha256>.<ext>) and verify all of it before anything runs:
 * the data's shape and running order, the manifest against the data, and every
 * audio file's size and sha256. Any problem refuses the whole bundle.
 */

export class BundleError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `the festival bundle was refused:\n  - ${problems.join("\n  - ")}`,
    );
    this.name = "BundleError";
  }
}

export interface LoadedBundle {
  manifest: BundleManifest;
  /** data.json exactly as read (stored in the database for backups). */
  dataText: string;
  data: FestivalData;
}

async function readText(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new BundleError([`${path} not found`]);
    }
    throw err;
  }
}

function parse(text: string, name: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BundleError([`${name} is not valid JSON: ${String(err)}`]);
  }
}

/** Files read and hashed at once at boot (a bundle has hundreds). */
const AUDIO_CHECKS_AT_ONCE = 8;

/** `fn` over `items`, `limit` at a time; results in the order of `items`. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/** What is wrong with one audio file of the manifest, if anything. */
async function audioProblem(
  audioDir: string,
  a: BundleManifest["audio"][number],
): Promise<string | undefined> {
  const path = `${audioDir}/${audioFileName(a)}`;
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return `${path} is missing`;
    throw err;
  }
  if (bytes.length !== a.bytes) {
    return `${path} is ${bytes.length} bytes, the manifest says ${a.bytes} (incomplete copy?)`;
  }
  if (await sha256Hex(bytes) !== a.sha256) {
    return `${path} does not match its sha256 (damaged copy?)`;
  }
}

export async function loadBundle(
  bundleDir: string,
  audioDir: string,
): Promise<LoadedBundle> {
  const manifestRaw = parse(
    await readText(`${bundleDir}/manifest.json`),
    "manifest.json",
  );
  const dataText = await readText(`${bundleDir}/data.json`);
  const dataRaw = parse(dataText, "data.json");

  const dataProblems = validateData(dataRaw);
  if (dataProblems.length > 0) throw new BundleError(dataProblems);
  const data = dataRaw as FestivalData;

  const manifestProblems = await validateManifest(manifestRaw, dataText, data);
  if (manifestProblems.length > 0) throw new BundleError(manifestProblems);
  const manifest = manifestRaw as BundleManifest;

  const audioProblems = (await mapLimit(
    manifest.audio,
    AUDIO_CHECKS_AT_ONCE,
    (a) => audioProblem(audioDir, a),
  )).filter((p) => p !== undefined);
  if (audioProblems.length > 0) throw new BundleError(audioProblems);

  for (const p of manifest.problems ?? []) {
    console.warn(
      `BUNDLE PROBLEM: competition ${p.competition_id}, competitor ${p.competitor_id}: ${p.kind} ${p.reason}`,
    );
  }
  return { manifest, dataText, data };
}
