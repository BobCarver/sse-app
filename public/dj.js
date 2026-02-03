// deno:https://jsr.io/@std/assert/1.0.16/assertion_error.ts
var AssertionError = class extends Error {
  /** Constructs a new instance.
   *
   * @param message The error message.
   * @param options Additional options. This argument is still unstable. It may change in the future release.
   */
  constructor(message, options) {
    super(message, options);
    this.name = "AssertionError";
  }
};

// deno:https://jsr.io/@std/assert/1.0.16/assert.ts
function assert(expr, msg = "") {
  if (!expr) {
    throw new AssertionError(msg);
  }
}

// deno:https://jsr.io/@std/assert/1.0.16/equal.ts
var Temporal = globalThis.Temporal ?? /* @__PURE__ */ Object.create(null);
var stringComparablePrototypes = new Set([
  Intl.Locale,
  RegExp,
  Temporal.Duration,
  Temporal.Instant,
  Temporal.PlainDate,
  Temporal.PlainDateTime,
  Temporal.PlainTime,
  Temporal.PlainYearMonth,
  Temporal.PlainMonthDay,
  Temporal.ZonedDateTime,
  URL,
  URLSearchParams
].filter((x) => x != null).map((x) => x.prototype));
var TypedArray = Object.getPrototypeOf(Uint8Array);

// deno:https://jsr.io/@std/internal/1.0.12/styles.ts
var { Deno } = globalThis;
var noColor = typeof Deno?.noColor === "boolean" ? Deno.noColor : false;
var ANSI_PATTERN = new RegExp([
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
  "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TXZcf-nq-uy=><~]))"
].join("|"), "g");

// src/frontend/sseClient.ts
function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
var sseClient = class {
  competition = null;
  position = void 0;
  doc;
  sessionId = void 0;
  tbody;
  constructor(deps = {}) {
    this.doc = deps.document || document;
    this.tbody = this.doc.querySelector("#compTable tbody");
    const status = this.doc.getElementById("status");
    const sse = deps.sse || new EventSource("/events");
    sse.addEventListener("competition_start", ({ data }) => {
      const { competition } = JSON.parse(data);
      this.competition = competition;
      this.position = 0;
      this.tbody?.style.setProperty("--hide-count", String(0));
      this.buildCompetitorTable();
    });
    sse.addEventListener("performance_start", ({ data }) => {
      const { position } = JSON.parse(data);
      assert(typeof position === "number");
      this.position = position;
      this.updateTimes();
      this.tbody?.style.setProperty("--hide-count", String(position));
    });
    sse.addEventListener("client_status", ({ data }) => {
      const { connected_clients } = JSON.parse(data);
      connected_clients.forEach((client) => {
      });
    });
  }
  buildCompetitorTable() {
    if (this.tbody) {
      this.tbody.innerHTML = this.competition.competitors.reduce(([html, ms], c) => [
        html + `<tr>
          <td class="time-col">${formatTime(new Date(ms))}</td>
          <td>${c.name}</td></tr>`,
        ms + c.duration
      ], [
        "",
        Date.now()
      ])[0];
    }
  }
  updateTimes() {
    if (this.tbody?.rows.length) {
      let t = new Date(Date.now());
      for (let i = this.position; i < this.tbody.rows.length; i++) {
        const duration = this.competition.competitors[i].duration;
        const cell = this.tbody.rows[i].cells[0];
        cell.textContent = formatTime(t);
        t = new Date(t.getTime() + duration);
      }
    }
  }
};

// src/frontend/dj.ts
var DjClient = class extends sseClient {
  startPauseButton;
  skipButton;
  audio;
  constructor(deps = {}) {
    super({
      sse: deps.sse,
      document: deps.document
    });
    const doc = deps.document || document;
    this.audio = deps.audio || new Audio();
    this.startPauseButton = doc.querySelector("#start");
    this.skipButton = doc.querySelector("#skip");
    this.setupAudioControls();
    this.initialState();
    const sse = deps.sse || new EventSource("/events");
    sse.addEventListener("performance_start", ({ data }) => {
      const msg = JSON.parse(data);
      const { position } = msg;
      assert(typeof position === "number");
      this.handlePerformanceStart(position);
    });
  }
  setupAudioControls() {
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
  initialState() {
    this.audio.pause();
    this.startPauseButton.innerText = "play";
    this.startPauseButton.disabled = true;
    this.skipButton.disabled = true;
    this.audio.onended = null;
    this.audio.onerror = null;
    this.skipButton.onclick = null;
  }
  async handlePerformanceStart(position) {
    try {
      const competitorId = this.competition.competitors[position].id;
      await this.playAudio(`${this.competition.id}-${competitorId}-announce`);
      this.audio.src = `${this.competition.id}-${competitorId}-music`;
      this.startPauseButton.disabled = false;
      this.skipButton.disabled = false;
      const completed = await this.playMusicWithControls();
      const base = typeof location !== "undefined" ? location.origin : "http://localhost";
      fetch(`${base}/response`, {
        method: "POST",
        body: JSON.stringify({
          tag: `performance:${this.competition.id}:${competitorId}`,
          completed
        })
      });
    } catch (err) {
      const base = typeof location !== "undefined" ? location.origin : "http://localhost";
      fetch(`${base}/response`, {
        method: "POST",
        body: JSON.stringify({
          tag: `error:${err.message}`
        })
      });
    } finally {
      this.initialState();
    }
  }
  playAudio(src) {
    return new Promise((resolve, reject) => {
      this.audio.src = src;
      this.audio.onended = () => resolve();
      this.audio.onerror = () => reject(new Error("audio_error"));
      this.audio.play().catch((err) => reject(err));
    });
  }
  playMusicWithControls() {
    return new Promise((resolve, reject) => {
      this.audio.onended = () => resolve(true);
      this.audio.onerror = () => reject(new Error("audio_error"));
      this.skipButton.onclick = () => resolve(false);
      this.audio.play().catch((err) => reject(err));
    });
  }
  destroy() {
    this.initialState();
  }
};
export {
  DjClient
};