import { registerAndConnect, requireParam, showConnection } from "./connect.ts";
import { DjClient } from "./dj.ts";

const sse = await registerAndConnect(
  `dj${requireParam("track")}`,
  showConnection,
);
const client = new DjClient({ sse });
globalThis.addEventListener("pagehide", () => {
  client.destroy();
  sse.close();
});
