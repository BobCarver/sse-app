/// <reference lib="dom" />
import { assert } from "std/assert/assert";
import { PerformanceStartMessage } from "../protocol.ts";
import { sseClient } from "./sseClient.ts";

export interface DjDependencies {
  sse?: EventSource; //EventSource;
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
    // open an SSE connection (use injected `sse` for tests)
    const sse = (deps.sse) || new EventSource("/events");
    sse.addEventListener(
      "performance_start",
      ({ data }) => {
        const msg = JSON.parse(data) as PerformanceStartMessage;
        const { position } = msg;
        assert(typeof position === "number");
        this.handlePerformanceStart(position);
      },
    );
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

  private async handlePerformanceStart(position: number): Promise<void> {
    try {
      const competitorId = this.competition!.competitors[position].id;

      // Play announcement
      await this.playAudio(
        `${this.competition!.id}-${competitorId}-announce`,
      );

      // Play music
      this.audio.src = `${this.competition!.id}-${competitorId}-music`;
      this.startPauseButton.disabled = false;
      this.skipButton.disabled = false;

      const completed = await this.playMusicWithControls();
      const base = typeof location !== "undefined"
        ? location.origin
        : "http://localhost";
      fetch(`${base}/response`, {
        method: "POST",
        body: JSON.stringify({
          tag: `performance:${this.competition!.id}:${competitorId}`,
          completed,
        }),
      });
    } catch (err) {
      const base = typeof location !== "undefined"
        ? location.origin
        : "http://localhost";
      fetch(`${base}/response`, {
        method: "POST",
        body: JSON.stringify({
          tag: `error:${(err as Error).message}`,
        }),
      });
    } finally {
      this.initialState();
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

  private playMusicWithControls(): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      this.audio.onended = () => resolve(true);
      this.audio.onerror = () => reject(new Error("audio_error"));
      this.skipButton.onclick = () => resolve(false);
      this.audio.play().catch((err) => reject(err));
    });
  }

  public destroy(): void {
    this.initialState();
  }
}
