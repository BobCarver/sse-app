/// <reference lib="dom" />
import type { ResponseBody } from "../src/contract.ts";

/** Get a session cookie for `sub`, then open the page's single SSE connection. */
export async function registerAndConnect(sub: string): Promise<EventSource> {
  const res = await fetch(`/register?sub=${encodeURIComponent(sub)}`);
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return new EventSource("/events");
}

export interface PostResult {
  ok: boolean;
  /** HTTP status, or 0 if the request never got a response. */
  status: number;
}

const RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * POST a contract response. Retries network errors and 5xx (the server treats
 * the first accepted response as final, so a retry after a lost reply gets 404,
 * which callers should treat as "already handled or too late").
 */
export async function postResponse(body: ResponseBody): Promise<PostResult> {
  const base = globalThis.location?.origin ?? "http://localhost";
  for (let attempt = 0;; attempt++) {
    try {
      const res = await fetch(`${base}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status < 500 || attempt >= RETRY_DELAYS_MS.length) {
        return { ok: res.ok, status: res.status };
      }
    } catch (_err) {
      if (attempt >= RETRY_DELAYS_MS.length) return { ok: false, status: 0 };
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}

/** Read a required query parameter or show an error in #status and throw. */
export function requireParam(name: string): string {
  const v = new URLSearchParams(globalThis.location?.search).get(name);
  if (!v || !/^\d+$/.test(v)) {
    const msg = `Missing or invalid ?${name}= in URL`;
    const el = document.getElementById("status");
    if (el) el.textContent = msg;
    throw new Error(msg);
  }
  return v;
}
