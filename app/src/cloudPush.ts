// Cloud copy (redesign Phase 5): a background snapshot push of the festival's
// scores to the portal, over HTTPS, outbound only. Best effort: a failed or
// missing push is retried later and never blocks scoring, the cursor or the DJ.
// The portal replaces the festival's scores with each snapshot (portal.md
// section 9), so a missed push or a correction needs no special handling.
//
// Pushes happen when a competition or a session ends (shouldPushAfter), plus a
// slow timer that retries a failed push and catches anything else.
import type { CloudStatus } from "./adminTypes.ts";
import { sha256Hex } from "./sha256.ts";
import type { ProgressEvent } from "./types.ts";

export interface ScoreRow {
  competition_id: number;
  competitor_id: number;
  judge_id: number;
  criteria_id: number;
  score: number;
}

/** A competitor skipped by an explicit action (the `skips` table). */
export interface SkipRow {
  session_id: number;
  competition_id: number;
  competitor_id: number;
  stage: string;
  actor: string;
  reason: string;
}

export interface CloudSnapshot {
  scores: ScoreRow[];
  skips: SkipRow[];
}

/** What the receiver gets: POST, JSON, `Authorization: Bearer <token>`. */
export interface CloudPayload extends CloudSnapshot {
  festival_id: number;
  /** The bundle the scores belong to: the receiver rejects a different one. */
  bundle_digest: string;
  /** Digest of the festival id, bundle digest, scores and skips (not of the rest). */
  digest: string;
  /** The authoritative upload after the event. */
  final: boolean;
  sent_at: string;
}

export interface CloudConfig {
  url: string;
  token: string;
  intervalMs: number;
}

/**
 * Does this progress event end a competition or a session? That is when the
 * scores are worth sending: a competition's results are complete. `event` is
 * the one just written; `next` is where the cursor moved.
 */
export function shouldPushAfter(event: ProgressEvent): boolean {
  switch (event.kind) {
    case "competitor_finalized":
    case "competitor_skipped":
      return event.next === null ||
        event.next.competitionId !== event.competitionId;
    case "session_ended":
      return event.reason === "completed" || event.reason === "cancelled";
    default:
      return false;
  }
}

/**
 * CLOUD_URL (the receiver), CLOUD_TOKEN, CLOUD_PUSH_INTERVAL_S (300). Off when
 * CLOUD_URL is not set. The token travels in a header, so plain http is refused
 * except for a receiver on this machine.
 */
export function cloudConfig(
  get: (name: string) => string | undefined,
): CloudConfig | undefined | { error: string } {
  const raw = get("CLOUD_URL");
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { error: "CLOUD_URL is not a valid URL" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return { error: "CLOUD_URL must be https (http only for localhost)" };
  }
  const token = get("CLOUD_TOKEN");
  if (!token) return { error: "CLOUD_TOKEN is not set" };
  const every = get("CLOUD_PUSH_INTERVAL_S");
  const seconds = every && Number(every) >= 1 ? Number(every) : 300;
  return { url: url.toString(), token, intervalMs: seconds * 1000 };
}

export type PushResult =
  | { sent: true; digest: string }
  | { sent: false; skipped: "unchanged" }
  | { sent: false; error: string };

export interface CloudDeps extends CloudConfig {
  festivalId(): number;
  bundleDigest(): string;
  snapshot(): Promise<CloudSnapshot>;
  fetch?: typeof fetch;
  now?: () => Date;
  /** A push that takes longer is given up (and retried later). */
  timeoutMs?: number;
  /** The longest pause between attempts while the receiver is unreachable. */
  maxBackoffMs?: number;
}

