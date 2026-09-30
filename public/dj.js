// app/frontend-src/connect.ts
var AuthError = class extends Error {
  constructor(message = "unauthorized") {
    super(message);
    this.name = "AuthError";
  }
};
var ResilientEventSource = class {
  listeners = /* @__PURE__ */ new Map();
  es = null;
  attached = /* @__PURE__ */ new Set();
  watchdog;
  retry;
  attempts = 0;
  stopped = false;
  opts;
  constructor(opts) {
    this.opts = {
      url: "/events",
      watchdogMs: 45e3,
      backoffMs: [
        1e3,
        2e3,
        5e3,
        1e4
      ],
      createEventSource: (url) => new EventSource(url),
      ...opts
    };
    this.open();
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
    if (this.es) this.attach(this.es, type);
  }
  close() {
    this.stopped = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.retry);
    this.es?.close();
    this.es = null;
    this.opts.onState?.("closed");
  }
  open() {
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
      if (es.readyState === 2) this.reopenLater();
    });
    for (const type of /* @__PURE__ */ new Set([
      "ping",
      "superseded",
      ...this.listeners.keys()
    ])) {
      this.attach(es, type);
    }
    this.arm();
  }
  attach(es, type) {
    if (this.attached.has(type)) return;
    this.attached.add(type);
    es.addEventListener(type, (e) => {
      if (this.es !== es) return;
      this.arm();
      if (type === "superseded") this.close();
      for (const l of this.listeners.get(type) ?? []) l(e);
    });
  }
  arm() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(() => {
      this.opts.onState?.("reconnecting");
      this.reopenLater();
    }, this.opts.watchdogMs);
  }
  reopenLater() {
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
          this.stopped = true;
          this.opts.onState?.("unauthorized");
          return;
        }
        return this.reopenLater();
      }
      this.open();
    }, delay);
  }
};
async function whoami() {
  const res = await fetch("/session", {
    cache: "no-store"
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`session check failed: ${res.status}`);
  return (await res.json()).client_id;
}
async function connect(kind, onState) {
  const clientId = await whoami();
  const m = /^(dj|judge|sb)(\d+)$/.exec(clientId);
  if (!m || m[1] !== kind) {
    throw new Error(`This link is for "${clientId}", not a ${kind} page`);
  }
  const sse = new ResilientEventSource({
    ensureSession: async () => {
      await whoami();
    },
    onState
  });
  return {
    clientId,
    num: Number(m[2]),
    sse
  };
}
async function bootstrap(kind, build) {
  try {
    const { num, sse } = await connect(kind, showConnection);
    const client = build(num, sse);
    globalThis.addEventListener("pagehide", () => {
      client?.destroy?.();
      sse.close();
    });
  } catch (err) {
    const message = err instanceof AuthError ? "This page needs a valid link. Ask an administrator for a new one." : err.message;
    const el = document.getElementById("status") ?? document.getElementById("connection");
    if (el) el.textContent = message;
    console.error(err);
  }
}
function showConnection(state) {
  const el = document.getElementById("connection");
  if (!el) return;
  el.textContent = {
    connecting: "Connecting...",
    open: "",
    reconnecting: "Connection lost - reconnecting...",
    closed: "Disconnected",
    unauthorized: "Access revoked - ask an administrator for a new link"
  }[state];
}
var RETRY_DELAYS_MS = [
  500,
  1e3,
  2e3
];
async function postResponse(body, retryDelaysMs = RETRY_DELAYS_MS) {
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
      if (res.status < 500 || attempt >= retryDelaysMs.length) {
        return {
          ok: res.ok,
          status: res.status
        };
      }
    } catch (_err) {
      if (attempt >= retryDelaysMs.length) return {
        ok: false,
        status: 0
      };
    }
    await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
  }
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
function durationMs(c) {
  return (c.duration ?? 0) * 1e3;
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
    sse.addEventListener("session_end", ({ data }) => {
      const { reason } = JSON.parse(data);
      this.setStatus({
        completed: "Session complete",
        aborted: "Session stopped by an administrator",
        error: "Session ended unexpectedly"
      }[reason] ?? "Session ended");
      this.onSessionEnd();
    });
    sse.addEventListener("superseded", () => {
      this.setStatus("This page was opened in another window and is now inactive");
      sse.close();
    });
    sse.addEventListener("client_status", ({ data }) => {
      JSON.parse(data);
    });
  }
  /** Hook: the session is over (subclasses stop whatever they were doing). */
  onSessionEnd() {
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
        ms + durationMs(c)
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
        const duration = durationMs(this.competition.competitors[i]);
        const cell = this.tbody.rows[i].cells[0];
        cell.textContent = formatTime(t);
        t = new Date(t.getTime() + duration);
      }
    }
  }
};

