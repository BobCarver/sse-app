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

// What each connection has already been told. Keyed by the connection itself, so
// a DJ that reconnects is told again (it may have missed a change while away).
const announced = new WeakMap<SSEClient, string>();

/**
 * Tell connected DJs when their next session's audio set is final (or changed).
 * Runs periodically; cheap when nothing is new.
 */
export async function announceAudio(
  deps: AnnouncerDeps,
  now = new Date(),
): Promise<void> {
  for (const client of deps.connectedClients()) {
    const id = parseClientId(client.id);
    if (id?.kind !== "dj") continue;
    try {
      const m = await buildManifest(deps.audio, deps.source, id.num, now);
      if (!m.available || !m.digest || m.session_id === null) continue;
      if (announced.get(client) === m.digest) continue;
      announced.set(client, m.digest);
      const data = JSON.stringify({
        session_id: m.session_id,
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
