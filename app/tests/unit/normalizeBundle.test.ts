import { assertEquals } from "@std/assert";
import { normalizeBundle } from "../../../scripts/normalize_bundle.ts";

Deno.test("normalizeBundle: the npm cache location no longer depends on the machine", () => {
  const key = "qrcode-generator/1.4.4/qrcode.js";
  const mac =
    `// ../../../Library/Caches/deno/npm/registry.npmjs.org/${key}\nvar x = __commonJS({\n  "../../../Library/Caches/deno/npm/registry.npmjs.org/${key}"(exports) {}\n});`;
  const linux = mac.replaceAll("Library/Caches", ".cache");
  const deeper = mac.replaceAll("../../../", "../../../../../");
  assertEquals(normalizeBundle(mac), normalizeBundle(linux));
  assertEquals(normalizeBundle(mac), normalizeBundle(deeper));
  assertEquals(
    normalizeBundle(mac).includes(`"npm/registry.npmjs.org/${key}"`),
    true,
  );
});

Deno.test("normalizeBundle: ordinary relative paths and code are left alone", () => {
  const code =
    `import "../src/contract.ts"; const a = "../../x/deno.json"; // ok`;
  assertEquals(normalizeBundle(code), code);
});
