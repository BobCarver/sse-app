import {
  AUDIO_EXTENSIONS,
  BUNDLE_VERSION,
  type BundleManifest,
  type FestivalData,
} from "./types.ts";
import { bundleDigest, referencedAudio, sha256Hex } from "./canonical.ts";

/**
 * Checks on a bundle that need no files: each returns a list of readable
 * problems (empty = valid). Both the exporter and the competition server's
 * loader run them, so a bundle is judged the same way on both sides.
 */

const SHA256 = /^[0-9a-f]{64}$/;
const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const COMPETITOR_TYPES = new Set(["individual", "couple", "team"]);

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const isId = (v: unknown): v is number => Number.isInteger(v) && Number(v) > 0;
const isText = (v: unknown): v is string => typeof v === "string";

/** data.json: shape, running order and references. */
export function validateData(raw: unknown): string[] {
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(msg);

  if (!isObject(raw) || !isObject(raw.festival)) {
    return ["data.json: expected an object with a `festival`"];
  }
  const f = raw.festival;
  if (!isId(f.id)) bad("festival: `id` must be a positive integer");
  if (!isText(f.name)) bad("festival: `name` must be text");
  if (!Array.isArray(f.rubrics)) bad("festival: `rubrics` must be a list");
  if (!Array.isArray(f.tracks)) bad("festival: `tracks` must be a list");
  if (problems.length > 0) return problems;

  // --- rubrics ---------------------------------------------------------------
  const rubricIds = new Set<number>();
  for (const [i, r] of (f.rubrics as unknown[]).entries()) {
    const where = isObject(r) && isId(r.id) ? `rubric ${r.id}` : `rubric #${i}`;
    if (!isObject(r) || !isId(r.id)) {
      bad(`${where}: \`id\` must be a positive integer`);
      continue;
    }
    if (rubricIds.has(r.id)) bad(`${where}: id is used by another rubric`);
    rubricIds.add(r.id);
    if (!isText(r.name)) bad(`${where}: \`name\` must be text`);
    if (!Array.isArray(r.criteria) || r.criteria.length === 0) {
      bad(`${where}: needs at least one criterion`);
      continue;
    }
    if (!Array.isArray(r.judges) || r.judges.length === 0) {
      // Scoring cannot close without scores, so a competition nobody can
      // score would stop at every competitor.
      bad(`${where}: needs at least one judge`);
      continue;
    }
    const criteria = new Set<number>();
    for (const c of r.criteria as unknown[]) {
      if (!isObject(c) || !isId(c.id) || !isText(c.name)) {
        bad(`${where}: every criterion needs an \`id\` and a \`name\``);
        continue;
      }
      if (criteria.has(c.id)) {
        bad(`${where}: criterion ${c.id} is listed twice`);
      }
      criteria.add(c.id);
      if (typeof c.weight !== "number" || !(c.weight > 0)) {
        bad(`${where}: criterion ${c.id} needs a positive \`weight\``);
      }
    }
    const judges = new Set<number>();
    for (const j of r.judges as unknown[]) {
      if (!isObject(j) || !isId(j.id) || !isText(j.name)) {
        bad(`${where}: every judge needs an \`id\` and a \`name\``);
        continue;
      }
      if (judges.has(j.id)) bad(`${where}: judge ${j.id} is listed twice`);
      judges.add(j.id);
      if (!Array.isArray(j.criteria) || j.criteria.length === 0) {
        bad(`${where}: judge ${j.id} scores no criteria`);
        continue;
      }
      for (const cid of j.criteria as unknown[]) {
        if (!criteria.has(cid as number)) {
          bad(
            `${where}: judge ${j.id} scores criterion ${cid}, which is not in the rubric`,
          );
        }
      }
      if (new Set(j.criteria).size !== j.criteria.length) {
        bad(`${where}: judge ${j.id} lists a criterion twice`);
      }
    }
  }

  // --- tracks > sessions > competitions > competitors ------------------------
  const ids = {
    track: new Set<number>(),
    session: new Set<number>(),
    competition: new Set<number>(),
  };
  const unique = (kind: keyof typeof ids, id: number, where: string) => {
    if (ids[kind].has(id)) bad(`${where}: id is used by another ${kind}`);
    ids[kind].add(id);
  };
  /** order_number present, an integer, and unique among its siblings. */
  const orderOf = (
    seen: Set<number>,
    item: Record<string, unknown>,
    where: string,
  ) => {
    if (!Number.isInteger(item.order_number)) {
      bad(`${where}: \`order_number\` must be an integer`);
      return;
    }
    const n = item.order_number as number;
    if (seen.has(n)) bad(`${where}: order_number ${n} is used twice`);
    seen.add(n);
  };

  for (const t of f.tracks as unknown[]) {
    if (!isObject(t) || !isId(t.id)) {
      bad("track: `id` must be a positive integer");
      continue;
    }
    const tw = `track ${t.id}`;
    unique("track", t.id, tw);
    if (!isText(t.name) || !isText(t.location)) {
      bad(`${tw}: \`name\` and \`location\` must be text`);
    }
    if (!Array.isArray(t.sessions)) {
      bad(`${tw}: \`sessions\` must be a list`);
      continue;
    }
    const sessionOrder = new Set<number>();
    for (const s of t.sessions as unknown[]) {
      if (!isObject(s) || !isId(s.id)) {
        bad(`${tw}: every session needs a positive integer \`id\``);
        continue;
      }
      const sw = `session ${s.id}`;
      unique("session", s.id, sw);
      orderOf(sessionOrder, s, `${sw} (in ${tw})`);
      if (!isText(s.name)) bad(`${sw}: \`name\` must be text`);
      if (!isText(s.start_time) || !UTC_ISO.test(s.start_time)) {
        bad(`${sw}: \`start_time\` must be a UTC ISO time (…Z)`);
      }
      if (!Array.isArray(s.competitions)) {
        bad(`${sw}: \`competitions\` must be a list`);
        continue;
      }
      const competitionOrder = new Set<number>();
      for (const c of s.competitions as unknown[]) {
        if (!isObject(c) || !isId(c.id)) {
          bad(`${sw}: every competition needs a positive integer \`id\``);
          continue;
        }
        const cw = `competition ${c.id}`;
        unique("competition", c.id, cw);
        orderOf(competitionOrder, c, `${cw} (in ${sw})`);
        if (!isText(c.name)) bad(`${cw}: \`name\` must be text`);
        if (!rubricIds.has(c.rubric_id as number)) {
          bad(
            `${cw}: rubric_id ${c.rubric_id} is not one of the festival's rubrics`,
          );
        }
        if (!Array.isArray(c.competitors)) {
          bad(`${cw}: \`competitors\` must be a list`);
          continue;
        }
        const entryOrder = new Set<number>();
        const entries = new Set<number>();
        for (const p of c.competitors as unknown[]) {
          if (!isObject(p) || !isId(p.id)) {
            bad(`${cw}: every competitor needs a positive integer \`id\``);
            continue;
          }
          const pw = `competitor ${p.id} in ${cw}`;
          if (entries.has(p.id)) bad(`${pw}: entered twice`);
          entries.add(p.id);
          orderOf(entryOrder, p, pw);
          if (!isText(p.name)) bad(`${pw}: \`name\` must be text`);
          if (!COMPETITOR_TYPES.has(p.type as string)) {
            bad(`${pw}: \`type\` must be individual, couple or team`);
          }
          if (!Number.isInteger(p.duration) || (p.duration as number) < 0) {
            bad(`${pw}: \`duration\` must be whole seconds`);
          }
          if (!isObject(p.audio)) {
            bad(`${pw}: \`audio\` must be an object`);
            continue;
          }
          for (const [kind, ref] of Object.entries(p.audio)) {
            if (kind !== "music" && kind !== "announce") {
              bad(`${pw}: unknown audio kind "${kind}"`);
              continue;
            }
            if (
              !isObject(ref) || !isText(ref.sha256) || !SHA256.test(ref.sha256)
            ) {
              bad(`${pw}: ${kind} needs a lower-case hex \`sha256\``);
              continue;
            }
            if (!(ref.content_type as string in AUDIO_EXTENSIONS)) {
              bad(
                `${pw}: ${kind} content_type must be audio/mpeg or audio/wav`,
              );
            }
            if (!isId(ref.bytes)) {
              bad(`${pw}: ${kind} \`bytes\` must be a positive integer`);
            }
          }
        }
      }
    }
  }
  return problems;
}

