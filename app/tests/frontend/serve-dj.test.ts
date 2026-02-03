import { assertEquals } from "std/assert";
import handler from "../../src/main.ts";

Deno.test("serve: /sessions/dj.js -> built dj bundle", async () => {
  const req = new Request("http://localhost/sessions/dj.js");
  const res = await handler(req);
  if (res.status === 404) {
    throw new Error("dj.js not found. Run `deno task build` (root) or `deno run --allow-read --allow-write scripts/build_artifacts.ts` and re-run tests.");
  }
  assertEquals(res.status, 200);
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("javascript")) throw new Error(`unexpected content-type: ${ct}`);
  const body = await res.text();
  if (!body || body.length < 10) throw new Error("dj.js appears empty");
});
