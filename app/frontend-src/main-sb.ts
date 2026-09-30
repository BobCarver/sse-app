import { registerAndConnect, requireParam, showConnection } from "./connect.ts";
import { ScoreboardClient } from "./sb.ts";

const sse = await registerAndConnect(
  `sb${requireParam("track")}`,
  showConnection,
);
new ScoreboardClient({ sse });
globalThis.addEventListener("pagehide", () => sse.close());
