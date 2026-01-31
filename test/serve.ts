// src/serve.ts
import appDef, {app} from "../app/src/main.ts";

const port = appDef.port || 3000;
console.log(`Starting server on port ${port} (via serve.ts)`);

Deno.serve({ port }, async (req: Request) => {
  return await appDef.fetch(req);
});
