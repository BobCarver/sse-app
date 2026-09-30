/// <reference lib="dom" />
import type { ResponseBody } from "../src/contract.ts";

/** The slice of EventSource the page classes use (also what tests inject). */
export interface SseLike {
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}

export type ConnectionState =
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "unauthorized";

/** The server says this device has no valid credential (never issued, or revoked). */
export class AuthError extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export interface ResilientOptions {
  url?: string;
  /**
   * Called before every reopen. Should resolve if the session is still valid,
   * throw AuthError if the credential is gone (stops for good), or throw
   * anything else if the server is merely unreachable (retried with backoff).
   */
  ensureSession: () => Promise<void>;
  /** Reopen if nothing (message or server ping) arrives for this long. */
  watchdogMs?: number;
  /** Delays between reopen attempts; the last value repeats. */
  backoffMs?: number[];
  createEventSource?: (url: string) => EventSource;
  onState?: (state: ConnectionState) => void;
}

/**
 * EventSource that survives what real networks do: half-open connections
 * (watchdog), the browser giving up after an error (session check + reopen
 * with backoff), a revoked credential (stops for good), and being replaced by
 * another tab (stops for good). Listeners registered on it persist across reopens; the
 * server replays current state on each connect, so handlers only need to be
 * idempotent.
 */
export class ResilientEventSource implements SseLike {
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  private es: EventSource | null = null;
  private attached = new Set<string>();
  private watchdog?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private attempts = 0;
  private stopped = false;
  private readonly opts: Required<Omit<ResilientOptions, "onState">> & {
    onState?: (state: ConnectionState) => void;
  };

  constructor(opts: ResilientOptions) {
    this.opts = {
      url: "/events",
      watchdogMs: 45_000,
      backoffMs: [1000, 2000, 5000, 10_000],
      createEventSource: (url) => new EventSource(url),
      ...opts,
    };
    this.open();
  }

  addEventListener(type: string, listener: (e: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    if (this.es) this.attach(this.es, type);
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    this.es?.close();
    this.es = null;
    this.opts.onState?.("closed");
  }

  private open(): void {
    if (this.stopped) return;
    const es = this.opts.createEventSource(this.opts.url);
    this.es = es;
    this.attached.clear();
    this.opts.onState?.(this.attempts === 0 ? "connecting" : "reconnecting");

    es.addEventListener("open", () => {
      this.attempts = 0;
      this.opts.onState?.("open");
      this.arm();
    });
    es.addEventListener("error", () => {
      if (this.stopped || this.es !== es) return;
      this.opts.onState?.("reconnecting");
      // CLOSED: the browser gave up (e.g. 401 after token expiry). While
      // CONNECTING it retries itself; the watchdog covers the stuck case.
      if (es.readyState === 2) this.reopenLater();
    });
    for (
      const type of new Set(["ping", "superseded", ...this.listeners.keys()])
    ) {
      this.attach(es, type);
    }
    this.arm();
  }

  private attach(es: EventSource, type: string): void {
    if (this.attached.has(type)) return;
    this.attached.add(type);
    es.addEventListener(type, (e) => {
      if (this.es !== es) return;
      this.arm();
      if (type === "superseded") this.close();
      for (const l of this.listeners.get(type) ?? []) l(e as MessageEvent);
    });
  }

  private arm(): void {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      // Silence: assume the connection is dead even if the browser disagrees.
      this.opts.onState?.("reconnecting");
      this.reopenLater();
    }, this.opts.watchdogMs);
  }

  private reopenLater(): void {
    if (this.stopped) return;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    this.es?.close();
    this.es = null;
    const { backoffMs } = this.opts;
    const delay = backoffMs[Math.min(this.attempts++, backoffMs.length - 1)];
    this.retry = setTimeout(async () => {
      try {
        await this.opts.ensureSession();
      } catch (err) {
        if (err instanceof AuthError) {
          // Revoked: retrying can never succeed. Stop and say so.
          this.stopped = true;
          this.opts.onState?.("unauthorized");
          return;
        }
        return this.reopenLater();
      }
      this.open();
    }, delay);
  }
}

// --- identity ----------------------------------------------------------------

/** Ask the server who this device is (from its credential cookie). */
export async function whoami(): Promise<string> {
  const res = await fetch("/session", { cache: "no-store" });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`session check failed: ${res.status}`);
  return (await res.json()).client_id as string;
}

export type ClientKind = "dj" | "judge" | "sb";

/**
 * Identify this device, check it is the right kind for the page, and open the
 * page's single, self-healing SSE connection. `num` is the track id (dj, sb)
 * or judge id.
 */
export async function connect(
  kind: ClientKind,
  onState?: (state: ConnectionState) => void,
): Promise<{ clientId: string; num: number; sse: ResilientEventSource }> {
  const clientId = await whoami();
  const m = /^(dj|judge|sb)(\d+)$/.exec(clientId);
  if (!m || m[1] !== kind) {
    throw new Error(`This link is for "${clientId}", not a ${kind} page`);
  }
  const sse = new ResilientEventSource({
    ensureSession: async () => {
      await whoami();
    },
    onState,
  });
  return { clientId, num: Number(m[2]), sse };
}

/** Page entry point: connect, build the page's client, clean up on leave. */
export async function bootstrap(
  kind: ClientKind,
  build: (
    num: number,
    sse: ResilientEventSource,
  ) => { destroy?: () => void } | void,
): Promise<void> {
  try {
    const { num, sse } = await connect(kind, showConnection);
    const client = build(num, sse);
    globalThis.addEventListener("pagehide", () => {
      client?.destroy?.();
      sse.close();
    });
  } catch (err) {
    const message = err instanceof AuthError
      ? "This page needs a valid link. Ask an administrator for a new one."
      : (err as Error).message;
    const el = document.getElementById("status") ??
      document.getElementById("connection");
    if (el) el.textContent = message;
    console.error(err);
  }
}

/** Show connection state in #connection (empty when healthy). */
export function showConnection(state: ConnectionState): void {
  const el = document.getElementById("connection");
  if (!el) return;
  el.textContent = {
    connecting: "Connecting...",
    open: "",
    reconnecting: "Connection lost - reconnecting...",
    closed: "Disconnected",
    unauthorized: "Access revoked - ask an administrator for a new link",
  }[state];
}

// --- responses ---------------------------------------------------------------

export interface PostResult {
  ok: boolean;
  /** HTTP status, or 0 if the request never got a response. */
  status: number;
}

const RETRY_DELAYS_MS = [500, 1000, 2000];

/**
 * POST a contract response. Retries network errors and 5xx. Status 401 means
 * the credential was revoked; 403 that this device may not answer. The server
 * treats the first accepted response as final, so a retry after a lost reply
 * gets 404, which callers should treat as "already handled or too late".
 */
export async function postResponse(
  body: ResponseBody,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
): Promise<PostResult> {
  const base = globalThis.location?.origin ?? "http://localhost";
  for (let attempt = 0;; attempt++) {
    try {
      const res = await fetch(`${base}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status < 500 || attempt >= retryDelaysMs.length) {
        return { ok: res.ok, status: res.status };
      }
    } catch (_err) {
      if (attempt >= retryDelaysMs.length) return { ok: false, status: 0 };
    }
    await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
  }
}
