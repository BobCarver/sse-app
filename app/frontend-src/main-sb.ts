import { registerAndConnect, requireParam } from "./connect.ts";
import { ScoreboardClient } from "./sb.ts";

new ScoreboardClient({
  sse: await registerAndConnect(`sb${requireParam("track")}`),
});
