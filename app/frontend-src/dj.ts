/// <reference lib="dom" />
import { assert } from "@std/assert";
import {
  AudioAvailableMessage,
  PerformanceRecoveryMessage,
  PerformanceSkippedMessage,
  PerformanceStartMessage,
} from "../src/protocol.ts";
import { audioUrl, perfTag } from "../src/contract.ts";
import { AudioPrefetcher } from "./audioCache.ts";
import { postResponse, type SseLike } from "./connect.ts";
import { sseClient } from "./sseClient.ts";

// 25ms of silence: playing it inside a click unlocks audio for the page.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

const PLAY_PROMPT = "Press play to start the song";

export interface DjDependencies {
  sse?: SseLike;
  document?: Document;
  audio?: HTMLAudioElement;
  /** Downloads the session's audio ahead of time; absent = play from the network. */
  prefetcher?: AudioPrefetcher;
  /** For tests: how long to wait before retrying an incomplete download. */
  audioRetryMs?: number;
}

/*
The DJ page. It plays each competitor's announcement and music on the server's
cue and reports back whether the performance finished or was skipped.

Connection:
  Extends sseClient, which owns the page's single SSE connection. Listens for
  "performance_start" (play) and "performance_recovery" (the page reconnected or
  reloaded mid-performance: resume without repeating the announcement),
  "performance_skipped" (an operator skipped it: stop), and "audio_available"
  (the session's audio set is final: download it).

Audio:
  Files are fetched over HTTP ahead of the session by AudioPrefetcher
  (audioCache.ts), verified and cached in the browser; playback uses the local copy
  and falls back to the network URL. The page tells the server when it holds the
  whole set (POST /audio-ready), which releases the session's start.
  Playback uses one HTMLAudioElement with start/pause and skip controls. Browsers
  block audio until a click, so the DJ presses "Enable audio" once.

Performance flow (handlePerformanceStart):
  1. Wait for audio to be enabled.
  2. Play the announcement (skipped when resuming), then the music.
  3. Wait for playback: resolves true when the audio ends, false when the DJ
     skips, and rejects on a playback error.
  4. POST the result to /response for tag perf:<competition>:<position>.
*/

export class DjClient extends sseClient {
  private startPauseButton: HTMLButtonElement;
  private skipButton: HTMLButtonElement;
  private audio: HTMLAudioElement;
  /** Position of the performance this page is currently handling, if any. */
  private activePosition: number | undefined = undefined;
  /** Set when an administrator skips the performance being handled. */
  private cancelled = false;
  /** Browsers block audio until a click; resolves once the DJ has enabled it. */
  private audioUnlocked = false;
  private unlockWaiters: Array<() => void> = [];
  private prefetcher?: AudioPrefetcher;
  private audioRetryMs: number;
  private audioRetry?: ReturnType<typeof setTimeout>;

  constructor(deps: DjDependencies = {}) {
    super({
      sse: deps.sse,
      document: deps.document,
    });

    const doc = deps.document || document;
    this.audio = deps.audio || new Audio();
    this.prefetcher = deps.prefetcher;
    this.audioRetryMs = deps.audioRetryMs ?? 10_000;

    this.startPauseButton = doc.querySelector("#start") as HTMLButtonElement;
    this.skipButton = doc.querySelector("#skip") as HTMLButtonElement;

    this.setupAudioControls();
    this.initialState();
    this.setupAudioUnlock(doc);
    this.sse.addEventListener(
      "performance_start",
      ({ data }) => {
        const msg = JSON.parse(data) as PerformanceStartMessage;
        const { position } = msg;
        assert(typeof position === "number");
        this.handlePerformanceStart(position);
      },
    );
    // Sent when this DJ (re)connects mid-performance. If this page is already
    // handling that performance (a network blip) do nothing; if the page was
    // reloaded, resume without repeating the announcement or auto-playing.
    // The upload cut-off passed (or the set changed): fetch what is missing.
    this.sse.addEventListener("audio_available", ({ data }) => {
      const msg = JSON.parse(data) as AudioAvailableMessage;
      assert(typeof msg.digest === "string");
      void this.syncAudio();
    });
    this.sse.addEventListener("performance_skipped", ({ data }) => {
      const { position } = JSON.parse(data) as PerformanceSkippedMessage;
      if (this.activePosition === position) this.cancelActive();
    });
    this.sse.addEventListener("performance_recovery", ({ data }) => {
      const { position } = JSON.parse(data) as PerformanceRecoveryMessage;
      assert(typeof position === "number");
      if (this.activePosition === position) return;
      this.handlePerformanceStart(position, { resume: true });
    });
  }

