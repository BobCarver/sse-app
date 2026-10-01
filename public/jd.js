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

// app/src/contract.ts
var scoreTag = (competitionId, competitorId, judgeId) => `score:${competitionId}:${competitorId}:${judgeId}`;

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

// app/frontend-src/jd.ts
var JudgeClient = class extends sseClient {
  judge_id;
  alert;
  /** Which competition the sliders were built for (replays must not rebuild them). */
  renderedCompetitionId;
  /** Why this judge's last score never got in (kept when the session ends). */
  missedNote;
  /** "competitionId:position" of the scoring window currently open, if any. */
  scoringKey;
  sliders;
  submit;
  doc;
  nav;
  timerFn;
  clearTimerFn;
  constructor(judge_id, deps = {}) {
    super(deps), this.judge_id = judge_id, this.alert = void 0, this.renderedCompetitionId = void 0, this.missedNote = void 0, this.scoringKey = void 0;
    this.doc = deps.document || document;
    this.nav = deps.navigator || navigator;
    this.timerFn = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimerFn = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.judge_id = judge_id;
    this.sliders = this.doc.querySelector("#sliders");
    this.submit = this.doc.querySelector("#submit");
    this.sliders.addEventListener("input", (e) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      const scoreDisplay = target.nextElementSibling;
      if (!scoreDisplay) return;
      const val = target.value === "" ? "0" : target.value;
      scoreDisplay.textContent = parseFloat(val).toFixed(1);
    });
    this.submit.onclick = this.submitScores.bind(this);
    this.submit.disabled = true;
    this.sse.addEventListener("competition_start", ({ data }) => {
      const { competition } = JSON.parse(data);
      this.competition = competition;
      if (this.renderedCompetitionId === competition.id) return;
      this.renderedCompetitionId = competition.id;
      this.updateCriteria(competition.rubric);
    });
    this.sse.addEventListener("scoring_closed", ({ data }) => {
      const { missing_judge_ids } = JSON.parse(data);
      if (!missing_judge_ids.includes(this.judge_id)) return;
      this.missedNote = "Scoring closed - your scores were not received in time";
      this.closeScoring(this.missedNote);
    });
    this.sse.addEventListener("enable_scoring", ({ data }) => {
      const msg = JSON.parse(data || "{}");
      const key = `${msg.competition_id}:${msg.position}`;
      if (this.scoringKey === key && !this.submit.disabled) return;
      this.scoringKey = key;
      this.missedNote = void 0;
      this.enableSubmit();
    });
  }
  onSessionEnd() {
    this.closeScoring();
    if (this.missedNote) {
      const ended = this.doc.getElementById("status")?.textContent ?? "";
      this.setStatus(`${ended} - ${this.missedNote}`);
    }
  }
  /** Disable submitting and stop the reminder; optionally explain why. */
  closeScoring(message) {
    if (this.alert !== void 0) {
      this.clearTimerFn(this.alert);
      this.alert = void 0;
    }
    if (!this.submit.disabled) {
      this.submit.disabled = true;
      if (message) this.setStatus(message);
    }
    this.scoringKey = void 0;
  }
  updateCriteria(rubric) {
    const judge = rubric.judges.find(({ id }) => id === this.judge_id);
    if (!judge) {
      this.sliders.innerHTML = "";
      return;
    }
    const criteria = rubric.criteria.filter(({ id }) => judge.criteria.includes(id));
    this.sliders.innerHTML = criteria.reduce((acc, c) => acc + `<div class="slider-group">
                <label>${escapeHtml(c.name)}</label>
                <input type="range" class="slider"
                    data-criterion-id="${c.id}"
                    min="1" max="10" step="0.1">
                <span class="score">5.0</span>
            </div>`, "");
  }
  alarm() {
    this.nav.vibrate?.(1e3);
    this.doc.body.style.backgroundColor = "#ff0000";
    this.timerFn(() => {
      this.doc.body.style.backgroundColor = "";
    }, 500);
  }
  enableSubmit() {
    this.sliders.querySelectorAll("input").forEach((s) => {
      s.value = "5";
      s.nextElementSibling.textContent = "5.0";
    });
    this.submit.disabled = false;
    this.alert = this.timerFn(this.alarm.bind(this), 3e4);
  }
  submitScores() {
    if (!this.competition || this.position === void 0) return;
    this.submit.disabled = true;
    if (this.alert !== void 0) {
      this.clearTimerFn(this.alert);
      this.alert = void 0;
    }
    const scores = [];
    this.sliders.querySelectorAll("input").forEach((slider) => {
      scores.push({
        criteria_id: Number(slider.dataset.criterionId),
        score: Number(slider.value)
      });
    });
    const competitionId = this.competition.id;
    const competitorId = this.competition.competitors[this.position].id;
    this.setStatus("Submitting...");
    postResponse({
      tag: scoreTag(competitionId, competitorId, this.judge_id),
      payload: scores
    }).then(({ ok, status }) => {
      if (ok) {
        this.setStatus("Scores submitted");
      } else if (status === 401 || status === 403) {
        this.setStatus("Access denied - ask an administrator for a new link");
      } else if (status === 404) {
        this.setStatus("Too late - scoring for this competitor has closed");
      } else {
        this.setStatus("Submit failed - tap Submit to retry");
        this.submit.disabled = false;
      }
    });
  }
  destroy() {
    if (this.alert !== void 0) {
      this.clearTimerFn(this.alert);
      this.alert = void 0;
    }
  }
};

// app/frontend-src/main-jd.ts
await bootstrap("judge", (num, sse) => new JudgeClient(num, {
  sse
}));
