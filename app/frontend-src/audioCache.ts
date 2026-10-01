/// <reference lib="dom" />
import {
  type AudioManifest,
  type AudioManifestFile,
  manifestDigest,
} from "../src/contract.ts";
import { sha256Hex } from "../src/sha256.ts";

/** The slice of the Cache API the prefetcher uses (also what tests inject). */
export interface CacheLike {
  match(key: string): Promise<Response | undefined>;
  put(key: string, res: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  keys(): Promise<ReadonlyArray<{ url: string }>>;
}

export interface SyncResult {
  /** The session the manifest is for, or null if the DJ has none. */
  sessionId: number | null;
  /** False until the upload cut-off has passed. */
  available: boolean;
  total: number;
  ready: number;
  /** Digest of the files now held and verified (only meaningful if complete). */
  digest: string;
  complete: boolean;
}

export interface PrefetcherDeps {
  fetch?: typeof fetch;
  openCache?: () => Promise<CacheLike>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  onProgress?: (ready: number, total: number) => void;
  /** Pauses between download attempts of one file. */
  retryDelaysMs?: number[];
  /** How many files are downloaded at once. */
  concurrency?: number;
}

const CACHE_NAME = "dj-audio-v1";
// Files are stored under their hash, so a replaced song is simply a new key.
const keyFor = (sha256: string) => `https://audio.cache/${sha256}`;
/**
 * Cache Storage only exists on secure origins (https, localhost). Elsewhere (a
 * laptop opened by LAN address over http) audio is kept in memory instead: it
 * still downloads ahead and is verified, but a page reload fetches it again.
 */
export class MemoryCache implements CacheLike {
  private items = new Map<string, { buf: ArrayBuffer; type: string }>();
  match(key: string) {
    const hit = this.items.get(key);
    return Promise.resolve(
      hit &&
        new Response(hit.buf.slice(0), {
          headers: { "content-type": hit.type },
        }),
    );
  }
  async put(key: string, res: Response) {
    this.items.set(key, {
      buf: await res.arrayBuffer(),
      type: res.headers.get("content-type") ?? "audio/mpeg",
    });
  }
  delete(key: string) {
    return Promise.resolve(this.items.delete(key));
  }
  keys() {
    return Promise.resolve([...this.items.keys()].map((url) => ({ url })));
  }
}

/** Cache Storage where the browser has it, otherwise memory. */
export function openDefaultCache(
  g: { caches?: { open(name: string): Promise<unknown> } } = globalThis,
): Promise<CacheLike> {
  return g.caches
    ? g.caches.open(CACHE_NAME) as Promise<CacheLike>
    : Promise.resolve(new MemoryCache());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Downloads the DJ's audio ahead of the session and keeps it in Cache Storage.
 * Files are fetched over plain HTTP (never SSE), verified against the
 * manifest's hash and size, and played later from local memory.
 */
export class AudioPrefetcher {
  private fetchFn: typeof fetch;
  private openCache: () => Promise<CacheLike>;
  private cache?: Promise<CacheLike>;
  private urlBySha = new Map<string, string>(); // object URLs being served
  private bySlot = new Map<string, string>(); // file url -> sha256
  private running?: Promise<SyncResult>;

  constructor(private deps: PrefetcherDeps = {}) {
    this.fetchFn = deps.fetch ?? ((...a) => fetch(...a));
    this.openCache = deps.openCache ?? (() => openDefaultCache());
  }

  private getCache(): Promise<CacheLike> {
    return this.cache ??= this.openCache();
  }

  /** Bring the cache in line with the server's manifest. Overlapping calls share one run. */
  sync(): Promise<SyncResult> {
    return this.running ??= this.doSync().finally(() => {
      this.running = undefined;
    });
  }

  private async doSync(): Promise<SyncResult> {
    const res = await this.fetchFn("/audio-manifest", { cache: "no-store" });
    // 425 = cut-off not reached yet: the body still says when.
    if (!res.ok && res.status !== 425) {
      throw new Error(`manifest failed: ${res.status}`);
    }
    const manifest = await res.json() as AudioManifest;
    const base = {
      sessionId: manifest.session_id,
      available: manifest.available,
    };
    if (!manifest.available) {
      return { ...base, total: 0, ready: 0, digest: "", complete: false };
    }

    const cache = await this.getCache();
    this.bySlot.clear();
    for (const f of manifest.files) this.bySlot.set(f.url, f.sha256);

    // Drop files no longer in the set (a song that was replaced).
    const wanted = new Set(manifest.files.map((f) => keyFor(f.sha256)));
    for (const k of await cache.keys()) {
      if (!wanted.has(k.url)) await cache.delete(k.url);
    }
    for (const [sha, url] of this.urlBySha) {
      if (!wanted.has(keyFor(sha))) {
        this.deps.revokeObjectURL?.(url);
        this.urlBySha.delete(sha);
      }
    }

    const total = manifest.files.length;
    let ready = 0;
    const held: AudioManifestFile[] = [];
    const todo: AudioManifestFile[] = [];
    for (const f of manifest.files) {
      if (await cache.match(keyFor(f.sha256))) {
        ready++;
        held.push(f);
      } else todo.push(f);
    }
    this.deps.onProgress?.(ready, total);

    // In performance order, a few at a time.
    const queue = [...todo];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (await this.download(cache, f)) {
          ready++;
          held.push(f);
          this.deps.onProgress?.(ready, total);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.deps.concurrency ?? 2, queue.length) },
        worker,
      ),
    );

    const complete = ready === total;
    return {
      ...base,
      total,
      ready,
      // The digest of what is held: equals the server's only if nothing is missing.
      digest: complete ? await manifestDigest(held) : "",
      complete,
    };
  }

  /** Fetch one file in full, verify it and store it. False if it could not be had. */
  private async download(
    cache: CacheLike,
    f: AudioManifestFile,
  ): Promise<boolean> {
    const delays = this.deps.retryDelaysMs ?? [500, 2000, 5000];
    for (let attempt = 0;; attempt++) {
      try {
        const res = await this.fetchFn(f.url, {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== f.bytes) throw new Error("size mismatch");
        if (await sha256Hex(buf) !== f.sha256) throw new Error("hash mismatch");
        await cache.put(
          keyFor(f.sha256),
          new Response(buf, {
            headers: {
              "content-type": res.headers.get("content-type") ?? "audio/mpeg",
            },
          }),
        );
        return true;
      } catch (err) {
        console.warn(`audio download failed (${f.url}):`, err);
        if (attempt >= delays.length) return false;
        await sleep(delays[attempt]);
      }
    }
  }

  /**
   * Where to play `url` from: the verified local copy if there is one, else
   * the network URL (which the server still serves).
   */
  async srcFor(url: string): Promise<string> {
    const sha = this.bySlot.get(url);
    if (!sha || !this.deps.createObjectURL) return url;
    const existing = this.urlBySha.get(sha);
    if (existing) return existing;
    try {
      const hit = await (await this.getCache()).match(keyFor(sha));
      if (!hit) return url;
      const objectUrl = this.deps.createObjectURL(await hit.blob());
      this.urlBySha.set(sha, objectUrl);
      return objectUrl;
    } catch {
      return url;
    }
  }
}
