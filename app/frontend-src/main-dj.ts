import { registerAndConnect, requireParam } from "./connect.ts";
import { DjClient } from "./dj.ts";

const client = new DjClient({
  sse: await registerAndConnect(`dj${requireParam("track")}`),
});
globalThis.addEventListener("pagehide", () => client.destroy());
