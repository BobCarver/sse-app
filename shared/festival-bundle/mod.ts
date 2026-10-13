/**
 * The festival bundle format, shared by the registration portal (which exports
 * bundles) and the competition server (which loads them). See portal.md
 * section 5. Standard library and web APIs only.
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
