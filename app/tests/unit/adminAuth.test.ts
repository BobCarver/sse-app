import { assertEquals, assertNotEquals } from "@std/assert";
import { AdminSessions } from "../../src/adminAuth.ts";

Deno.test("admin sessions: a created id is valid until it expires or is destroyed", () => {
  let now = 1_000;
  const s = new AdminSessions(5_000, () => now);
  const id = s.create();
  assertEquals(id.length >= 43, true); // 256 bits, base64url
  assertEquals(s.valid(id), true);
  now += 4_999;
  assertEquals(s.valid(id), true);
  now += 1;
  assertEquals(s.valid(id), false); // expired
  assertEquals(s.valid(id), false);

  const other = s.create();
  s.destroy(other);
  assertEquals(s.valid(other), false);
});

Deno.test("admin sessions: unknown, empty and missing ids are refused; ids are unique", () => {
  const s = new AdminSessions();
  assertEquals([s.valid("nope"), s.valid(""), s.valid(undefined)], [
    false,
    false,
    false,
  ]);
  assertNotEquals(s.create(), s.create());
  s.destroy(undefined); // no error
});
