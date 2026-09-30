import { bootstrap } from "./connect.ts";
import { DjClient } from "./dj.ts";
import { AudioPrefetcher } from "./audioCache.ts";

await bootstrap("dj", (_num, sse) => {
  const prefetcher = new AudioPrefetcher({
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  });
  const client = new DjClient({ sse, prefetcher });
  void client.syncAudio(); // the page may load after the cut-off
  return client;
});
