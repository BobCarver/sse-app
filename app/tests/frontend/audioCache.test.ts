import { assert, assertEquals } from "@std/assert";
import {
  AudioPrefetcher,
  type CacheLike,
} from "../../frontend-src/audioCache.ts";
import {
  type AudioManifest,
  type AudioManifestFile,
  manifestDigest,
} from "../../src/contract.ts";

async function sha(bytes: Uint8Array<ArrayBuffer>) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

class FakeCache implements CacheLike {
  store = new Map<string, Response>();
  match(k: string) {
    return Promise.resolve(this.store.get(k)?.clone());
  }
  put(k: string, r: Response) {
    this.store.set(k, r);
    return Promise.resolve();
  }
  delete(k: string) {
    return Promise.resolve(this.store.delete(k));
  }
  keys() {
    return Promise.resolve([...this.store.keys()].map((url) => ({ url })));
  }
}

const file = async (
  competitor: number,
  body: Uint8Array<ArrayBuffer>,
): Promise<AudioManifestFile> => ({
  competition_id: 10,
  competitor_id: competitor,
  kind: "music",
  url: `/audio/10/${competitor}/music`,
  sha256: await sha(body),
  bytes: body.length,
});

/** A fake server: a manifest plus the bytes behind each url. */
function server(
  manifest: () => Promise<AudioManifest>,
  bodies: Map<string, Uint8Array<ArrayBuffer>>,
) {
  const requests: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url === "/audio-manifest") {
      const m = await manifest();
      return new Response(JSON.stringify(m), {
        status: m.session_id !== null && !m.available ? 425 : 200,
      });
    }
    const body = bodies.get(url);
    return body
      ? new Response(body, { headers: { "content-type": "audio/mpeg" } })
      : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, requests };
}

const A = new Uint8Array(100).fill(1);
const B = new Uint8Array(120).fill(2);

async function manifestOf(...fs: AudioManifestFile[]): Promise<AudioManifest> {
  return {
    session_id: 1,
    available: true,
    available_at: null,
    digest: await manifestDigest(fs),
    files: fs,
  };
}

Deno.test("prefetch: downloads everything, verifies it, and reports the server's digest", async () => {
  const fa = await file(100, A), fb = await file(101, B);
  const m = await manifestOf(fa, fb);
  const { fetchFn } = server(
    () => Promise.resolve(m),
    new Map([[fa.url, A], [fb.url, B]]),
  );
  const cache = new FakeCache();
  const progress: string[] = [];
  const p = new AudioPrefetcher({
    fetch: fetchFn,
    openCache: () => Promise.resolve(cache),
    onProgress: (r, t) => progress.push(`${r}/${t}`),
    retryDelaysMs: [],
  });
  const r = await p.sync();
  assertEquals([r.complete, r.ready, r.total], [true, 2, 2]);
  assertEquals(r.digest, m.digest);
  assertEquals(progress.at(-1), "2/2");
  assertEquals(cache.store.size, 2);
});

Deno.test("prefetch: before the cut-off nothing is downloaded", async () => {
  const { fetchFn, requests } = server(
    () =>
      Promise.resolve({
        session_id: 1,
        available: false,
        available_at: "2030-01-01T00:00:00Z",
        digest: "",
        files: [],
      }),
    new Map(),
  );
  const p = new AudioPrefetcher({
    fetch: fetchFn,
    openCache: () => Promise.resolve(new FakeCache()),
    retryDelaysMs: [],
  });
  const r = await p.sync();
  assertEquals([r.available, r.complete, r.total], [false, false, 0]);
  assertEquals(requests, ["/audio-manifest"]);
});

Deno.test("prefetch: a corrupted download is refused and the set is incomplete", async () => {
  const fa = await file(100, A);
  const bad = new Uint8Array(A.length).fill(9); // right size, wrong bytes
  const { fetchFn } = server(() => manifestOf(fa), new Map([[fa.url, bad]]));
  const cache = new FakeCache();
  const p = new AudioPrefetcher({
    fetch: fetchFn,
    openCache: () => Promise.resolve(cache),
    retryDelaysMs: [],
  });
  const r = await p.sync();
  assertEquals([r.complete, r.ready, r.digest], [false, 0, ""]);
  assertEquals(cache.store.size, 0);
});

Deno.test("prefetch: a failed download is retried", async () => {
  const fa = await file(100, A);
  let attempts = 0;
  const base = server(() => manifestOf(fa), new Map([[fa.url, A]]));
  const fetchFn = ((input: string | URL | Request) => {
    if (String(input) === fa.url && ++attempts < 3) {
      return Promise.resolve(new Response("busy", { status: 503 }));
    }
    return base.fetchFn(input);
  }) as typeof fetch;
  const p = new AudioPrefetcher({
    fetch: fetchFn,
    openCache: () => Promise.resolve(new FakeCache()),
    retryDelaysMs: [0, 0, 0],
  });
  assertEquals((await p.sync()).complete, true);
  assertEquals(attempts, 3);
});

Deno.test("prefetch: a replaced song is fetched, the old copy evicted, unchanged files not re-downloaded", async () => {
  const fa = await file(100, A), fb = await file(101, B);
  let current = await manifestOf(fa, fb);
  const bodies = new Map([[fa.url, A], [fb.url, B]]);
  const { fetchFn, requests } = server(() => Promise.resolve(current), bodies);
  const cache = new FakeCache();
  const p = new AudioPrefetcher({
    fetch: fetchFn,
    openCache: () => Promise.resolve(cache),
    retryDelaysMs: [],
  });
  await p.sync();

  // Competitor 100 uploads a new version (forced after the cut-off).
  const A2 = new Uint8Array(110).fill(7);
  const fa2 = await file(100, A2);
  current = await manifestOf(fa2, fb);
  bodies.set(fa2.url, A2);
  requests.length = 0;

  const r = await p.sync();
  assertEquals(r.digest, current.digest);
  assertEquals(requests.filter((u) => u.startsWith("/audio/")), [fa2.url]);
  assertEquals(cache.store.size, 2);
  assert(
    !cache.store.has(`https://audio.cache/${fa.sha256}`),
    "old version evicted",
  );
});

Deno.test("prefetch: srcFor plays the local copy, and falls back to the network url", async () => {
  const fa = await file(100, A);
  const { fetchFn } = server(() => manifestOf(fa), new Map([[fa.url, A]]));
  const created: Blob[] = [];
  const p = new AudioPrefetcher({
    fetch: fetchFn,
    openCache: () => Promise.resolve(new FakeCache()),
    createObjectURL: (b) => (created.push(b), `blob:local/${created.length}`),
    retryDelaysMs: [],
  });
  assertEquals(await p.srcFor(fa.url), fa.url); // nothing synced yet
  await p.sync();
  assertEquals(await p.srcFor(fa.url), "blob:local/1");
  assertEquals(await p.srcFor(fa.url), "blob:local/1"); // reused
  assertEquals(await p.srcFor("/audio/10/999/music"), "/audio/10/999/music");
});

Deno.test("prefetch: overlapping syncs share one run", async () => {
  const fa = await file(100, A);
  const { fetchFn, requests } = server(
    () => manifestOf(fa),
    new Map([[fa.url, A]]),
  );
  const p = new AudioPrefetcher({
    fetch: fetchFn,
    openCache: () => Promise.resolve(new FakeCache()),
    retryDelaysMs: [],
  });
  await Promise.all([p.sync(), p.sync(), p.sync()]);
  assertEquals(requests.filter((u) => u === "/audio-manifest").length, 1);
});