const byKey = <T>(key: (x: T) => number[]) => (a: T, b: T) => {
  const x = key(a), y = key(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** The snapshot in a fixed order, so equal data gives an equal digest. */
export function sortSnapshot(s: CloudSnapshot): CloudSnapshot {
  return {
    scores: s.scores.toSorted(byKey((r) => [
      r.competition_id,
      r.competitor_id,
      r.judge_id,
      r.criteria_id,
    ])),
    skips: s.skips.toSorted(byKey((r) => [
      r.session_id,
      r.competition_id,
      r.competitor_id,
    ])),
  };
}

export function snapshotDigest(
  festivalId: number,
  bundleDigest: string,
  s: CloudSnapshot,
): Promise<string> {
  return sha256Hex(
    new TextEncoder().encode(
      JSON.stringify([festivalId, bundleDigest, s.scores, s.skips]),
    ),
  );
}

export class CloudPusher {
  private fetchFn: typeof fetch;
  private now: () => Date;
  private lastDigest = "";
  private lastSentAt: Date | null = null;
  private lastFinalAt: Date | null = null;
  private offlineSince: Date | null = null;
  private lastError: string | null = null;
  private failures = 0;
  private busy: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = true;

  constructor(private deps: CloudDeps) {
    this.fetchFn = deps.fetch ?? ((...a) => fetch(...a));
    this.now = deps.now ?? (() => new Date());
  }

  status(): CloudStatus {
    const iso = (d: Date | null) => d && d.toISOString();
    return {
      enabled: true,
      last_sent_at: iso(this.lastSentAt),
      last_final_at: iso(this.lastFinalAt),
      offline_since: iso(this.offlineSince),
      last_error: this.lastError,
    };
  }

  /**
   * Send the snapshot now. A regular push is skipped when nothing changed since
   * the last one that arrived; a `final` one always goes (the authoritative
   * upload). Never throws: failure is the result, and the next tick retries.
   */
  push(opts: { final?: boolean } = {}): Promise<PushResult> {
    const final = opts.final === true;
    // One at a time: a push asked for while one is under way waits for it, then
    // reads a fresh snapshot (the one under way may predate the latest score).
    const run = this.busy.then(() => this.send(final));
    this.busy = run.catch(() => {});
    return run;
  }

  private async send(final: boolean): Promise<PushResult> {
    try {
      const snap = sortSnapshot(await this.deps.snapshot());
      const festivalId = this.deps.festivalId();
      const bundleDigest = this.deps.bundleDigest();
      const digest = await snapshotDigest(festivalId, bundleDigest, snap);
      if (!final && digest === this.lastDigest) {
        return { sent: false, skipped: "unchanged" };
      }
      const payload: CloudPayload = {
        festival_id: festivalId,
        bundle_digest: bundleDigest,
        digest,
        final,
        sent_at: this.now().toISOString(),
        ...snap,
      };
      const res = await this.fetchFn(this.deps.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.deps.token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.deps.timeoutMs ?? 15_000),
      });
      await res.body?.cancel();
      if (!res.ok) throw new Error(`receiver answered ${res.status}`);
      this.lastDigest = digest;
      this.lastSentAt = this.now();
      if (final) this.lastFinalAt = this.lastSentAt;
      this.offlineSince = null;
      this.lastError = null;
      this.failures = 0;
      return { sent: true, digest };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.offlineSince ??= this.now();
      this.lastError = error;
      this.failures++;
      console.warn(`cloud copy: push failed (${error}); will retry`);
      return { sent: false, error };
    }
  }

  /** The pause before the next attempt: the interval, backing off while failing. */
  nextDelayMs(): number {
    const max = this.deps.maxBackoffMs ?? 300_000;
    return this.failures === 0
      ? this.deps.intervalMs
      : Math.min(this.deps.intervalMs * 2 ** this.failures, max);
  }

  /** Push every interval (and soon after boot) until stop(). */
  start(firstInMs = 5_000): void {
    this.stopped = false;
    const tick = async () => {
      await this.push();
      if (!this.stopped) this.timer = setTimeout(tick, this.nextDelayMs());
    };
    this.timer = setTimeout(tick, firstInMs);
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
