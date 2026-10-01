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

// app/src/sha256.ts
var K = new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var rotr = (x, n) => x >>> n | x << 32 - n;
function sha256Bytes(data) {
  const h = new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  const padded = new Uint8Array(data.length + 9 + 63 >> 6 << 6);
  padded.set(data);
  padded[data.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(data.length / 536870912), false);
  view.setUint32(padded.length - 4, data.length << 3 >>> 0, false);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ w[i - 15] >>> 3;
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ w[i - 2] >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = e & f ^ ~e & g;
      const t1 = hh + S1 + ch + K[i] + w[i] | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = a & b ^ a & c ^ b & c;
      const t2 = S0 + maj | 0;
      hh = g;
      g = f;
      f = e;
      e = d + t1 | 0;
      d = c;
      c = b;
      b = a;
      a = t1 + t2 | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i], false);
  return out;
}
var hex = (bytes) => [
  ...bytes
].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(data) {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) return hex(new Uint8Array(await subtle.digest("SHA-256", data)));
  return hex(sha256Bytes(data instanceof Uint8Array ? data : new Uint8Array(data)));
}

// app/src/contract.ts
var perfTag = (competitionId, position) => `perf:${competitionId}:${position}`;
var audioUrl = (competitionId, competitorId, kind) => `/audio/${competitionId}/${competitorId}/${kind}`;
function manifestDigest(files) {
  if (files.length === 0) return Promise.resolve("");
  const lines = files.map((f) => `${f.competition_id}:${f.competitor_id}:${f.kind}:${f.sha256}`).sort().join("\n");
  return sha256Hex(new TextEncoder().encode(lines));
}

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
var PLAY_PROMPT = "Press play to start the song";
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
  prefetcher;
  audioRetryMs;
  audioRetry;
  constructor(deps = {}) {
    super({
      sse: deps.sse,
      document: deps.document
    });
    const doc = deps.document || document;
    this.audio = deps.audio || new Audio();
    this.prefetcher = deps.prefetcher;
    this.audioRetryMs = deps.audioRetryMs ?? 1e4;
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
    this.sse.addEventListener("audio_available", ({ data }) => {
      const msg = JSON.parse(data);
      assert(typeof msg.digest === "string");
      void this.syncAudio();
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
  /**
   * Download the next session's audio (if it is final), show progress, and tell
   * the server once everything is held and verified. Safe to call any time;
   * retries itself while files are still missing.
   */
  async syncAudio() {
    if (!this.prefetcher) return;
    clearTimeout(this.audioRetry);
    try {
      const r = await this.prefetcher.sync();
      if (!r.available) {
        this.setAudioStatus("");
        return;
      }
      this.setAudioStatus(r.total === 0 ? "" : r.complete ? `Audio ready (${r.ready}/${r.total})` : `Audio: ${r.ready}/${r.total} ready`);
      if (r.complete && r.total > 0) {
        if (!await this.reportReady(r.digest)) this.scheduleAudioRetry();
        return;
      }
      if (!r.complete) this.scheduleAudioRetry();
    } catch (err) {
      console.warn("audio sync failed:", err);
      this.scheduleAudioRetry();
    }
  }
  scheduleAudioRetry() {
    if (this.audioRetryMs <= 0) return;
    this.audioRetry = setTimeout(() => void this.syncAudio(), this.audioRetryMs);
  }
  async reportReady(digest) {
    try {
      const res = await fetch("/audio-ready", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          digest
        })
      });
      return res.ok;
    } catch {
      return false;
    }
  }
  setAudioStatus(text) {
    const el = this.doc.getElementById("audioStatus");
    if (el) el.textContent = text;
  }
  /** Play from the verified local copy when there is one. */
  async sourceFor(url) {
    return this.prefetcher ? await this.prefetcher.srcFor(url) : url;
  }
  setupAudioControls() {
    this.startPauseButton.onclick = () => {
      if (this.audio.paused) {
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
    let completed = false;
    try {
      const competitorId = this.competition.competitors[position].id;
      await this.untilAudioUnlocked();
      if (this.cancelled) throw new Error("cancelled");
      const skip = new Promise((resolve) => {
        this.skipButton.onclick = () => resolve("skip");
      });
      this.skipButton.disabled = false;
      completed = await this.runPerformance(competitorId, resume, skip);
    } catch (_err) {
      completed = false;
    }
    this.finish(position);
    try {
      await this.report(position, completed);
    } finally {
      if (this.activePosition === position) this.activePosition = void 0;
    }
  }
  /**
   * Play the announcement, then wait for the DJ to press play for the song.
   * Resolves true when the song ends, false when the DJ skips.
   */
  async runPerformance(competitorId, resume, skip) {
    const competitionId = this.competition.id;
    if (!resume) {
      const src = await this.sourceFor(audioUrl(competitionId, competitorId, "announce"));
      const result2 = await Promise.race([
        this.playAudio(src).then(() => "ended"),
        skip
      ]);
      if (result2 === "skip") return false;
    }
    this.audio.src = await this.sourceFor(audioUrl(competitionId, competitorId, "music"));
    this.startPauseButton.disabled = false;
    this.setStatus(PLAY_PROMPT);
    const result = await Promise.race([
      this.waitForSongEnd(),
      skip
    ]);
    return result !== "skip";
  }
  /** Stop playback and put the controls back, unless a newer performance has taken over. */
  finish(position) {
    if (this.activePosition !== position) return;
    this.audio.pause();
    this.initialState();
    if (this.doc.getElementById("status")?.textContent === PLAY_PROMPT) {
      this.setStatus("");
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
  /** Resolves when the song has played to the end; rejects if playback fails. */
  waitForSongEnd() {
    return new Promise((resolve, reject) => {
      this.audio.onended = () => resolve(true);
      this.audio.onerror = () => reject(new Error("audio_error"));
    });
  }
  destroy() {
    this.initialState();
  }
};

// app/frontend-src/audioCache.ts
var CACHE_NAME = "dj-audio-v1";
var keyFor = (sha256) => `https://audio.cache/${sha256}`;
var MemoryCache = class {
  items = /* @__PURE__ */ new Map();
  match(key) {
    const hit = this.items.get(key);
    return Promise.resolve(hit && new Response(hit.buf.slice(0), {
      headers: {
        "content-type": hit.type
      }
    }));
  }
  async put(key, res) {
    this.items.set(key, {
      buf: await res.arrayBuffer(),
      type: res.headers.get("content-type") ?? "audio/mpeg"
    });
  }
  delete(key) {
    return Promise.resolve(this.items.delete(key));
  }
  keys() {
    return Promise.resolve([
      ...this.items.keys()
    ].map((url) => ({
      url
    })));
  }
};
function openDefaultCache(g = globalThis) {
  return g.caches ? g.caches.open(CACHE_NAME) : Promise.resolve(new MemoryCache());
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
var AudioPrefetcher = class {
  deps;
  fetchFn;
  openCache;
  cache;
  urlBySha;
  bySlot;
  running;
  constructor(deps = {}) {
    this.deps = deps;
    this.urlBySha = /* @__PURE__ */ new Map();
    this.bySlot = /* @__PURE__ */ new Map();
    this.fetchFn = deps.fetch ?? ((...a) => fetch(...a));
    this.openCache = deps.openCache ?? (() => openDefaultCache());
  }
  getCache() {
    return this.cache ??= this.openCache();
  }
  /** Bring the cache in line with the server's manifest. Overlapping calls share one run. */
  sync() {
    return this.running ??= this.doSync().finally(() => {
      this.running = void 0;
    });
  }
  async doSync() {
    const res = await this.fetchFn("/audio-manifest", {
      cache: "no-store"
    });
    if (!res.ok && res.status !== 425) {
      throw new Error(`manifest failed: ${res.status}`);
    }
    const manifest = await res.json();
    const base = {
      sessionId: manifest.session_id,
      available: manifest.available
    };
    if (!manifest.available) {
      return {
        ...base,
        total: 0,
        ready: 0,
        digest: "",
        complete: false
      };
    }
    const cache = await this.getCache();
    this.bySlot.clear();
    for (const f of manifest.files) this.bySlot.set(f.url, f.sha256);
    const wanted = new Set(manifest.files.map((f) => keyFor(f.sha256)));
    for (const k of await cache.keys()) {
      if (!wanted.has(k.url)) await cache.delete(k.url);
    }
    for (const [sha, url] of this.urlBySha) {
      if (!wanted.has(keyFor(sha))) {
        this.deps.revokeObjectURL?.(url);
        this.urlBySha.delete(sha);
      }
    }
    const total = manifest.files.length;
    let ready = 0;
    const held = [];
    const todo = [];
    for (const f of manifest.files) {
      if (await cache.match(keyFor(f.sha256))) {
        ready++;
        held.push(f);
      } else todo.push(f);
    }
    this.deps.onProgress?.(ready, total);
    const queue = [
      ...todo
    ];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        if (await this.download(cache, f)) {
          ready++;
          held.push(f);
          this.deps.onProgress?.(ready, total);
        }
      }
    };
    await Promise.all(Array.from({
      length: Math.min(this.deps.concurrency ?? 2, queue.length)
    }, worker));
    const complete = ready === total;
    return {
      ...base,
      total,
      ready,
      // The digest of what is held: equals the server's only if nothing is missing.
      digest: complete ? await manifestDigest(held) : "",
      complete
    };
  }
  /** Fetch one file in full, verify it and store it. False if it could not be had. */
  async download(cache, f) {
    const delays = this.deps.retryDelaysMs ?? [
      500,
      2e3,
      5e3
    ];
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.fetchFn(f.url, {
          cache: "no-store",
          credentials: "same-origin"
        });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const buf = await res.arrayBuffer();
        if (buf.byteLength !== f.bytes) throw new Error("size mismatch");
        if (await sha256Hex(buf) !== f.sha256) throw new Error("hash mismatch");
        await cache.put(keyFor(f.sha256), new Response(buf, {
          headers: {
            "content-type": res.headers.get("content-type") ?? "audio/mpeg"
          }
        }));
        return true;
      } catch (err) {
        console.warn(`audio download failed (${f.url}):`, err);
        if (attempt >= delays.length) return false;
        await sleep(delays[attempt]);
      }
    }
  }
  /**
   * Where to play `url` from: the verified local copy if there is one, else
   * the network URL (which the server still serves).
   */
  async srcFor(url) {
    const sha = this.bySlot.get(url);
    if (!sha || !this.deps.createObjectURL) return url;
    const existing = this.urlBySha.get(sha);
    if (existing) return existing;
    try {
      const hit = await (await this.getCache()).match(keyFor(sha));
      if (!hit) return url;
      const objectUrl = this.deps.createObjectURL(await hit.blob());
      this.urlBySha.set(sha, objectUrl);
      return objectUrl;
    } catch {
      return url;
    }
  }
};

// app/frontend-src/main-dj.ts
await bootstrap("dj", (_num, sse) => {
  const prefetcher = new AudioPrefetcher({
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url)
  });
  const client = new DjClient({
    sse,
    prefetcher
  });
  void client.syncAudio();
  return client;
});
