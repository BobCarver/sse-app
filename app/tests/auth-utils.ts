// Auth helpers for tests that drive the real app.
import { credentials } from "../src/main.ts";

export const ADMIN_TOKEN = "test-admin-token";
Deno.env.set("ADMIN_TOKEN", ADMIN_TOKEN);

export const adminHeaders = { authorization: `Bearer ${ADMIN_TOKEN}` };

/** Issue a credential for `clientId`; returns its secret (what a link carries). */
export async function secretFor(clientId: string): Promise<string> {
  return (await credentials.issue(clientId, "test")).secret;
}

/** Cookie header value that authenticates as `clientId`. */
export async function cookieFor(clientId: string): Promise<string> {
  return `session_token=${await secretFor(clientId)}`;
}
