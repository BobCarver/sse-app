// The cloud copy: snapshot push with a digest skip, retry with backoff and a
// forced final push. The network is an injected fetch.
import { assert, assertEquals } from "@std/assert";
import {
  cloudConfig,
  type CloudPayload,
  CloudPusher,
  type CloudSnapshot,
  shouldPushAfter,
} from "../../src/cloudPush.ts";

const snap = (
  ...scores: [number, number, number, number, number][]
): CloudSnapshot => ({
  scores: scores.map(([a, b, c, d, e]) => ({
    competition_id: a,
    competitor_id: b,
    judge_id: c,
    criteria_id: d,
    score: e,
  })),
  skips: [],
});

function setup(over: { fail?: () => boolean; intervalMs?: number } = {}) {
  const sent: { payload: CloudPayload; headers: Headers }[] = [];
  let current = snap([10, 100, 2, 1, 7.5]);
  let t = Date.parse("2030-01-01T12:00:00Z");
  const fetchFn = ((_url: string | URL | Request, init?: RequestInit) => {
    if (over.fail?.()) return Promise.reject(new TypeError("network down"));
    sent.push({
      payload: JSON.parse(init!.body as string),
      headers: new Headers(init!.headers),
    });
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;
  const pusher = new CloudPusher({
    url: "https://portal.test/scores",
    token: "secret-token",
    intervalMs: over.intervalMs ?? 1000,
    festivalId: () => 1,
    bundleDigest: () => "b".repeat(64),
    snapshot: () => Promise.resolve(current),
    fetch: fetchFn,
    now: () => new Date(t),
  });
  return {
    pusher,
    sent,
    set: (s: CloudSnapshot) => (current = s),
    tick: (ms: number) => (t += ms),
  };
}

Deno.test("cloud: the first push sends the scores with the token, festival and bundle digest", async () => {
  const { pusher, sent } = setup();
  const r = await pusher.push();
  assert(r.sent);
  assertEquals(sent.length, 1);
  assertEquals(sent[0].headers.get("authorization"), "Bearer secret-token");
  const p = sent[0].payload;
  assertEquals([p.festival_id, p.bundle_digest, p.final], [
    1,
    "b".repeat(64),
    false,
  ]);
  assertEquals(p.scores.length, 1);
  assertEquals(p.digest, (r as { digest: string }).digest);
  assertEquals(pusher.status().last_sent_at, "2030-01-01T12:00:00.000Z");
});

Deno.test("cloud: an unchanged snapshot is not sent again; a changed one is", async () => {
  const { pusher, sent, set } = setup();
  await pusher.push();
  assertEquals(await pusher.push(), { sent: false, skipped: "unchanged" });
  assertEquals(sent.length, 1);
  set(snap([10, 100, 2, 1, 8]));
  assert((await pusher.push()).sent);
  assertEquals(sent.length, 2);
});

Deno.test("cloud: row order does not change the digest", async () => {
  const { pusher, sent, set } = setup();
  set(snap([10, 100, 2, 1, 7], [10, 100, 3, 1, 8]));
  await pusher.push();
  set(snap([10, 100, 3, 1, 8], [10, 100, 2, 1, 7]));
  assertEquals((await pusher.push()).sent, false);
  assertEquals(sent[0].payload.scores.map((s) => s.judge_id), [2, 3]);
});

Deno.test("cloud: a final push is always sent and says so", async () => {
  const { pusher, sent } = setup();
  await pusher.push();
  const r = await pusher.push({ final: true });
  assert(r.sent);
  assertEquals(sent.length, 2);
  assertEquals(sent[1].payload.final, true);
  assert(pusher.status().last_final_at);
});

Deno.test("cloud: a failed push is a result, not an exception; it is offline until one arrives", async () => {
  let down = true;
  const { pusher, sent, tick } = setup({ fail: () => down });
  const r = await pusher.push();
  assertEquals(r, { sent: false, error: "network down" });
  tick(5000);
  await pusher.push();
  const st = pusher.status();
  assertEquals(st.offline_since, "2030-01-01T12:00:00.000Z"); // since the first failure
  assertEquals(st.last_error, "network down");
  assertEquals(st.last_sent_at, null);

  down = false;
  assert((await pusher.push()).sent); // the unsent snapshot is not "unchanged"
  assertEquals(sent.length, 1);
  const ok = pusher.status();
  assertEquals([ok.offline_since, ok.last_error], [null, null]);
});

Deno.test("cloud: a non-2xx answer counts as a failure", async () => {
  const pusher = new CloudPusher({
    url: "https://portal.test/scores",
    token: "t",
    intervalMs: 1000,
    festivalId: () => 1,
    bundleDigest: () => "d",
    snapshot: () => Promise.resolve(snap()),
    fetch: (() =>
      Promise.resolve(new Response("no", { status: 409 }))) as typeof fetch,
  });
  assertEquals(await pusher.push(), {
    sent: false,
    error: "receiver answered 409",
  });
});

Deno.test("cloud: a failing snapshot read does not throw either", async () => {
  const pusher = new CloudPusher({
    url: "https://portal.test/scores",
    token: "t",
    intervalMs: 1000,
    festivalId: () => 1,
    bundleDigest: () => "d",
    snapshot: () => Promise.reject(new Error("db down")),
    fetch: fetch,
  });
  assertEquals(await pusher.push(), { sent: false, error: "db down" });
});

Deno.test("cloud: retries back off while failing and return to the interval after a success", async () => {
  let down = true;
  const { pusher } = setup({ fail: () => down });
  assertEquals(pusher.nextDelayMs(), 1000);
  await pusher.push();
  assertEquals(pusher.nextDelayMs(), 2000);
  await pusher.push();
  assertEquals(pusher.nextDelayMs(), 4000);
  for (let i = 0; i < 20; i++) await pusher.push();
  assertEquals(pusher.nextDelayMs(), 300_000); // capped
  down = false;
  await pusher.push();
  assertEquals(pusher.nextDelayMs(), 1000);
});

Deno.test("cloud: the loop pushes on a timer, only what changed, until stopped", async () => {
  const { pusher, sent, set } = setup({ intervalMs: 20 });
  pusher.start(5);
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(sent.length, 1); // several ticks, one changed snapshot
  set(snap([10, 100, 2, 1, 9]));
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(sent.length, 2);
  pusher.stop();
  set(snap([10, 100, 2, 1, 6]));
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(sent.length, 2);
});

Deno.test("cloud: config - off without a URL, https required (localhost excepted), token required", () => {
  const cfg = (env: Record<string, string>) => cloudConfig((k) => env[k]);
  assertEquals(cfg({}), undefined);
  assertEquals(cfg({ CLOUD_URL: "nonsense", CLOUD_TOKEN: "t" }), {
    error: "CLOUD_URL is not a valid URL",
  });
  assertEquals(cfg({ CLOUD_URL: "http://portal.test/x", CLOUD_TOKEN: "t" }), {
    error: "CLOUD_URL must be https (http only for localhost)",
  });
  assertEquals(cfg({ CLOUD_URL: "https://portal.test/x" }), {
    error: "CLOUD_TOKEN is not set",
  });
  assertEquals(
    cfg({ CLOUD_URL: "http://localhost:9/x", CLOUD_TOKEN: "t" }),
    { url: "http://localhost:9/x", token: "t", intervalMs: 300_000 },
  );
  assertEquals(
    cfg({
      CLOUD_URL: "https://portal.test/x",
      CLOUD_TOKEN: "t",
      CLOUD_PUSH_INTERVAL_S: "30",
    }),
    { url: "https://portal.test/x", token: "t", intervalMs: 30_000 },
  );
});

Deno.test("cloud: a push waits for the one under way and then reads a fresh snapshot", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const bodies: CloudPayload[] = [];
  let current = snap([10, 100, 2, 1, 7]);
  let reads = 0;
  const pusher = new CloudPusher({
    url: "https://portal.test/scores",
    token: "t",
    intervalMs: 1000,
    festivalId: () => 1,
    bundleDigest: () => "d",
    snapshot: () => {
      reads++;
      return Promise.resolve(current);
    },
    fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      await gate; // the first push is slow
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  const first = pusher.push();
  await new Promise((r) => setTimeout(r, 10));
  current = snap([10, 100, 2, 1, 7], [10, 100, 3, 1, 8]); // a score lands meanwhile
  const second = pusher.push();
  release();
  await Promise.all([first, second]);
  assertEquals(reads, 2);
  assertEquals(bodies.map((b) => b.scores.length), [1, 2]);
});

Deno.test("cloud: scores are pushed when a competition or the session ends, not after every competitor", () => {
  const e = (x: unknown) => x as Parameters<typeof shouldPushAfter>[0];
  const next = (competitionId: number) => ({ competitionId, competitorId: 1 });
  // Within a competition: no.
  assertEquals(
    shouldPushAfter(
      e({
        kind: "competitor_finalized",
        competitionId: 10,
        competitorId: 100,
        next: next(10),
      }),
    ),
    false,
  );
  // The last competitor of a competition (the cursor moves to the next one, or nowhere): yes.
  assertEquals(
    shouldPushAfter(
      e({
        kind: "competitor_finalized",
        competitionId: 10,
        competitorId: 101,
        next: next(20),
      }),
    ),
    true,
  );
  assertEquals(
    shouldPushAfter(
      e({
        kind: "competitor_finalized",
        competitionId: 20,
        competitorId: 5,
        next: null,
      }),
    ),
    true,
  );
  // A skip that ends the competition counts; one inside it does not.
  assertEquals(
    shouldPushAfter(
      e({
        kind: "competitor_skipped",
        competitionId: 10,
        competitorId: 101,
        next: null,
      }),
    ),
    true,
  );
  assertEquals(
    shouldPushAfter(
      e({
        kind: "competitor_skipped",
        competitionId: 10,
        competitorId: 100,
        next: next(10),
      }),
    ),
    false,
  );
  // Session over: completed or cancelled, not a shutdown or an error.
  assertEquals(
    shouldPushAfter(e({ kind: "session_ended", reason: "completed" })),
    true,
  );
  assertEquals(
    shouldPushAfter(e({ kind: "session_ended", reason: "cancelled" })),
    true,
  );
  assertEquals(
    shouldPushAfter(
      e({ kind: "session_ended", reason: "aborted", untouched: false }),
    ),
    false,
  );
  // Everything else: no.
  for (
    const kind of [
      "competitor_started",
      "competitor_performed",
      "score_missing",
      "held",
      "competition_started",
      "session_started",
    ]
  ) {
    assertEquals(
      shouldPushAfter(e({ kind, competitionId: 10, competitorId: 100 })),
      false,
      kind,
    );
  }
});
