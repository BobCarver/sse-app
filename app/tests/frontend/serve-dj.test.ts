import { assertEquals, assertStringIncludes } from "@std/assert";
import handler from "../../src/main.ts";

const get = (path: string) => handler(new Request(`http://localhost${path}`));

for (
  const [page, bundle] of [["dj", "dj.js"], ["judge", "jd.js"], [
    "scoreboard",
    "sb.js",
  ]]
) {
  Deno.test(`serve: /${page} page references its /js bundle`, async () => {
    const res = await get(`/${page}`);
    assertEquals(res.status, 200);
    assertStringIncludes(res.headers.get("content-type") ?? "", "text/html");
    assertStringIncludes(await res.text(), `/js/${bundle}`);
  });

  Deno.test(`serve: /js/${bundle} is the built bundle`, async () => {
    const res = await get(`/js/${bundle}`);
    if (res.status === 404) {
      throw new Error(
        "bundle missing. Run `deno task build` and re-run tests.",
      );
    }
    assertEquals(res.status, 200);
    assertStringIncludes(
      res.headers.get("content-type") ?? "",
      "javascript",
    );
    const body = await res.text();
    if (body.length < 100) throw new Error(`${bundle} appears empty`);
  });
}

Deno.test("serve: unknown /js file is 404 (no path traversal)", async () => {
  assertEquals((await get("/js/sseClient.js")).status, 404);
  assertEquals((await get("/js/..%2Fsrc%2Fmain.ts")).status, 404);
});
