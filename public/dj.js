// app/frontend-src/connect.ts
async function registerAndConnect(sub) {
  const res = await fetch(`/register?sub=${encodeURIComponent(sub)}`);
  if (!res.ok) throw new Error(`register failed: ${res.status}`);
  return new EventSource("/events");
}
var RETRY_DELAYS_MS = [
  500,
  1e3,
  2e3
];
async function postResponse(body) {
  const base = globalThis.location?.origin ?? "http://localhost";
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${base}/response`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (res.status < 500 || attempt >= RETRY_DELAYS_MS.length) {
        return {
          ok: res.ok,
          status: res.status
        };
      }
    } catch (_err) {
      if (attempt >= RETRY_DELAYS_MS.length) return {
        ok: false,
        status: 0
      };
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
}
function requireParam(name) {
  const v = new URLSearchParams(globalThis.location?.search).get(name);
  if (!v || !/^\d+$/.test(v)) {
    const msg = `Missing or invalid ?${name}= in URL`;
    const el = document.getElementById("status");
    if (el) el.textContent = msg;
    throw new Error(msg);
  }
  return v;
}

// deno:https://jsr.io/@std/assert/1.0.18/assertion_error.ts
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

// deno:https://jsr.io/@std/assert/1.0.18/equal.ts
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

// deno:https://jsr.io/@std/assert/1.0.18/assert.ts
function assert(expr, msg = "") {
  if (!expr) {
    throw new AssertionError(msg);
  }
}

// app/src/contract.ts
var perfTag = (competitionId, position) => `perf:${competitionId}:${position}`;

// app/frontend-src/html.ts
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[c]);
}

// app/frontend-src/sseClient.ts
function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${hours}:${minutes}`;
}
var sseClient = class {
  competition = null;
  position = void 0;
  doc;
  /** The single SSE connection for this page; subclasses add listeners to it. */
  sse;
  tbody;
  constructor(deps = {}) {
    this.doc = deps.document || document;
    this.tbody = this.doc.querySelector("#compTable tbody");
    const sse = this.sse = deps.sse || new EventSource("/events");
    sse.addEventListener("competition_start", ({ data }) => {
      const { competition } = JSON.parse(data);
      this.competition = competition;
      this.position = 0;
      this.tbody?.style.setProperty("--hide-count", String(0));
      this.buildCompetitorTable();
      this.setText("currentCompetition", competition.name);
    });
    sse.addEventListener("performance_start", ({ data }) => {
      const { position } = JSON.parse(data);
      assert(typeof position === "number");
      this.position = position;
      this.setText("currentCompetitor", this.competition?.competitors[position]?.name ?? "");
      this.updateTimes();
      this.tbody?.style.setProperty("--hide-count", String(position));
    });
    sse.addEventListener("client_status", ({ data }) => {
      JSON.parse(data);
    });
  }
  /** Set textContent of #id if the page has it. */
  setText(id, text) {
    const el = this.doc.getElementById(id);
    if (el) el.textContent = text;
  }
  /** Show a message in #status (empty string clears it). */
  setStatus(message) {
    this.setText("status", message);
  }
  buildCompetitorTable() {
    if (this.tbody) {
      this.tbody.innerHTML = this.competition.competitors.reduce(([html, ms], c) => [
        html + `<tr>
          <td class="time-col">${formatTime(new Date(ms))}</td>
          <td>${escapeHtml(c.name)}</td></tr>`,
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

// app/frontend-src/dj.ts
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
    this.sse.addEventListener("performance_start", ({ data }) => {
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
      await this.report(position, completed);
    } catch (_err) {
      await this.report(position, false);
    } finally {
      this.initialState();
    }
  }
  /** Tell the server how the performance ended; never throws. */
  async report(position, completed) {
    const { ok, status } = await postResponse({
      tag: perfTag(this.competition.id, position),
      payload: completed
    });
    if (!ok && status !== 404) {
      this.setStatus("Could not reach server - performance result not sent");
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

// app/frontend-src/main-dj.ts
var client = new DjClient({
  sse: await registerAndConnect(`dj${requireParam("track")}`)
});
globalThis.addEventListener("pagehide", () => client.destroy());
