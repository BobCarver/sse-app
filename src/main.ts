import { Hono } from "https://deno.land/x/hono@v3.1.9/mod.ts";
import { streamSSE } from "https://deno.land/x/hono@v3.1.9/streaming.ts";

const app = new Hono();

app.get("/", (c) => c.text("Hello Hono"));

app.get("/events", (c) =>
  streamSSE(c, async (stream) => {
    // send a simple ping every 5s
    const iv = setInterval(() => {
      stream.writeSSE({ data: JSON.stringify({ type: "ping" }) }).catch(() => {});
    }, 5000);

    // Keep connection open until the client disconnects
    await stream.sleep(Number.MAX_SAFE_INTEGER);

    clearInterval(iv);
  })
);

export default app;

if (import.meta.main) {
  console.log("Starting server on http://localhost:3000");
  app.listen({ port: 3000 });
}
