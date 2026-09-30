import { bootstrap } from "./connect.ts";
import { DjClient } from "./dj.ts";

await bootstrap("dj", (_num, sse) => new DjClient({ sse }));
