// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { postResponse } from "../../frontend-src/connect.ts";
import { escapeHtml } from "../../frontend-src/html.ts";
import { perfTag } from "../../src/contract.ts";

const body = { tag: perfTag(1, 0), payload: true } as const;

function stubFetch(responses: Array<number | Error>) {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    const r = responses[Math.min(calls++, responses.length - 1)];
    return r instanceof Error
      ? Promise.reject(r)
      : Promise.resolve(new Response(null, { status: r }));
  }) as any;
  return { calls: () => calls, restore: () => (globalThis.fetch = orig) };
}

Deno.test("escapeHtml neutralises markup and quotes", () => {
  assertEquals(
    escapeHtml(`<img src=x onerror="a('b')">&`),
    "&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;",
  );
});

Deno.test("postResponse: success is not retried", async () => {
  const f = stubFetch([200]);
  try {
    assertEquals(await postResponse(body), { ok: true, status: 200 });
    assertEquals(f.calls(), 1);
  } finally {
    f.restore();
  }
});

Deno.test("postResponse: 4xx is final (404 = too late), not retried", async () => {
  const f = stubFetch([404]);
  try {
    assertEquals(await postResponse(body), { ok: false, status: 404 });
    assertEquals(f.calls(), 1);
  } finally {
    f.restore();
  }
});

Deno.test("postResponse: retries network errors then succeeds", async () => {
  const time = new FakeTime();
  const f = stubFetch([new TypeError("net"), 503, 200]);
  try {
    const p = postResponse(body);
    await time.tickAsync(5000);
    assertEquals(await p, { ok: true, status: 200 });
    assertEquals(f.calls(), 3);
  } finally {
    f.restore();
    time.restore();
  }
});

Deno.test("postResponse: gives up after retries with status 0 on network failure", async () => {
  const time = new FakeTime();
  const f = stubFetch([new TypeError("net")]);
  try {
    const p = postResponse(body);
    await time.tickAsync(10000);
    assertEquals(await p, { ok: false, status: 0 });
    assertEquals(f.calls(), 4); // 1 try + 3 retries
  } finally {
    f.restore();
    time.restore();
  }
});
