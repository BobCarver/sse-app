/// <reference lib="dom" />
import { assert } from "@std/assert";
import {
  PerformanceRecoveryMessage,
  PerformanceSkippedMessage,
  PerformanceStartMessage,
} from "../src/protocol.ts";
import { perfTag } from "../src/contract.ts";
import { postResponse, type SseLike } from "./connect.ts";
import { sseClient } from "./sseClient.ts";

// 25ms of silence: playing it inside a click unlocks audio for the page.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";

export interface DjDependencies {
  sse?: SseLike;
  document?: Document;
  audio?: HTMLAudioElement;
}

/*
This is a music player client that communicates with a server via WebSocket to receive and play audio tracks sequentially.

Architecture
WebSocket Connection:

Creats a sseClient to manage SSE connection and listens for "performance_start" events.
Event Handling:
  On receiving a "performance_start" event, it triggers the handlePerformanceStart method.

Audio Playback:

Uses HTMLAudioElement to play audio tracks.
Provides controls for starting/pausing and skipping tracks.

Key Components
UI State Management
Button handlers:

Audio Playback Flow
  1. Receive perform event with derives URL from competition and competitor IDs.
  2. Set up cleanup function that:
      Pauses audio
      Disables buttons during playback
      Clears event listeners
  3. Wait for playback to complete via Promise:
      Resolves when audio.onended fires (normal completion) returning true
      Resolves when user clicks skip button returning false
      Rejects on playback error
  4. Restore buttons after playback completes
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

  constructor(deps: DjDependencies = {}) {
    super({
      sse: deps.sse,
      document: deps.document,
    });

    const doc = deps.document || document;
    this.audio = deps.audio || new Audio();

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

  private setupAudioControls(): void {
    this.startPauseButton.onclick = () => {
      if (this.audio.paused) {
        this.startPauseButton.innerText = "pause";
        this.audio.currentTime = 0;
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
    try {
      const competitorId = this.competition!.competitors[position].id;

      await this.untilAudioUnlocked();
      if (this.cancelled) throw new Error("cancelled");

      // Play announcement (skipped when resuming after a reload)
      if (!resume) {
        await this.playAudio(
          `${this.competition!.id}-${competitorId}-announce`,
        );
      }

      // Play music
      this.audio.src = `${this.competition!.id}-${competitorId}-music`;
      this.startPauseButton.disabled = false;
      this.skipButton.disabled = false;

      // When resuming, wait for the DJ to press play: browsers block autoplay
      // without a user gesture, and a rejected play() would skip the act.
      const completed = await this.playMusicWithControls(!resume);
      await this.report(position, completed);
    } catch (_err) {
      // playback failed: report the performance as not completed (skipped)
      await this.report(position, false);
    } finally {
      this.activePosition = undefined;
      this.initialState();
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

  private playMusicWithControls(autoplay = true): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.audio.onended = () => resolve(true);
      this.audio.onerror = () => reject(new Error("audio_error"));
      this.skipButton.onclick = () => resolve(false);
      if (autoplay) this.audio.play().catch((err) => reject(err));
    });
  }

  public destroy(): void {
    this.initialState();
  }
}