// app/frontend-src/dj.ts
var SILENT_WAV = "data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA";
var DjClient = class extends sseClient {
  startPauseButton;
  skipButton;
  audio;
  /** Position of the performance this page is currently handling, if any. */
  activePosition = void 0;
  /** Set when an administrator skips the performance being handled. */
  cancelled = false;
  /** Browsers block audio until a click; resolves once the DJ has enabled it. */
  audioUnlocked = false;
  unlockWaiters = [];
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
    this.setupAudioUnlock(doc);
    this.sse.addEventListener("performance_start", ({ data }) => {
      const msg = JSON.parse(data);
      const { position } = msg;
      assert(typeof position === "number");
      this.handlePerformanceStart(position);
    });
    this.sse.addEventListener("performance_skipped", ({ data }) => {
      const { position } = JSON.parse(data);
      if (this.activePosition === position) this.cancelActive();
    });
    this.sse.addEventListener("performance_recovery", ({ data }) => {
      const { position } = JSON.parse(data);
      assert(typeof position === "number");
      if (this.activePosition === position) return;
      this.handlePerformanceStart(position, {
        resume: true
      });
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
  /**
   * Browsers refuse to play audio until the page has had a click. If the page
   * has an #unlock button, the DJ presses it once before the show; a
   * performance that starts before that waits instead of failing (a failed
   * play() would otherwise count as a skipped act).
   */
  setupAudioUnlock(doc) {
    const button = doc.querySelector("#unlock");
    if (!button) {
      this.audioUnlocked = true;
      return;
    }
    button.onclick = () => {
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
  async untilAudioUnlocked() {
    if (this.audioUnlocked) return;
    this.setStatus("Tap 'Enable audio' to start playback");
    await new Promise((resolve) => this.unlockWaiters.push(resolve));
  }
  /** An administrator skipped this performance: stop now. */
  cancelActive() {
    this.cancelled = true;
    this.audio.pause();
    this.audio.onerror?.();
    for (const wake of this.unlockWaiters.splice(0)) wake();
    this.setStatus("Performance skipped by an administrator");
  }
  onSessionEnd() {
    const message = this.doc.getElementById("status")?.textContent ?? "";
    if (this.activePosition !== void 0) this.cancelActive();
    this.setStatus(message);
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
  async handlePerformanceStart(position, { resume = false } = {}) {
    this.activePosition = position;
    this.cancelled = false;
    try {
      const competitorId = this.competition.competitors[position].id;
      await this.untilAudioUnlocked();
      if (this.cancelled) throw new Error("cancelled");
      if (!resume) {
        await this.playAudio(`${this.competition.id}-${competitorId}-announce`);
      }
      this.audio.src = `${this.competition.id}-${competitorId}-music`;
      this.startPauseButton.disabled = false;
      this.skipButton.disabled = false;
      const completed = await this.playMusicWithControls(!resume);
      await this.report(position, completed);
    } catch (_err) {
      await this.report(position, false);
    } finally {
      this.activePosition = void 0;
      this.initialState();
    }
  }
  /** Tell the server how the performance ended; never throws. */
  async report(position, completed) {
    const { ok, status } = await postResponse({
      tag: perfTag(this.competition.id, position),
      payload: completed
    });
    if (status === 401 || status === 403) {
      this.setStatus("Access denied - ask an administrator for a new link");
    } else if (!ok && status !== 404) {
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
  playMusicWithControls(autoplay = true) {
    return new Promise((resolve, reject) => {
      this.audio.onended = () => resolve(true);
      this.audio.onerror = () => reject(new Error("audio_error"));
      this.skipButton.onclick = () => resolve(false);
      if (autoplay) this.audio.play().catch((err) => reject(err));
    });
  }
  destroy() {
    this.initialState();
  }
};

// app/frontend-src/main-dj.ts
await bootstrap("dj", (_num, sse) => new DjClient({
  sse
}));