/**
 * manifest.json against data.json: version, festival, `data_sha256`, the audio
 * list (exactly the files data.json refers to, same sizes and types) and
 * `digest`. `data` must already have passed `validateData`.
 */
export async function validateManifest(
  raw: unknown,
  dataText: string,
  data: FestivalData,
): Promise<string[]> {
  if (!isObject(raw)) return ["manifest.json: expected an object"];
  const m = raw as unknown as BundleManifest;
  const problems: string[] = [];
  const bad = (msg: string) => problems.push(msg);

  if (m.bundle_version !== BUNDLE_VERSION) {
    return [
      `manifest: bundle_version ${m.bundle_version} is not supported (this server reads version ${BUNDLE_VERSION})`,
    ];
  }
  if (m.festival_id !== data.festival.id) {
    bad(
      `manifest: festival_id ${m.festival_id} does not match data.json (${data.festival.id})`,
    );
  }
  const dataSha = await sha256Hex(dataText);
  if (m.data_sha256 !== dataSha) {
    bad(
      "manifest: data_sha256 does not match data.json (changed or truncated)",
    );
  }
  if (!Array.isArray(m.audio)) return [...problems, "manifest: no audio list"];

  const listed = new Map<string, BundleManifest["audio"][number]>();
  for (const a of m.audio) {
    if (!isObject(a) || !isText(a.sha256) || !SHA256.test(a.sha256)) {
      bad("manifest: every audio entry needs a lower-case hex sha256");
      continue;
    }
    if (listed.has(a.sha256)) {
      bad(`manifest: audio ${a.sha256} is listed twice`);
    }
    listed.set(a.sha256, a);
  }
  const used = referencedAudio(data);
  for (const ref of used) {
    const a = listed.get(ref.sha256);
    if (!a) {
      bad(`manifest: audio ${ref.sha256} is used in data.json but not listed`);
    } else if (a.bytes !== ref.bytes || a.content_type !== ref.content_type) {
      bad(
        `manifest: audio ${ref.sha256} has a different size or type in data.json`,
      );
    }
  }
  const usedHashes = new Set(used.map((u) => u.sha256));
  for (const sha of listed.keys()) {
    if (!usedHashes.has(sha)) {
      bad(`manifest: audio ${sha} is listed but not used in data.json`);
    }
  }
  if (problems.length > 0) return problems;
  if (m.digest !== await bundleDigest(dataSha, [...listed.keys()])) {
    bad("manifest: digest does not match data_sha256 and the audio hashes");
  }
  return problems;
}
