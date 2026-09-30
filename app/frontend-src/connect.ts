/// <reference lib="dom" />
import type { ResponseBody } from "../src/contract.ts";

/** The slice of EventSource the page classes use (also what tests inject). */
export interface SseLike {
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface ResilientOptions {
  url?: string;
  /** Refresh the session cookie (called before every reopen). */
  register: () => Promise<void>;
  /** Reopen if nothing (message or server ping) arrives for this long. */
  watchdogMs?: number;
  /** Delays between reopen attempts; the last value repeats. */
  backoffMs?: number[];
  createEventSource?: (url: string) => EventSource;
  onState?: (state: ConnectionState) => void;
}

/**
 * EventSource that survives what real networks do: half-open connections
 * (watchdog), the browser giving up after an error such as an expired token
 * (refresh + reopen with backoff), and being replaced by another tab
 * (stops for good). Listeners registered on it persist across reopens; the
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
        await this.opts.register(); // fresh cookie, in case it expired
      } catch (_err) {
        return this.reopenLater();
      }
      this.open();
    }, delay);
  }
}

// --- registration ------------------------------------------------------------

let currentSub: string | undefined;

/** (Re)issue the session cookie for this page's client id. */
export async function refreshToken(): Promise<void> {
  if (!currentSub) throw new Error("not registered");
  const res = await fetch(`/register?sub=${encodeURIComponent(currentSub)}`);
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
}

/** Get a session cookie for `sub`, then open the page's single, self-healing SSE connection. */
export async function registerAndConnect(
  sub: string,
  onState?: (state: ConnectionState) => void,
): Promise<ResilientEventSource> {
  currentSub = sub;
  await refreshToken();
  return new ResilientEventSource({ register: refreshToken, onState });
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
 * POST a contract response. Retries network errors and 5xx, and on 401 (expired
 * token) refreshes the cookie once and retries. The server treats the first
 * accepted response as final, so a retry after a lost reply gets 404, which
 * callers should treat as "already handled or too late".
 */
export async function postResponse(body: ResponseBody): Promise<PostResult> {
  const base = globalThis.location?.origin ?? "http://localhost";
  let refreshed = false;
  for (let attempt = 0;; attempt++) {
    try {
      const res = await fetch(`${base}/response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401 && !refreshed && currentSub) {
        refreshed = true;
        await refreshToken();
        attempt--; // the refresh doesn't count as a failed attempt
        continue;
      }
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
