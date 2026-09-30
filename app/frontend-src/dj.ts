/// <reference lib="dom" />
import { assert } from "@std/assert";
import {
  PerformanceRecoveryMessage,
  PerformanceStartMessage,
} from "../src/protocol.ts";
import { perfTag } from "../src/contract.ts";
import { postResponse, type SseLike } from "./connect.ts";
import { sseClient } from "./sseClient.ts";

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
    try {
      const competitorId = this.competition!.competitors[position].id;

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
    if (!ok && status !== 404) {
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
