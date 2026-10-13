// The cloud copy over HTTP: the admin push route and the status in the overview.
import { assertEquals } from "@std/assert";
import { app, cloudCopy } from "../../src/main.ts";
import { CloudPusher } from "../../src/cloudPush.ts";
import { adminHeaders } from "../auth-utils.ts";

const post = (body: unknown, admin = true) =>
  app.request("/admin/cloud/push", {
    method: "POST",
    headers: {
      ...(admin ? adminHeaders : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

function pusher(answer: () => Response | Promise<Response>) {
  const calls: { final: boolean }[] = [];
  const p = new CloudPusher({
    url: "https://portal.test/scores",
    token: "t",
    intervalMs: 1000,
    festivalId: () => 1,
    bundleDigest: () => "d",
    snapshot: () => Promise.resolve({ scores: [], skips: [] }),
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      calls.push({ final: JSON.parse(init!.body as string).final });
      return await answer();
    }) as typeof fetch,
  });
  return { p, calls };
}

Deno.test("cloud route: needs the admin token", async () => {
  assertEquals((await post({}, false)).status, 401);
});

Deno.test("cloud route: 409 when the cloud copy is not configured; the overview says off", async () => {
  cloudCopy.pusher = undefined;
  const res = await post({ final: true });
  assertEquals(res.status, 409);
  await res.body?.cancel();
  const o =
    await (await app.request("/admin/overview", { headers: adminHeaders }))
      .json();
  assertEquals(o.cloud.enabled, false);
});

Deno.test("cloud route: pushes now; unchanged is skipped, final is always sent; the overview shows it", async () => {
  const { p, calls } = pusher(() => new Response(null, { status: 204 }));
  cloudCopy.pusher = p;
  try {
    const first = await post({});
    assertEquals(first.status, 200);
    assertEquals((await first.json()).sent, true);
    const again = await post({});
    assertEquals((await again.json()).skipped, "unchanged");
    const fin = await post({ final: true });
    assertEquals((await fin.json()).sent, true);
    assertEquals(calls.map((c) => c.final), [false, true]);

    const o =
      await (await app.request("/admin/overview", { headers: adminHeaders }))
        .json();
    assertEquals(o.cloud.enabled, true);
    assertEquals(typeof o.cloud.last_sent_at, "string");
    assertEquals(typeof o.cloud.last_final_at, "string");
    assertEquals(o.cloud.offline_since, null);
  } finally {
    cloudCopy.pusher = undefined;
  }
});

Deno.test("cloud route: 502 with the reason when the portal cannot be reached; the overview says offline", async () => {
  const { p } = pusher(() => new Response("no", { status: 503 }));
  cloudCopy.pusher = p;
  try {
    const res = await post({ final: true });
    assertEquals(res.status, 502);
    assertEquals((await res.json()).error, "receiver answered 503");
    const o =
      await (await app.request("/admin/overview", { headers: adminHeaders }))
        .json();
    assertEquals(typeof o.cloud.offline_since, "string");
    assertEquals(o.cloud.last_error, "receiver answered 503");
  } finally {
    cloudCopy.pusher = undefined;
  }
});
