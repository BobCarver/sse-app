import { assertEquals } from "https://deno.land/std@0.184.0/testing/asserts.ts";
import app from "../src/main.ts";

Deno.test("GET / returns Hello Hono", async () => {
  const res = await app.fetch(new Request("http://localhost/"));
  assertEquals(await res.text(), "Hello Hono");
});
