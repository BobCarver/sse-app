import { registerAndConnect, requireParam } from "./connect.ts";
import { JudgeClient } from "./jd.ts";

const judgeId = requireParam("judge");
const client = new JudgeClient(Number(judgeId), {
  sse: await registerAndConnect(`judge${judgeId}`),
});
globalThis.addEventListener("pagehide", () => client.destroy());
