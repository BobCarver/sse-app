import { registerAndConnect, requireParam, showConnection } from "./connect.ts";
import { JudgeClient } from "./jd.ts";

const judgeId = requireParam("judge");
const sse = await registerAndConnect(`judge${judgeId}`, showConnection);
const client = new JudgeClient(Number(judgeId), { sse });
globalThis.addEventListener("pagehide", () => {
  client.destroy();
  sse.close();
});
