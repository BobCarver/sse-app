import { bootstrap } from "./connect.ts";
import { JudgeClient } from "./jd.ts";

await bootstrap("judge", (num, sse) => new JudgeClient(num, { sse }));
