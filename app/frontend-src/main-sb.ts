import { bootstrap } from "./connect.ts";
import { ScoreboardClient } from "./sb.ts";

await bootstrap("sb", (_num, sse) => {
  new ScoreboardClient({ sse });
});
