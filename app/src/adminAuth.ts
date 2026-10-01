/**
 * Browser sign-in for the admin pages. The administrator enters the admin token
 * once; the server answers with a random session id in an HttpOnly cookie, so the
 * token itself never sits in a URL, a cookie or the page. Sessions live in memory
 * (a restart signs everyone out) and expire. The CLI keeps using the bearer token.
 */

export const ADMIN_COOKIE = "admin_session";
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export class AdminSessions {
  private sessions = new Map<string, number>(); // id -> expires at (ms)

  constructor(
    private ttlMs = ADMIN_SESSION_TTL_MS,
    private now: () => number = Date.now,
  ) {}

  /** A new session; the id is 256 bits of randomness. */
  create(): string {
    this.prune();
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const id = btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    this.sessions.set(id, this.now() + this.ttlMs);
    return id;
  }

  valid(id: string | undefined): boolean {
    if (!id) return false;
    const expires = this.sessions.get(id);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private prune(): void {
    const now = this.now();
    for (const [id, expires] of this.sessions) {
      if (expires <= now) this.sessions.delete(id);
    }
  }
}
