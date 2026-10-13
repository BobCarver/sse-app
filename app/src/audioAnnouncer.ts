import { buildManifest, type ManifestSource } from "./audioManifest.ts";
import type { AudioLibrary } from "./audioLibrary.ts";
import { parseClientId } from "./credentials.ts";
import type { SSEClient } from "./types.ts";

export interface AnnouncerDeps {
  audio: AudioLibrary;
  source: ManifestSource;
  /** Every connected client (waiting in the pool or inside a session). */
  connectedClients(): SSEClient[];
}

// Connections already told. Keyed by the connection itself, so a DJ that
// reconnects (e.g. after a server restart, which forgets its audio report) is
// told again and re-reports. The set never changes while the server runs: the
// bundle is final.
const announced = new WeakSet<SSEClient>();

/**
 * Tell connected DJs that their track's audio set is there to download. Runs
 * periodically; cheap when nothing is new (it only looks at new connections).
 */
export async function announceAudio(deps: AnnouncerDeps): Promise<void> {
  for (const client of deps.connectedClients()) {
    const id = parseClientId(client.id);
    if (id?.kind !== "dj" || announced.has(client)) continue;
    try {
      const m = await buildManifest(deps.audio, deps.source, id.num);
      announced.add(client);
      if (!m.digest) continue;
      const data = JSON.stringify({
        track_id: m.track_id,
        digest: m.digest,
        count: m.files.length,
      });
      client.controller.enqueue(`event: audio_available\ndata: ${data}\n\n`);
    } catch (err) {
      console.error(`audio announce failed for ${client.id}:`, err);
    }
  }
}

export function startAudioAnnouncer(
  deps: AnnouncerDeps,
  everyMs = 15_000,
): () => void {
  const timer = setInterval(() => {
    announceAudio(deps).catch((err) => console.error("announcer:", err));
  }, everyMs);
  return () => clearInterval(timer);
}
