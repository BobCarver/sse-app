/**
 * `deno bundle` writes the path of Deno's npm cache into the bundle (in a
 * comment and as a module key), and that path depends on the machine:
 * `../../../Library/Caches/deno/npm/...` on macOS, `../../../.cache/deno/npm/...`
 * on Linux. Left alone, the committed bundle would differ from what CI builds.
 * Rewriting every such prefix to `npm/` makes the output the same everywhere
 * (the keys are only used inside the one file, so they stay consistent).
 */
export function normalizeBundle(text: string): string {
  return text.replace(/(?:\.\.\/)+[^"'\s]*?deno\/npm\//g, "npm/");
}