  /**
   * Download the next session's audio (if it is final), show progress, and tell
   * the server once everything is held and verified. Safe to call any time;
   * retries itself while files are still missing.
   */
  async syncAudio(): Promise<void> {
    if (!this.prefetcher) return;
    clearTimeout(this.audioRetry);
    try {
      const r = await this.prefetcher.sync();
      if (!r.available) {
        this.setAudioStatus("");
        return;
      }
      this.setAudioStatus(
        r.total === 0
          ? ""
          : r.complete
          ? `Audio ready (${r.ready}/${r.total})`
          : `Audio: ${r.ready}/${r.total} ready`,
      );
      if (r.complete && r.total > 0) {
        // Always (re)report: the server forgets reports when it restarts.
        if (!await this.reportReady(r.digest)) this.scheduleAudioRetry();
        return;
      }
      if (!r.complete) this.scheduleAudioRetry();
    } catch (err) {
      console.warn("audio sync failed:", err);
      this.scheduleAudioRetry();
    }
  }

  private scheduleAudioRetry(): void {
    if (this.audioRetryMs <= 0) return;
    this.audioRetry = setTimeout(
      () => void this.syncAudio(),
      this.audioRetryMs,
    );
  }

  private async reportReady(digest: string): Promise<boolean> {
    try {
      const res = await fetch("/audio-ready", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ digest }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private setAudioStatus(text: string): void {
    const el = this.doc.getElementById("audioStatus");
    if (el) el.textContent = text;
  }

  /** Play from the verified local copy when there is one. */
  private async sourceFor(url: string): Promise<string> {
    return this.prefetcher ? await this.prefetcher.srcFor(url) : url;
  }

  private setupAudioControls(): void {
    this.startPauseButton.onclick = () => {
      if (this.audio.paused) {
        // A newly loaded song starts at 0; after a pause this carries on.
        this.startPauseButton.innerText = "pause";
        this.audio.play().catch((err) => console.error("play() failed:", err));
      } else {
        this.startPauseButton.innerText = "play";
        this.audio.pause();
      }
    };
  }

  /**
   * Browsers refuse to play audio until the page has had a click. If the page
   * has an #unlock button, the DJ presses it once before the show; a
   * performance that starts before that waits instead of failing (a failed
   * play() would otherwise count as a skipped act).
   */
  private setupAudioUnlock(doc: Document): void {
    const button = doc.querySelector("#unlock") as HTMLButtonElement | null;
    if (!button) {
      this.audioUnlocked = true; // nothing to wait for (tests, embedded use)
      return;
    }
    button.onclick = () => {
      // Play a short silent clip on the real element (some browsers unlock per
      // element), and only release waiting performances once it has finished:
      // otherwise its cleanup could stop the announcement that follows.
      const done = () => {
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audioUnlocked = true;
        button.hidden = true;
        this.setStatus("");
        for (const wake of this.unlockWaiters.splice(0)) wake();
      };
      this.audio.src = SILENT_WAV;
      this.audio.onended = done;
      this.audio.onerror = done;
      this.audio.play().catch(done);
    };
  }

  private async untilAudioUnlocked(): Promise<void> {
    if (this.audioUnlocked) return;
    this.setStatus("Tap 'Enable audio' to start playback");
    await new Promise<void>((resolve) => this.unlockWaiters.push(resolve));
  }

  /** An administrator skipped this performance: stop now. */
  private cancelActive(): void {
    this.cancelled = true;
    this.audio.pause();
    // reject whichever playback promise is pending; the report then says skipped
    (this.audio.onerror as (() => void) | null)?.();
    for (const wake of this.unlockWaiters.splice(0)) wake();
    this.setStatus("Performance skipped by an administrator");
  }

  protected override onSessionEnd(): void {
    // keep the "session ended" message the base class just showed
    const message = this.doc.getElementById("status")?.textContent ?? "";
    if (this.activePosition !== undefined) this.cancelActive();
    this.setStatus(message);
  }

  private initialState(): void {
    this.audio.pause();
    this.startPauseButton.innerText = "play";
    this.startPauseButton.disabled = true;
    this.skipButton.disabled = true;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.skipButton.onclick = null;
  }

  private async handlePerformanceStart(
    position: number,
    { resume = false } = {},
  ): Promise<void> {
    this.activePosition = position;
    this.cancelled = false;
    let completed = false;
    try {
      const competitorId = this.competition!.competitors[position].id;

      await this.untilAudioUnlocked();
      if (this.cancelled) throw new Error("cancelled");

      // Skip works from the moment the performance starts: during the
      // announcement, while the song waits for play, or while it plays.
      const skip = new Promise<"skip">((resolve) => {
        this.skipButton.onclick = () => resolve("skip");
      });
      this.skipButton.disabled = false;

      completed = await this.runPerformance(competitorId, resume, skip);
    } catch (_err) {
      // playback failed: report the performance as not completed (skipped)
      completed = false;
    }

    // Stop and reset the controls BEFORE telling the server. It may start the
    // next performance the moment it hears from us (always, after a skip), and
    // this performance's cleanup must not disturb that one.
    this.finish(position);
    try {
      await this.report(position, completed);
    } finally {
      if (this.activePosition === position) this.activePosition = undefined;
    }
  }

  /**
   * Play the announcement, then wait for the DJ to press play for the song.
   * Resolves true when the song ends, false when the DJ skips.
   */
  private async runPerformance(
    competitorId: number,
    resume: boolean,
    skip: Promise<"skip">,
  ): Promise<boolean> {
    const competitionId = this.competition!.id;

    // Announcement (not repeated when resuming after a reload).
    if (!resume) {
      const src = await this.sourceFor(
        audioUrl(competitionId, competitorId, "announce"),
      );
      const result = await Promise.race([
        this.playAudio(src).then(() => "ended" as const),
        skip,
      ]);
      if (result === "skip") return false;
    }

    // The song is loaded but never starts by itself: the DJ presses play (a
    // browser would also refuse autoplay without a click, and a rejected
    // play() would count as a skipped act).
    this.audio.src = await this.sourceFor(
      audioUrl(competitionId, competitorId, "music"),
    );
    this.startPauseButton.disabled = false;
    this.setStatus(PLAY_PROMPT);
    const result = await Promise.race([this.waitForSongEnd(), skip]);
    return result !== "skip";
  }

  /** Stop playback and put the controls back, unless a newer performance has taken over. */
  private finish(position: number): void {
    if (this.activePosition !== position) return;
    this.audio.pause();
    this.initialState();
    if (this.doc.getElementById("status")?.textContent === PLAY_PROMPT) {
      this.setStatus("");
    }
  }

  /** Tell the server how the performance ended; never throws. */
  private async report(position: number, completed: boolean): Promise<void> {
    const { ok, status } = await postResponse({
      tag: perfTag(this.competition!.id, position),
      payload: completed,
    });
    // 404 = the server already moved on; nothing more to do.
    if (status === 401 || status === 403) {
      this.setStatus("Access denied - ask an administrator for a new link");
    } else if (!ok && status !== 404) {
      this.setStatus("Could not reach server - performance result not sent");
    }
  }

  private playAudio(src: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.audio.src = src;
      this.audio.onended = () => resolve();
      this.audio.onerror = () => reject(new Error("audio_error"));
      this.audio.play().catch((err) => reject(err));
    });
  }

  /** Resolves when the song has played to the end; rejects if playback fails. */
  private waitForSongEnd(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.audio.onended = () => resolve(true);
      this.audio.onerror = () => reject(new Error("audio_error"));
    });
  }

  public destroy(): void {
    this.initialState();
  }
}
