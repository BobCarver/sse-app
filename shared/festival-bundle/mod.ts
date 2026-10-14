/**
 * The contract between the registration portal and the competition server,
 * shared by both so neither can drift:
 * - the festival bundle (portal -> venue): the portal exports it, the server
 *   loads it. See portal.md section 5.
 * - the score push (venue -> portal): the server sends it, the portal receives
 *   it. See portal.md section 9.
 * Standard library and web APIs only.
 */
export * from "./types.ts";
export {
  bundleDigest,
  canonicalData,
  canonicalJson,
  makeManifest,
  referencedAudio,
  sha256Hex,
} from "./canonical.ts";
export { validateData, validateManifest } from "./validate.ts";
export {
  byOrder,
  type ResolvedCompetition,
  resolveSession,
  sessionsInOrder,
} from "./resolve.ts";
export {
  checkScoresAgainstBundle,
  isValidScore,
  type ScorePush,
  type ScoreRow,
  type ScoreSnapshot,
  SKIP_ACTORS,
  SKIP_STAGES,
  type SkipActor,
  type SkipRow,
  type SkipStage,
  snapshotDigest,
  sortSnapshot,
  validateScorePush,
} from "./score-push.ts";
