// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "@std/assert";
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

const FAST = [1, 1, 1]; // real timers, tiny delays

Deno.test("postResponse: retries network errors and 5xx, then succeeds", async () => {
  const f = stubFetch([new TypeError("net"), 503, 200]);
  try {
    assertEquals(await postResponse(body, FAST), { ok: true, status: 200 });
    assertEquals(f.calls(), 3);
  } finally {
    f.restore();
  }
});

Deno.test("postResponse: gives up after the retries (status 0 on network failure)", async () => {
  const f = stubFetch([new TypeError("net")]);
  try {
    assertEquals(await postResponse(body, FAST), { ok: false, status: 0 });
    assertEquals(f.calls(), 4); // 1 try + 3 retries
  } finally {
    f.restore();
  }
});

Deno.test("postResponse: persistent 5xx is returned after the retries", async () => {
  const f = stubFetch([500]);
  try {
    assertEquals(await postResponse(body, FAST), { ok: false, status: 500 });
    assertEquals(f.calls(), 4);
  } finally {
    f.restore();
  }
});
